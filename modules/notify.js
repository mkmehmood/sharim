const _plugins = () => (window.Capacitor && window.Capacitor.Plugins) || {};
const _isNative = () => !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
let _nativeGranted = null;
let _lastKey = '';
let _lastAt = 0;
let _seq = Date.now() % 1000000000;
async function _ensureNativePermission(LocalNotifications) {
  if (_nativeGranted !== null) return _nativeGranted;
  try {
    let status = await LocalNotifications.checkPermissions();
    if (status.display === 'prompt' || status.display === 'prompt-with-rationale') status = await LocalNotifications.requestPermissions();
    _nativeGranted = status.display === 'granted';
  } catch (_) {
    _nativeGranted = false;
  }
  return _nativeGranted;
}
async function _ensureWebPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch (_) { return false; }
}
async function _showWeb(title, body, tag) {
  if (!(await _ensureWebPermission())) return;
  const options = { body, tag, icon: '192.png', badge: '192.png', renotify: true };
  try {
    const reg = navigator.serviceWorker && navigator.serviceWorker.getRegistration ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.showNotification) { await reg.showNotification(title, options); return; }
  } catch (_) {}
  try { new Notification(title, options); } catch (_) {}
}
async function _showNative(title, body) {
  const { LocalNotifications } = _plugins();
  if (!LocalNotifications) return;
  if (!(await _ensureNativePermission(LocalNotifications))) return;
  _seq = (_seq + 1) % 2147483000;
  try { await LocalNotifications.schedule({ notifications: [{ id: _seq, title, body, schedule: { at: new Date(Date.now() + 250) } }] }); } catch (_) {}
}
const _recent = new Map();
let _lastExplicitAt = 0;
let _pendingMirrors = [];
function _isDuplicate(title, text, tag) {
  const now = Date.now();
  for (const [k, t] of _recent) if (now - t > 15000) _recent.delete(k);
  const key = title + '|' + text;
  const tagKey = tag && !/^toast-/.test(tag) && tag !== 'app-toast' ? 'tag:' + tag : '';
  if (_recent.has(key) || (tagKey && _recent.has(tagKey))) return true;
  _recent.set(key, now);
  if (tagKey) _recent.set(tagKey, now);
  return false;
}
export async function sendDeviceNotification(title, body, tag, opts) {
  const text = String(body == null ? '' : body).replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
  if (!text) return;
  const fromToast = !!(opts && opts.fromToast);
  if (!fromToast) {
    _lastExplicitAt = Date.now();
    _pendingMirrors.forEach(clearTimeout);
    _pendingMirrors = [];
  }
  if (_isDuplicate(title, text, tag)) return;
  if (_isNative()) await _showNative(title, text);
  else await _showWeb(title, text, tag || 'app-toast');
}
export function primeNotificationPermission() {
  if (_isNative()) {
    const { LocalNotifications } = _plugins();
    if (LocalNotifications) _ensureNativePermission(LocalNotifications);
    return;
  }
  if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => { _ensureWebPermission(); }, { once: true });
  }
}
window.sendDeviceNotification = sendDeviceNotification;

