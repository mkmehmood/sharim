import './native.js';
import './notify.js';
import './constants.js';
import './business.js';
import './admin-data.js';
import './sync.js';
import './utilities-core.js';
import './utilities-sales.js';
import './prod-photos.js';
import './utilities-payments.js';
import './customers.js';
import './formula-store.js';

let _factoryLoad = null;
let _repLoad = null;

window._lazyLoadFactory = function (cb) {
  if (!_factoryLoad) _factoryLoad = import('./factory.js');
  _factoryLoad.then(() => cb && cb()).catch(() => cb && cb());
};
window._lazyLoadRep = function (cb) {
  if (!_repLoad) _repLoad = import('./rep-sales.js');
  _repLoad.then(() => cb && cb()).catch(() => cb && cb());
};

import './custom-date-picker.js';
