import NodeDriver from 'shared/mixins/node-driver';
import fetch from '@rancher/ember-api-store/utils/fetch';
const LAYOUT;

const OS_WHITELIST = ['centos_7', 'coreos_stable', 'ubuntu_14_04', 'ubuntu_16_04', 'ubuntu_18_04', 'rancher'];
const PLAN_BLACKLIST = ['baremetal_2a']; // quick wheres james spader?
const DEFAULTS = {
  os: 'ubuntu_16_04',
  billingCycle: 'hourly',
}
const defaultFacility = "ewr1";
const hash = Ember.RSVP.hash;
const on = Ember.on;
const get = Ember.get;
const setProperties = Ember.setProperties;
const computed = Ember.computed;
const observer = Ember.observer;
const set = Ember.set;
const alias = Ember.computed.alias;
const isEmpty = Ember.isEmpty;

export default Ember.Component.extend(NodeDriver, {
  driverName: 'metal',
  facilityChoices: null,
  planChoices: null,
  osChoices: null,
  step: 1,

  config: alias('model.metalConfig'),

  init() {
    const decodedLayout = window.atob(LAYOUT);
    const template = Ember.HTMLBars.compile(decodedLayout, {
      moduleName: 'nodes/components/driver-%%DRIVERNAME%%/template'
    });
    set(this, 'layout', template);
    this._super(...arguments);

    setProperties(this, {
      facilityChoices: [],
      planChoices: [],
      osChoices: [],
      allOS: [],
      deviceType: [{ name: "On Demand", value: "on-demand" }, { name: "Reserved", value: "reserved" }]
    });
  },

  actions: {
    authMetal(savedCB) {
      if (!this.validateAuthentication()) {
        savedCB(false);
        return;
      }

      let config = get(this, 'config');
      let promises = {
        plans: this.apiRequest('plans'),
        opSys: this.apiRequest('operating-systems'),
        facilities: this.apiRequest('facilities'),
      };

      let instanceType = get(this, 'config.hwReservationId')
      if (instanceType == "") {
        set(this, 'config.deviceType', 'on-demand')
      } else {
        set(this, 'config.deviceType', 'reserved')
      }

      hash(promises).then((hash) => {
        let osChoices = this.parseOSs(hash.opSys.operating_systems);
        let selectedPlans = this.parsePlans(osChoices.findBy('slug', 'ubuntu_16_04'), hash.plans.plans);

        setProperties(this, {
          allOS: osChoices,
          allPlans: hash.plans.plans,
          step: 2,
          facilityChoices: hash.facilities.facilities,
          osChoices,
          planChoices: selectedPlans,
        });

        setProperties(config, DEFAULTS);
        let facilityCode = get(this, 'config.facilityCode');
        if (!facilityCode) {
          set(this, 'config.facilityCode', defaultFacility)
        }
        savedCB(true);
      }, (err) => {
        let errors = get(this, 'errors') || [];
        errors.push(`${err.statusText}: ${err.body.message}`);

        set(this, 'errors', errors);
        savedCB(false);
      });
    },

    instanceTypeSelected(type) {
      let config = get(this, 'config');
      switch (type) {
        case "on-demand":
          this.getOnDemandPlans()
          break;
        case "reserved":
          this.getReserverdHardwarePlans()
          break;
        default:
          this.getOnDemandPlans()
      }


    },
  },
  planChoiceDetails: computed('config.plan', function () {
    let planSlug = get(this, 'config.plan');
    let plan = get(this, 'allPlans').findBy('slug', planSlug);

    return plan;
  }),

  osObserver: on('init', observer('config.os', function () {
    this.notifyPropertyChange('config.facility');
  })),

  facilityObserver: on('init', observer('config.facilityCode', function () {
    let facilities = get(this, 'facilityChoices');
    let slug = get(this, 'config.facilityCode');
    let facility = facilities.findBy('code', slug);
    set(this, 'config.facilityCode', slug)
    let out = [];
    let allPlans = get(this, 'allPlans');
    if (allPlans && facility) {
      allPlans.forEach((plan) => {
        plan.available_in.forEach((fac) => {
          let facId = fac.href.split('/')[fac.href.split('/').length - 1];

          if (facility.id === facId) {
            out.push(plan);
          }
        })
      });
      let currentOS = get(this, 'config.os');
      let osChoices = get(this, 'osChoices');
      let filteredByOs = this.parsePlans(osChoices.findBy('slug', currentOS), out);
      set(this, 'planChoices', filteredByOs);

      if (filteredByOs.length > 0)
        set(this, 'config.plan', filteredByOs[0].slug)
      else if (filteredByOs.length == 0) {
        set(this, 'config.plan', "")
      }
      //always set to baremetal_0 when available
      for (var i = 0; i < filteredByOs.length; i++) {
        if (filteredByOs[i].slug == 'baremetal_0') {
          set(this, 'config.plan', filteredByOs[i].slug)
          break;
        }
      }
    }
  })),

  bootstrap() {
    let store = get(this, 'globalStore');
    let config = store.createRecord({
      type: 'metalConfig',
      projectId: '',
      apiKey: '',
      hwReservationId: '',
      deviceType: 'on-demand',
    });

    const model = get(this, 'model');

    set(model, 'metalConfig', config);
  },

  apiRequest(command, opt, out) {
    opt = opt || {};

    let url = `${get(this, 'app.proxyEndpoint')}/`;

    if (opt.url) {
      url += opt.url.replace(/^http[s]?\/\//, '');
    } else {
      url += `${'api.equinix.com/metal/v1'}/${command}`;
    }

    return fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Auth-Token': get(this, 'config.apiKey'),
      },
    }).then((res) => {
      let body = res.body;

      if (out) {
        out[command].pushObjects(body[command]);
      } else {
        out = body;
      }

      // De-paging
      if (body && body.links && body.links.pages && body.links.pages.next) {
        opt.url = body.links.pages.next;

        return this.apiRequest(command, opt, out).then(() => {
          return out;
        });
      } else {
        return out;
      }
    });
  },

  getReserverdHardwarePlans() {
    let config = get(this, 'config');
    setProperties(config, {
      deviceType: 'reserved',
      hwReservationId: 'next-available',
    })
    this.notifyPropertyChange('config.facilityCode');
  },

  getOnDemandPlans() {
    let config = get(this, 'config');
    setProperties(config, {
      deviceType: 'on-demand',
      hwReservationId: '',
    })
    console.log(config.hwReservationId)
    this.notifyPropertyChange('config.facilityCode');
  },

  parseOSs(osList) {
    return osList.filter((os) => {
      if (OS_WHITELIST.includes(os.slug) && !isEmpty(os.provisionable_on)) {
        return os;
      }
    });
  },

  parsePlans(os, plans) {
    let out = [];

    os.provisionable_on.forEach((loc) => {
      let plan = plans.findBy('slug', loc);

      if (plan && !PLAN_BLACKLIST.includes(loc) && !out.includes(plan)) {
        out.push(plan);
      }
    });

    return out;
  },

  validate() {
    let errors = get(this, 'model').validationErrors();

    if (!get(this, 'config.projectId')) {
      errors.push('Project ID is required');
    }

    if (!get(this, 'config.apiKey')) {
      errors.push('API Key is requried');
    }

    if (!get(this, 'config.plan') || get(this, 'config.plan') == "") {
      errors.push('Plan is requried');
    }

    if (errors.length) {
      set(this, 'errors', errors.uniq());

      return false;
    }

    return true;
  },

  validateAuthentication() {
    let errors = get(this, 'model').validationErrors();

    if (!get(this, 'config.projectId')) {
      errors.push('Project ID is required');
    }

    if (!get(this, 'config.apiKey')) {
      errors.push('API Key is requried');
    }

    if (errors.length) {
      set(this, 'errors', errors.uniq());

      return false;
    }

    return true;
  },
});
