import { esc, fmtAmt, fmtNum, sqliteStore, ensureArray } from './business.js';

const getStoreLabel = (s) => (typeof window.getStoreLabel === 'function' ? window.getStoreLabel(s) : s);

const MAX_PHOTOS = 6;
const _thumbCache = new Map();
let _picker = [];
const _selected = new Set();

function _toast(msg, type = 'info', ms = 3000) {
  if (window.showToast) window.showToast(msg, type, ms);
}

function _readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function _compress(dataUrl, maxDim = 1280, quality = 0.75) {
  if (typeof window._compressPhoto === 'function') return window._compressPhoto(dataUrl, maxDim, quality);
  return dataUrl;
}

async function _photoStore() {
  const stored = await sqliteStore.get('person_photos');
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

async function _writePhotoKeys(setMap, deleteKeys) {
  const photos = await _photoStore();
  const ts = (await sqliteStore.get('person_photos_timestamps')) || {};
  const dirty = (await sqliteStore.get('person_photos_dirty_keys')) || [];
  const now = Date.now();
  for (const [k, v] of Object.entries(setMap)) {
    photos[k] = v;
    ts[k] = now;
    if (!dirty.includes(k)) dirty.push(k);
    _thumbCache.set(k, v);
  }
  for (const k of deleteKeys) {
    delete photos[k];
    delete ts[k];
    if (!dirty.includes(k)) dirty.push(k);
    _thumbCache.delete(k);
  }
  await sqliteStore.set('person_photos', photos);
  await sqliteStore.set('person_photos_timestamps', ts);
  await sqliteStore.set('person_photos_dirty_keys', dirty);
  await sqliteStore.set('person_photos_timestamp', now);
  if (typeof window.triggerAutoSync === 'function') { try { window.triggerAutoSync(); } catch (_) {} }
}

function _renderPicker() {
  const dot = document.getElementById('prod-photo-dot');
  const btn = document.getElementById('prod-photo-btn');
  const clr = document.getElementById('prod-photo-clear');
  const n = _picker.length;
  if (dot) { dot.style.display = n ? '' : 'none'; dot.textContent = n > 1 ? String(n) : ''; dot.classList.toggle('pp-dot-count', n > 1); }
  if (btn) {
    btn.style.borderColor = n ? 'var(--accent)' : 'var(--glass-border)';
    btn.title = n ? `${n} photo${n === 1 ? '' : 's'} attached — tap to add another` : 'Attach photo';
  }
  if (clr) clr.style.display = n ? '' : 'none';

  const tray = document.getElementById('prod-photo-preview-tray');
  const countEl = document.getElementById('prod-photo-count');
  const thumbsEl = document.getElementById('prod-photo-thumbs');
  if (countEl) countEl.textContent = String(n);
  if (tray) tray.style.display = n > 0 ? 'block' : 'none';
  if (thumbsEl) {
    if (n === 0) {
      thumbsEl.innerHTML = '';
    } else {
      let html = '';
      _picker.forEach((p, i) => {
        const safeUrl = esc(p.dataUrl);
        html += `
          <div class="pp-thumb-card" title="Photo ${i + 1} of ${n} — tap to view full size">
            <span class="pp-thumb-badge">${i + 1}</span>
            <img src="${safeUrl}" alt="Attached photo ${i + 1}" onclick="if (typeof openPhotoLightbox === 'function') openPhotoLightbox('${safeUrl}')">
            <button type="button" class="pp-thumb-remove" onclick="removeProdPhoto(${i})" title="Remove photo ${i + 1}" aria-label="Remove photo ${i + 1}">&times;</button>
          </div>
        `;
      });
      if (n < MAX_PHOTOS) {
        html += `
          <button type="button" class="pp-thumb-add" onclick="openProdPhotoCapture()" title="Add another photo (${MAX_PHOTOS - n} remaining)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            <span>Add</span>
          </button>
        `;
      }
      thumbsEl.innerHTML = html;
    }
  }
}

export function getProdPickerCount() {
  return _picker.length;
}
window._getProdPickerCount = getProdPickerCount;

export function clearProdPhotos() {
  _picker = [];
  _renderPicker();
  _toast('Photos removed from this entry', 'info', 1800);
}

export async function addProdPhotos(fileList) {
  const files = Array.from(fileList || []).filter(f => f && /^image\//.test(f.type));
  if (!files.length) return;
  const room = MAX_PHOTOS - _picker.length;
  if (room <= 0) { _toast(`You can attach up to ${MAX_PHOTOS} photos per entry.`, 'warning'); return; }
  const use = files.slice(0, room);
  if (files.length > room) _toast(`Only ${room} more photo${room === 1 ? '' : 's'} allowed — extra files skipped.`, 'warning');
  for (const f of use) {
    try {
      const raw = await _readFile(f);
      const small = await _compress(raw, 1400, 0.82);
      _picker.push({ key: null, dataUrl: small, isNew: true });
    } catch (e) {
      console.warn('[prod photo] read failed', e);
    }
  }
  _renderPicker();
}

export async function addProdPhotoDataUrl(dataUrl) {
  if (_picker.length >= MAX_PHOTOS) { _toast(`You can attach up to ${MAX_PHOTOS} photos per entry.`, 'warning'); return; }
  const small = await _compress(dataUrl, 1280, 0.75);
  _picker.push({ key: null, dataUrl: small, isNew: true });
  _renderPicker();
}

export function openProdPhotoCapture() {
  if (_picker.length >= MAX_PHOTOS) { _toast(`You can attach up to ${MAX_PHOTOS} photos per entry.`, 'warning'); return; }
  if (typeof window.openPhotoCapture === 'function') window.openPhotoCapture('prod');
}

export function removeProdPhoto(i) {
  _picker.splice(i, 1);
  _renderPicker();
}

export function resetProdPhotos() {
  _picker = [];
  _renderPicker();
}

export async function loadProdPhotosForEdit(rec) {
  _picker = [];
  const keys = Array.isArray(rec && rec.photoKeys) ? rec.photoKeys : [];
  const photos = await _photoStore();
  keys.forEach(k => { if (photos[k]) _picker.push({ key: k, dataUrl: photos[k], isNew: false }); });
  _renderPicker();
}

export function getProdPhotoKeys(prodId) {
  const keep = [];
  const stamp = Date.now();
  _picker.forEach((p, i) => {
    if (!p.key) p.key = `prod:${prodId}:${stamp.toString(36)}${i}`;
    keep.push(p.key);
  });
  return keep;
}

export async function persistProdPhotos(prodId, previousKeys = []) {
  const setMap = {};
  _picker.forEach(p => { if (p.isNew && p.key) setMap[p.key] = p.dataUrl; });
  const keepSet = new Set(_picker.map(p => p.key));
  const del = (previousKeys || []).filter(k => !keepSet.has(k));
  if (Object.keys(setMap).length || del.length) await _writePhotoKeys(setMap, del);
  resetProdPhotos();
}

export async function deleteProdPhotos(rec) {
  const keys = Array.isArray(rec && rec.photoKeys) ? rec.photoKeys : [];
  if (keys.length) await _writePhotoKeys({}, keys);
}

const VIEW_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
const LONG_PRESS_MS = 550;
const BOX_SVG = '<svg class="pp-box-ring" viewBox="0 0 24 24" aria-hidden="true"><rect class="pp-box-track" x="2.5" y="2.5" width="19" height="19" rx="6"/><rect class="pp-box-fill" x="2.5" y="2.5" width="19" height="19" rx="6" pathLength="100"/><path class="pp-box-check" d="M7 12.5l3.5 3.5 6.5-7.5" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export async function toggleProdPhotoPanel(btn, id, singleKey) {
  if (singleKey) { await openProdPhoto(singleKey); return; }
  const panel = document.getElementById('pp-panel-' + id);
  if (!panel) return;
  const isHidden = panel.style.display === 'none' || !panel.style.display;
  panel.style.display = isHidden ? 'flex' : 'none';
  if (isHidden) hydrateProdPhotoThumbs(panel);
}

export function prodPhotoStripHtml(item) {
  const keys = Array.isArray(item.photoKeys) ? item.photoKeys : [];
  if (!keys.length || item.isReturn || item.isTransfer) return '';
  const id = String(item.id).replace(/[^a-z0-9_-]/gi, '');
  const thumbs = keys.map(k => `<img class="pp-strip-img" data-photo-key="${esc(k)}" alt="Product photo" onclick="openProdPhoto('${esc(k)}')">`).join('');
  const checked = _selected.has(item.id);
  return `
    <div class="pp-actions">
      <button type="button" class="pp-badge" title="View photos" onclick="toggleProdPhotoPanel(this,'${id}'${keys.length === 1 ? `,'${esc(keys[0])}'` : ''})">${VIEW_SVG}Photo${keys.length > 1 ? ' \u00d7' + keys.length : ''}</button>
      <button type="button" class="pp-box${checked ? ' on' : ''}" data-pp-box="${esc(item.id)}" aria-pressed="${checked ? 'true' : 'false'}" title="Tap to select \u2022 hold to share" aria-label="Select or share">${BOX_SVG}</button>
    </div>
    <div class="pp-strip" id="pp-panel-${id}" style="display:none;">${thumbs}</div>
  `;
}

export async function hydrateProdPhotoThumbs(root = document) {
  const imgs = Array.from(root.querySelectorAll('img[data-photo-key]:not([src])'));
  if (!imgs.length) return;
  const photos = await _photoStore();
  imgs.forEach(img => {
    const k = img.getAttribute('data-photo-key');
    const v = _thumbCache.get(k) || photos[k];
    if (v) { img.src = v; _thumbCache.set(k, v); } else { img.classList.add('pp-missing'); }
  });
}

export async function openProdPhoto(key) {
  const photos = await _photoStore();
  const v = photos[key];
  if (v && typeof window.openPhotoLightbox === 'function') window.openPhotoLightbox(v);
}

async function _updateShareBar() {
  let bar = document.getElementById('pp-sharebar');
  if (_selected.size === 0) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pp-sharebar';
    bar.className = 'pp-sharebar';
    document.body.appendChild(bar);
  }
  let photoCount = 0;
  try {
    const db = ensureArray(await sqliteStore.get('mfg_pro_pkr'));
    for (const id of _selected) {
      const r = db.find(x => x && x.id === id);
      if (r && Array.isArray(r.photoKeys)) photoCount += r.photoKeys.length;
    }
  } catch (_) {}
  const WA_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block;vertical-align:-2px;margin-right:5px;"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 6.46 17.5 2 12.04 2M12.05 20.15C10.57 20.15 9.12 19.76 7.85 19L7.55 18.82L4.43 19.64L5.26 16.6L5.06 16.29C4.24 14.99 3.81 13.47 3.81 11.91C3.81 7.37 7.5 3.69 12.04 3.69C16.58 3.69 20.27 7.37 20.27 11.91C20.27 16.46 16.59 20.15 12.05 20.15M16.57 14.34C16.32 14.21 15.1 13.61 14.87 13.53C14.65 13.44 14.48 13.4 14.32 13.65C14.15 13.9 13.67 14.47 13.52 14.64C13.38 14.8 13.23 14.82 12.98 14.7C12.73 14.57 11.93 14.31 10.98 13.47C10.25 12.81 9.75 12 9.61 11.75C9.46 11.5 9.59 11.37 9.72 11.24C9.83 11.13 9.97 10.95 10.1 10.8C10.22 10.65 10.27 10.55 10.35 10.38C10.43 10.22 10.39 10.07 10.33 9.95C10.27 9.82 9.78 8.62 9.58 8.13C9.38 7.65 9.18 7.72 9.03 7.71C8.89 7.7 8.72 7.7 8.56 7.7C8.39 7.7 8.12 7.76 7.89 8.01C7.66 8.26 7.02 8.86 7.02 10.08C7.02 11.3 7.91 12.47 8.03 12.64C8.16 12.8 9.78 15.31 12.26 16.38C12.85 16.64 13.31 16.79 13.67 16.91C14.26 17.09 14.8 17.07 15.23 17C15.71 16.93 16.7 16.4 16.91 15.82C17.11 15.25 17.11 14.76 17.05 14.65C16.99 14.54 16.82 14.47 16.57 14.34Z"/></svg>';
  const countText = photoCount > 0 ? `<b>${photoCount}</b> photo${photoCount === 1 ? '' : 's'} (${_selected.size} entr${_selected.size === 1 ? 'y' : 'ies'})` : `<b>${_selected.size}</b> entr${_selected.size === 1 ? 'y' : 'ies'}`;
  bar.innerHTML = `<span>${countText} selected</span><div><button type="button" class="pp-bar-clear" onclick="clearProdPhotoSelection()">Clear</button><button type="button" class="pp-bar-share" onclick="shareProdPhotos()">${WA_ICON}Share on WhatsApp</button></div>`;
}

