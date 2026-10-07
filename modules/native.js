const Cap = window.Capacitor;
export const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
const P = () => (window.Capacitor && window.Capacitor.Plugins) || {};

function toast(msg, type = 'info', ms = 3000) {
  if (typeof window.showToast === 'function') window.showToast(msg, type, ms);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function safeName(name) {
  return String(name || 'file').replace(/[^\w.\-() ]+/g, '_').slice(0, 80) || 'file';
}

async function writeCacheFile(name, blob) {
  const { Filesystem } = P();
  const path = `share/${Date.now().toString(36)}-${safeName(name)}`;
  const res = await Filesystem.writeFile({ path, data: await blobToBase64(blob), directory: 'CACHE', recursive: true });
  return res.uri;
}

export async function nativeShareFiles(files, { title, text } = {}) {
  const { Share } = P();
  const uris = [];
  for (const f of files) uris.push(await writeCacheFile(f.name, f));
  try {
    await Share.share({ title: title || undefined, text: text || undefined, files: uris, dialogTitle: title || 'Share' });
  } catch (e) {
    const msg = String((e && e.message) || e || '');
    if (/cancel/i.test(msg)) {
      const err = new Error('Share cancelled');
      err.name = 'AbortError';
      throw err;
    }
    throw e;
  }
}

function installShareBridge() {
  const canShare = (data) => !!(data && (data.files ? data.files.length > 0 : (data.text || data.url || data.title)));
  try {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data = {}) => {
        if (data.files && data.files.length) return nativeShareFiles(data.files, data);
        const { Share } = P();
        try {
          await Share.share({ title: data.title, text: data.text, url: data.url, dialogTitle: data.title || 'Share' });
        } catch (e) {
          if (/cancel/i.test(String((e && e.message) || e))) { const err = new Error('Share cancelled'); err.name = 'AbortError'; throw err; }
          throw e;
        }
      }
    });
  } catch (_) {}
}

const MIME_BY_EXT = { pdf: 'application/pdf', json: 'application/json', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', csv: 'text/csv', txt: 'text/plain', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip', db: 'application/octet-stream' };

function mimeFor(name, blob) {
  const ext = String(name).split('.').pop().toLowerCase();
  return (blob && blob.type) || MIME_BY_EXT[ext] || 'application/octet-stream';
}

function saveFilePlugin() {
  const C = window.Capacitor;
  if (!C) return null;
  if (C.Plugins && C.Plugins.SaveFile) return C.Plugins.SaveFile;
  return typeof C.registerPlugin === 'function' ? C.registerPlugin('SaveFile') : null;
}

export async function saveBlobToDevice(blob, name) {
  const mime = mimeFor(name, blob);
  const plugin = saveFilePlugin();
  if (plugin) {
    try {
      const res = await plugin.saveToDownloads({ filename: safeName(name), mime, data: await blobToBase64(blob) });
      toast(`Saved to ${res.path || 'Downloads'}`, 'success', 4500);
      if (typeof window.showGlassConfirm === 'function') {
        const open = await window.showGlassConfirm(`${safeName(name)}\nSaved in ${res.path || 'Downloads'}`, { title: 'File Saved', confirmText: 'Open', cancelText: 'Close' });
        if (open) {
          try { await plugin.openFile({ uri: res.uri, mime }); } catch (e) { toast('No app found to open this file. Find it in your Downloads folder.', 'info', 4500); }
        }
      }
      return true;
    } catch (e) {
      console.warn('[native] saveToDownloads failed, falling back to share sheet', e);
    }
  }
  try {
    await nativeShareFiles([new File([blob], safeName(name), { type: mime })], { title: name });
    return true;
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
    console.warn('[native] save failed', e);
    toast('Could not save the file: ' + ((e && e.message) || 'unknown error'), 'error', 5000);
    return false;
  }
}

async function saveAndShareBlob(blob, name) {
  await saveBlobToDevice(blob, name);
}

const _blobRegistry = new Map();
function installBlobRegistry() {
  const origCreate = URL.createObjectURL.bind(URL);
  const origRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const u = origCreate(obj);
    if (obj instanceof Blob) {
      _blobRegistry.set(u, obj);
      if (_blobRegistry.size > 30) _blobRegistry.delete(_blobRegistry.keys().next().value);
    }
    return u;
  };
  URL.revokeObjectURL = function (u) {
    setTimeout(() => _blobRegistry.delete(u), 120000);
    return origRevoke(u);
  };
}