const _bootAt = Date.now();
const _STARTUP_QUIET_MS = 25000;
const _BURST_MAX = 4;
const _BURST_WINDOW_MS = 30000;
let _burst = [];
const _NOISE_RE = new RegExp([
  '^\\s*(please|enter|select|choose|add at least|no .* (selected|found|data)|nothing)',
  '\\b(is|are) required\\b',
  '\\bcannot be (edited|deleted|toggled|negative)\\b',
  '\\b(invalid|valid) (date|amount|quantity|name|number|phone|input)\\b',
  '^\\s*access denied',
  'not logged in|please sign in',
  'cancel(l)?ed',
  'welcome',
  'loading|syncing|sync (started|complete)|preparing|generating|opening|checking|connecting',
  'shared|copied|downloaded|uploaded|exported|saved to|saved as|pdf|image',
  'back online|you are offline|offline mode|connection restored',
  'refreshed|updated successfully!?$',
  'deleted successfully|all records deleted|permanently deleted|recovered|restore complete|^(transferred|transfer updated)\\b'
].join('|'), 'i');
const _FALLBACK = {
  success: { title: 'All done', hint: '' },
  warning: { title: 'Please check this', hint: ' Open the app to take a look.' },
  error: { title: 'Something did not work', hint: ' Open the app and try again.' }
};
const _EXPLAIN = [
  [/failed to save (production|data locally|data)/i, () => ['Could not save your data', 'The latest entry was NOT saved on this phone. Open the app, check the entry and save it again.']],
  [/failed to save (transaction|expense)/i, (m) => ['Could not save the ' + m[1].toLowerCase(), 'The ' + m[1].toLowerCase() + ' was NOT saved. Open the app, check the details and try again.']],
  [/failed to (delete|remove) (.+?)[.!]?( please.*)?$/i, (m) => ['Could not delete ' + m[2].replace(/\.$/, ''), 'Nothing was deleted. Open the app and try again.']],
  [/failed to update (.+?)[.!]?( please.*)?$/i, (m) => ['Could not update ' + m[1].replace(/\.$/, ''), 'The change was not applied. Open the app and try again.']],
  [/insufficient cash in hand\.?\s*available:\s*(.+?)\s*[\u2014-]\s*(?:extra )?required(?: \(net\))?:\s*(.+)$/i, (m) => ['Not enough cash in hand', 'Only ' + m[1] + ' is available but ' + m[2] + ' is needed. Add cash or lower the amount, then try again.']],
  [/cannot delete:\s*(.+)/i, (m) => ['Batch cannot be deleted', m[1].replace(/\.$/, '') + '.']],
  [/storage nearly full \(([\d.,]+) MB free\)/i, (m) => ['Phone storage almost full', 'Only ' + m[1] + ' MB of space is left. Create a backup and free some space, otherwise new data may not save.']],
  [/approaching the browser'?s local storage limit/i, (m, t) => ['Local storage almost full', t]],
  [/saved locally.*sync will retry/i, () => ['Saved on this phone only', 'There is no internet right now. Your change is safe on this phone and will be sent to the cloud by itself when you are back online.']],
  [/transaction saved!\s*(\d+) sales entries reconciled/i, (m) => ['Payment saved', 'The payment was recorded and ' + m[1] + ' related sales ' + (m[1] === '1' ? 'entry was' : 'entries were') + ' marked as settled.']],
  [/material saved successfully/i, () => ['Raw material saved', 'Raw material inventory was updated with the new stock and cost.']],
  [/^(.+?) added as user$/i, (m) => ['New user added', m[1] + ' was added as a user.']],
  [/^(.+?) added$/i, (m) => ['New entry added', m[1] + ' was added successfully.']],
  [/emptied recycle bin with (\d+) error/i, (m) => ['Recycle bin partly emptied', m[1] + ' record' + (m[1] === '1' ? '' : 's') + ' could not be removed. Open the recycle bin to review.']],
  [/location confirmed for (.+?) after/i, (m) => ['Customer location confirmed', m[1] + '\u2019s location was saved after 3 consistent visits.']],
  [/unlinked from (.+)/i, (m) => ['Supplier unlinked', 'The material is no longer linked to ' + m[1] + '.']],
  [/linked to (.+)/i, (m) => ['Supplier linked', 'The material is now linked to ' + m[1] + '.']],
  [/remote command sent:\s*(.+)/i, (m) => ['Command sent', 'A request to switch to ' + m[1] + ' was sent to the device.']],
  [/encryption failed/i, () => ['Encryption failed', 'Your data could not be encrypted, so nothing was exported. Open the app and try again.']],
  [/error generating pdf/i, () => ['PDF could not be created', 'The statement was not generated. Open the app and try again.']],
  [/address lookup failed/i, () => ['Address lookup failed', 'The street address could not be found, so GPS coordinates were saved instead.']],
  [/unexpected error/i, () => ['Something went wrong', 'The app ran into a problem. Close and reopen it. If it keeps happening, make a backup of your data.']],
  [/(rep sales|customer data) operation failed/i, (m) => ['Action did not complete', 'The last ' + m[1].toLowerCase() + ' action failed. Open the app, check the entry and try again.']],
  [/table failed to render|calculation failed/i, () => ['A screen failed to load', 'One screen could not be shown. Close and reopen the app to fix it.']],
  [/invalid transaction id/i, () => ['Transaction not found', 'This transaction could not be found. It may have been deleted on another device.']]
];
function _explainToast(text, type) {
  for (const [re, fn] of _EXPLAIN) {
    const m = re.exec(text);
    if (m) { try { const out = fn(m, text); if (out) return { title: out[0], body: out[1] }; } catch (_) {} }
  }
  const f = _FALLBACK[type] || _FALLBACK.warning;
  const body = /[.!?]$/.test(text) ? text : text + '.';
  return { title: f.title, body: body + f.hint };
}

function _cleanToastText(message) {
  let t = String(message == null ? '' : message).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^[^\p{L}\p{N}"'(]+/u, '').trim();
  return t.length > 180 ? t.slice(0, 177) + '\u2026' : t;
}

export function notifyFromToast(message, type) {
  try {
    if (type !== 'success' && type !== 'warning' && type !== 'error') return;
    if (Date.now() - _bootAt < _STARTUP_QUIET_MS) return;
    const text = _cleanToastText(message);
    if (!text || text.length < 6) return;
    if (type !== 'error' && _NOISE_RE.test(text)) return;
    if (type === 'error' && /^\s*(please|enter|select)|\b(is|are) required\b|not logged in/i.test(text)) return;
    const now = Date.now();
    _burst = _burst.filter(ts => now - ts < _BURST_WINDOW_MS);
    if (_burst.length >= _BURST_MAX) return;
    _burst.push(now);
    const note = _explainToast(text, type);
    const timer = setTimeout(() => {
      _pendingMirrors = _pendingMirrors.filter((t) => t !== timer);
      if (type !== 'error' && Date.now() - _lastExplicitAt < 6000) return;
      sendDeviceNotification(note.title, note.body, 'toast-' + type, { fromToast: true }).catch(() => {});
    }, 1200);
    _pendingMirrors.push(timer);
  } catch (_) {}
}
window.notifyFromToast = notifyFromToast;
primeNotificationPermission();