export function toggleProdPhotoSelect(id, on) {
  if (on) _selected.add(id); else _selected.delete(id);
  document.querySelectorAll('[data-pp-box]').forEach(b => {
    if (b.getAttribute('data-pp-box') === id) { b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  });
  _updateShareBar();
}

let _hold = null;
function _endHold(box, fired) {
  if (!_hold) return;
  clearTimeout(_hold.timer);
  const h = _hold;
  _hold = null;
  h.box.classList.remove('holding');
  if (!fired && h.box === box && !h.fired) toggleProdPhotoSelect(h.id, !_selected.has(h.id));
}

function _installBoxGestures() {
  if (window.__ppBoxGestures) return;
  window.__ppBoxGestures = true;
  document.addEventListener('pointerdown', (e) => {
    const box = e.target.closest && e.target.closest('[data-pp-box]');
    if (!box || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const id = box.getAttribute('data-pp-box');
    box.classList.add('holding');
    _hold = { id, box, fired: false, timer: setTimeout(() => {
      if (!_hold) return;
      _hold.fired = true;
      box.classList.remove('holding');
      try { if (navigator.vibrate) navigator.vibrate(40); } catch (_) {}
      try { const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics; if (H) H.impact({ style: 'MEDIUM' }); } catch (_) {}
      shareProdPhotos([id]);
    }, LONG_PRESS_MS) };
  });
  const up = (e) => {
    if (!_hold) return;
    const box = e.target.closest ? e.target.closest('[data-pp-box]') : null;
    const fired = _hold.fired;
    _endHold(fired ? _hold.box : box, fired);
  };
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', () => { if (_hold) { clearTimeout(_hold.timer); _hold.box.classList.remove('holding'); _hold = null; } });
  document.addEventListener('contextmenu', (e) => { if (e.target.closest && e.target.closest('[data-pp-box]')) e.preventDefault(); });
}
_installBoxGestures();

export function clearProdPhotoSelection() {
  _selected.clear();
  document.querySelectorAll('[data-pp-box]').forEach(b => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
  _updateShareBar();
}

function _wrapText(ctx, text, maxWidth) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxWidth && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

async function _captionedBlob(dataUrl, captionLines) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const W = Math.min(1280, img.width);
  const H = Math.round(img.height * (W / img.width));
  const pad = Math.round(W * 0.03);
  const fs = Math.max(20, Math.round(W * 0.034));
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `600 ${fs}px sans-serif`;
  const lines = captionLines.flatMap(l => _wrapText(measure, l, W - pad * 2));
  const bandH = pad * 2 + lines.length * Math.round(fs * 1.3);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H + bandH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, H, W, bandH);
  ctx.fillStyle = '#f8fafc';
  ctx.font = `600 ${fs}px sans-serif`;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => {
    if (i > 0) ctx.font = `500 ${Math.round(fs * 0.9)}px sans-serif`;
    ctx.fillText(l, pad, H + pad + i * Math.round(fs * 1.3));
  });
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
}