function dataUrlToBlob(href) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(href);
  if (!m) return null;
  const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
}

function installDownloadBridge() {
  installBlobRegistry();
  const proto = HTMLAnchorElement.prototype;
  const origClick = proto.click;
  const origDispatch = proto.dispatchEvent;
  const intercept = (a) => {
    const href = a.href || '';
    if (!a.hasAttribute('download') || !(href.startsWith('blob:') || href.startsWith('data:'))) return false;
    const name = a.getAttribute('download') || 'download';
    let blob = href.startsWith('blob:') ? _blobRegistry.get(href) : dataUrlToBlob(href);
    if (blob) { saveAndShareBlob(blob, name); return true; }
    fetch(href).then(r => r.blob()).then(b => saveAndShareBlob(b, name)).catch(e => { console.warn('[native] download bridge', e); toast('Could not save the file.', 'error'); });
    return true;
  };
  proto.click = function () { if (intercept(this)) return; return origClick.apply(this, arguments); };
  proto.dispatchEvent = function (ev) {
    if (ev && ev.type === 'click' && intercept(this)) return true;
    return origDispatch.apply(this, arguments);
  };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (a && intercept(a)) e.preventDefault();
  }, true);
}

function installExternalLinks() {
  const open = (url) => {
    const { App } = P();
    if (App && typeof App.openUrl === 'function') return App.openUrl({ url }).catch(() => { window.location.href = url; });
    window.location.href = url;
  };
  window.open = function (url) {
    if (!url) return null;
    if (/^(https?:|tel:|mailto:|sms:|whatsapp:|geo:)/i.test(url)) open(url);
    return null;
  };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^(https?:\/\/|tel:|mailto:|sms:|whatsapp:)/i.test(href) && a.target === '_blank') { e.preventDefault(); open(a.href); }
  }, true);
}

function isVisible(el) {
  return !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
}

let lastBack = 0;
function handleBack() {
  const cam = document.getElementById('photo-capture-modal');
  if (cam && isVisible(cam) && typeof window.closePhotoCapture === 'function') { window.closePhotoCapture(); return; }
  const gc = document.querySelector('.glass-confirm-backdrop:not(.closing) .gc-cancel');
  if (gc) { gc.click(); return; }
  const lb = document.getElementById('photo-lightbox-modal');
  if (lb && isVisible(lb) && typeof window.closePhotoLightbox === 'function') { window.closePhotoLightbox(); return; }
  const banner = document.getElementById('edit-mode-banner');
  if (banner && typeof window.requestCancelEdit === 'function') {
    const openScreens = Array.from(document.querySelectorAll('.standalone-screen')).filter(isVisible);
    if (!openScreens.length) { window.requestCancelEdit(); return; }
  }
  const screens = Array.from(document.querySelectorAll('.standalone-screen')).filter(isVisible);
  if (screens.length) {
    const top = screens.sort((a, b) => (parseInt(getComputedStyle(b).zIndex) || 0) - (parseInt(getComputedStyle(a).zIndex) || 0))[0];
    if (typeof window.closeStandaloneScreen === 'function') { window.closeStandaloneScreen(top.id); return; }
  }
  const sidebar = document.querySelector('.sidebar.open, #sidebar.open, .side-menu.open');
  if (sidebar && typeof window.closeSidebar === 'function') { window.closeSidebar(); return; }
  const now = Date.now();
  if (now - lastBack < 2000) { const { App } = P(); if (App) App.exitApp(); return; }
  lastBack = now;
  toast('Press back again to exit', 'info', 1800);
}

function applyStatusBar() {
  const { StatusBar } = P();
  if (!StatusBar) return;
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  try {
    StatusBar.setStyle({ style: 'DARK' });
    StatusBar.setBackgroundColor({ color: '#1D4ED8' });
  } catch (_) {}
}

function geoErr(e) {
  const msg = String((e && e.message) || e || '');
  const denied = /denied|permission/i.test(msg);
  return { code: denied ? 1 : (/timeout|timed out/i.test(msg) ? 3 : 2), message: msg || 'Location unavailable', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

async function ensureLocationPermission() {
  const { Geolocation } = P();
  try {
    let st = await Geolocation.checkPermissions();
    if (st.location !== 'granted' && st.coarseLocation !== 'granted') st = await Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] });
    return st.location === 'granted' || st.coarseLocation === 'granted';
  } catch (_) { return false; }
}