export async function copyBlobToClipboard(blob) {
  try {
    if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') return false;
    let pngBlob = blob;
    if (blob.type !== 'image/png') {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = URL.createObjectURL(blob);
      });
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      pngBlob = await new Promise(r => c.toBlob(r, 'image/png'));
    }
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': pngBlob })
    ]);
    return true;
  } catch (e) {
    console.warn('[clipboard] copy image failed', e);
    return false;
  }
}
window._copyBlobToClipboard = copyBlobToClipboard;

export async function shareProdPhotos(ids) {
  const wanted = (ids && ids.length ? ids : Array.from(_selected));
  if (!wanted.length) { _toast('Select at least one entry with photos.', 'warning'); return; }
  _toast('Preparing photos with details…', 'info', 1500);
  const db = ensureArray(await sqliteStore.get('mfg_pro_pkr'));
  const photos = await _photoStore();
  const files = [];
  const textLines = [];
  for (const id of wanted) {
    const rec = db.find(r => r && r.id === id);
    if (!rec) continue;
    const keys = (rec.photoKeys || []).filter(k => photos[k]);
    if (!keys.length) continue;
    const store = getStoreLabel(rec.store) || rec.store || '';
    const capLines = [
      `Date: ${rec.date || ''}`,
      `Gross Weight: ${fmtNum(rec.grossWt || 0)} kg`,
      `Container: ${fmtNum(rec.contWt || 0)} kg`,
      `Net Weight: ${fmtNum(rec.net || 0)} kg`,
      `Total Value: ${fmtAmt(rec.totalSale || 0)}`
    ];
    textLines.push(capLines.join('\n'));
    for (let i = 0; i < keys.length; i++) {
      try {
        const blob = await _captionedBlob(photos[keys[i]], capLines);
        files.push(new File([blob], `production-${rec.date || 'entry'}-${store.replace(/\W+/g, '')}-${files.length + 1}.jpg`, { type: 'image/jpeg' }));
      } catch (e) { console.warn('[prod photo] caption failed', e); }
    }
  }
  if (!files.length) { _toast('No photos found for the selected entries.', 'warning'); return; }
  const text = textLines.join('\n\n');
  const plural = files.length === 1 ? '' : 's';
  const isAbort = (err) => !!err && (err.name === 'AbortError' || /cancel/i.test(String(err.message || err)));

  // Always copy formatted text summary to clipboard so details are never lost
  try { await navigator.clipboard.writeText(text); } catch (_) {}

  // CRITICAL: When sharing to WhatsApp, sharing files WITHOUT text ensures WhatsApp
  // attaches all the pictures! (Passing text causes WhatsApp to drop the images).
  const isCapNative = typeof window.nativeShareFiles === 'function' && window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform();
  const canWebShare = typeof navigator.canShare === 'function' && navigator.canShare({ files });

  if (isCapNative || canWebShare) {
    try {
      if (isCapNative) {
        await window.nativeShareFiles(files, { title: 'Production Photos' });
      } else {
        await navigator.share({ files, title: 'Production Photos' });
      }
      _toast(`Shared ${files.length} photo${plural} to WhatsApp! (Details copied to clipboard)`, 'success', 4000);
      clearProdPhotoSelection();
      return;
    } catch (err) {
      if (isAbort(err)) { _toast('Share cancelled', 'info'); return; }
      console.warn('[prod photo] share failed, proceeding to fallback:', err);
    }
  }

  // Fallback for Desktop/Web where file Web Share isn't supported:
  // Copy the first captioned picture directly to system clipboard so user can Ctrl+V into WhatsApp Web!
  let copiedImage = false;
  try {
    copiedImage = await copyBlobToClipboard(files[0]);
  } catch (_) {}

  // Auto-download all captioned photos so the user has the high-res files
  files.forEach((f, i) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    setTimeout(() => { a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }, i * 250);
  });

  if (copiedImage) {
    _toast(`Picture copied to clipboard & downloaded! Opening WhatsApp \u2014 press Ctrl+V to paste picture into chat.`, 'success', 6000);
  } else {
    _toast(`Saved ${files.length} photo${plural}. Opening WhatsApp\u2026`, 'info', 4000);
  }

  setTimeout(() => window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank'), 700);
  clearProdPhotoSelection();
}

Object.assign(window, {
  addProdPhotos, clearProdPhotos, addProdPhotoDataUrl, openProdPhotoCapture, toggleProdPhotoPanel, removeProdPhoto, openProdPhoto, toggleProdPhotoSelect, clearProdPhotoSelection, shareProdPhotos, resetProdPhotos, getProdPickerCount, copyBlobToClipboard
});