function installGeolocationBridge() {
  const { Geolocation } = P();
  if (!Geolocation) return;
  const watches = new Map();
  let nextId = 1;
  const toPos = (p) => ({ coords: { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, altitude: p.coords.altitude, altitudeAccuracy: p.coords.altitudeAccuracy, heading: p.coords.heading, speed: p.coords.speed }, timestamp: p.timestamp });
  const shim = {
    getCurrentPosition(success, error, opts = {}) {
      ensureLocationPermission().then(ok => {
        if (!ok) { if (error) error(geoErr('Location permission denied')); return; }
        return Geolocation.getCurrentPosition({ enableHighAccuracy: opts.enableHighAccuracy !== false, timeout: opts.timeout || 20000, maximumAge: opts.maximumAge || 0 })
          .then(p => success(toPos(p)));
      }).catch(e => { if (error) error(geoErr(e)); });
    },
    watchPosition(success, error, opts = {}) {
      const id = nextId++;
      ensureLocationPermission().then(ok => {
        if (!ok) { if (error) error(geoErr('Location permission denied')); return; }
        return Geolocation.watchPosition({ enableHighAccuracy: opts.enableHighAccuracy !== false, timeout: opts.timeout || 30000, maximumAge: opts.maximumAge || 0 }, (pos, err) => {
          if (err) { if (error) error(geoErr(err)); return; }
          if (pos) success(toPos(pos));
        }).then(realId => { if (watches.has(id) && watches.get(id) === 'cancelled') Geolocation.clearWatch({ id: realId }); else watches.set(id, realId); });
      }).catch(e => { if (error) error(geoErr(e)); });
      watches.set(id, null);
      return id;
    },
    clearWatch(id) {
      const real = watches.get(id);
      if (real === null || real === undefined) { watches.set(id, 'cancelled'); return; }
      if (real !== 'cancelled') Geolocation.clearWatch({ id: real }).catch(() => {});
      watches.delete(id);
    }
  };
  try { Object.defineProperty(navigator, 'geolocation', { configurable: true, value: shim }); } catch (_) {}
}

async function requestStartupPermissions() {
  try {
    let asked = false;
    if (typeof window !== 'undefined' && window.sqliteStore && typeof window.sqliteStore.get === 'function') {
      const val = await window.sqliteStore.get('perm_asked_v2').catch(() => null);
      asked = val === '1' || val === 1;
    }
    if (!asked) {
      asked = localStorage.getItem('perm_asked_v2') === '1';
    }
    if (asked) return;
    if (typeof window !== 'undefined' && window.sqliteStore && typeof window.sqliteStore.set === 'function') {
      await window.sqliteStore.set('perm_asked_v2', '1').catch(() => {});
    }
    try { localStorage.setItem('perm_asked_v2', '1'); } catch (_) {}
  } catch (_) {}
  const { Camera } = P();
  try { if (Camera) await Camera.requestPermissions({ permissions: ['camera'] }); } catch (_) {}
  await ensureLocationPermission();
}

function installHaptics() {
  const { Haptics } = P();
  if (!Haptics) return;
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('.btn, .tbl-action-btn, .toggle-opt, .glass-confirm-btn') : null;
    if (t) { try { Haptics.impact({ style: 'LIGHT' }); } catch (_) {} }
  }, { passive: true });
}

async function unregisterServiceWorkers() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (_) {}
}

if (isNative) {
  document.documentElement.classList.add('is-native', 'is-android');
  installShareBridge();
  installDownloadBridge();
  installExternalLinks();
  installHaptics();
  installGeolocationBridge();
  setTimeout(requestStartupPermissions, 2500);
  unregisterServiceWorkers();
  const { App, SplashScreen } = P();
  if (App && typeof App.addListener === 'function') App.addListener('backButton', handleBack);
  applyStatusBar();
  new MutationObserver(applyStatusBar).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('load', () => { if (SplashScreen) setTimeout(() => SplashScreen.hide().catch(() => {}), 150); });
}

window.__isNativeApp = isNative;
window.nativeShareFiles = nativeShareFiles;
window.saveBlobToDevice = saveBlobToDevice;
