import { ensureArray, esc, generateUUID, getTimestamp, sqliteStore } from './business.js';
import { showGlassConfirm, showToast } from './customers.js';
import { sendDeviceNotification } from './notify.js';
import { notifyDataChange, triggerAutoSync } from './utilities-core.js';
import { resolveSelectedFormula } from './link-graph.js';
import { _invalidateStoresCache, _set_currentFactoryEntryStore, getAppStores } from './utilities-sales.js';
const STORE_KEY = 'factory_formula_store';
const STORE_TS_KEY = 'factory_formula_store_timestamp';
const SLOTS_KEY = 'factory_formula_slots';
const SLOTS_TS_KEY = 'factory_formula_slots_timestamp';
const SLOT_KEYS = ['standard', 'asaan'];
const FALLBACK = { standard: 'Standard', asaan: 'Asaan' };
let _editingId = null;
const _el = (id) => document.getElementById(id);
const _num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const _fmt = (v) => (typeof window.fmtNum === 'function' ? window.fmtNum(v) : String(v));
const _money = (v) => (typeof window.formatCurrency === 'function' ? window.formatCurrency(v) : _fmt(v));
export async function getFormulaStore() {
  return ensureArray(await sqliteStore.get(STORE_KEY)).filter((f) => f && f.id);
}
export async function getFormulaSlots() {
  const v = await sqliteStore.get(SLOTS_KEY);
  return { standard: (v && v.standard) || null, asaan: (v && v.asaan) || null };
}
// The formula a store will actually use, read FRESH from the Formula Store on every call (never from a
// cached or derived copy): the store's own formulaId first, else the formula assigned to its slot.
// Ingredient names, ids and costs are resolved against live inventory. Falls back to the derived
// factory_default_formulas feed only when the Formula Store no longer has the formula.
export async function getSelectedFormula(storeKey) {
  const b = await sqliteStore.getBatch([STORE_KEY, SLOTS_KEY, 'app_stores', 'factory_default_formulas', 'factory_additional_costs', 'factory_inventory_data']);
  return resolveSelectedFormula({
    list: ensureArray(b.get(STORE_KEY)), slots: b.get(SLOTS_KEY) || {}, stores: ensureArray(b.get('app_stores')),
    feed: b.get('factory_default_formulas') || {}, costs: b.get('factory_additional_costs') || {}, inventory: ensureArray(b.get('factory_inventory_data')),
  }, storeKey);
}

export async function getFormulaSlotLabels() {
  const [list, slots] = await Promise.all([getFormulaStore(), getFormulaSlots()]);
  const out = {};
  SLOT_KEYS.forEach((k) => {
    const f = list.find((x) => String(x.id) === String(slots[k]));
    out[k] = f && f.name ? f.name : FALLBACK[k];
  });
  if (out.standard === out.asaan) out.asaan = out.asaan + ' (2)';
  return out;
}
export async function getStoreFormulaNames() {
  const [stores, list, slots] = await Promise.all([getAppStores(), getFormulaStore(), getFormulaSlots()]);
  const out = {};
  stores.forEach((s) => {
    const id = s.formulaId || slots[s.formulaType || 'standard'];
    const f = list.find((x) => String(x.id) === String(id));
    out[s.key] = esc(f && f.name ? f.name : (FALLBACK[s.formulaType] || 'Formula'));
  });
  return out;
}
function _slotOfStore(key, typeMap) {
  if (key === 'standard' || key === 'asaan') return key;
  return typeMap[key] || (key === 'STORE_C' ? 'asaan' : 'standard');
}
function _feedWrites(list, slots, base, now) {
  const formulas = { standard: [], asaan: [], ...(base.get('factory_default_formulas') || {}) };
  const costs = { standard: 0, asaan: 0, ...(base.get('factory_additional_costs') || {}) };
  const factors = { standard: 1, asaan: 1, ...(base.get('factory_cost_adjustment_factor') || {}) };
  SLOT_KEYS.forEach((k) => {
    const f = list.find((x) => String(x.id) === String(slots[k]));
    if (!f) return;
    formulas[k] = ensureArray(f.ingredients).map((i) => ({ id: i.id, name: i.name, cost: _num(i.cost, 0), quantity: _num(i.quantity, 0) }));
    costs[k] = _num(f.additionalCost, 0);
    factors[k] = _num(f.costAdjustmentFactor, 1) || 1;
  });
  return [['factory_default_formulas', formulas], ['factory_default_formulas_timestamp', now], ['factory_additional_costs', costs], ['factory_additional_costs_timestamp', now], ['factory_cost_adjustment_factor', factors], ['factory_cost_adjustment_factor_timestamp', now]];
}
const _FEED_KEYS = ['factory_default_formulas', 'factory_additional_costs', 'factory_cost_adjustment_factor'];
function _afterChange() {
  notifyDataChange('all');
  if (typeof triggerAutoSync === 'function') triggerAutoSync();
  if (typeof window.updateAllTabsWithFactoryCosts === 'function') window.updateAllTabsWithFactoryCosts();
  if (typeof window.calculateFactoryProduction === 'function') window.calculateFactoryProduction();
  refreshFormulaDependentUI();
}
export async function commitStoresWithFormulas(stores) {
  const [list, slots, batch, tracking] = await Promise.all([getFormulaStore(), getFormulaSlots(), sqliteStore.getBatch(_FEED_KEYS), sqliteStore.get('factory_unit_tracking')]);
  stores = stores.map((s) => {
    if (s.formulaId) return s;
    const inherited = slots[s.formulaType || 'standard'];
    return inherited ? { ...s, formulaId: inherited } : s;
  });
  const ids = [];
  stores.forEach((s) => { if (s.formulaId && !ids.includes(String(s.formulaId))) ids.push(String(s.formulaId)); });
  if (ids.some((id) => !list.find((f) => String(f.id) === id))) return { ok: false, error: 'Selected formula no longer exists in the Formula Store' };
  if (ids.length > SLOT_KEYS.length) return { ok: false, error: 'Only two different formulas can be active across stores. Pick one of the formulas already in use.' };
  const next = { standard: slots.standard, asaan: slots.asaan };
  ids.filter((id) => String(next.standard) !== id && String(next.asaan) !== id).forEach((id) => {
    const free = SLOT_KEYS.find((k) => !ids.includes(String(next[k])));
    next[free] = id;
  });
  for (const k of SLOT_KEYS) {
    if (!slots[k] || String(next[k]) === String(slots[k])) continue;
    const available = _num(tracking && tracking[k] && tracking[k].available, 0);
    if (available > 0) {
      const old = list.find((f) => String(f.id) === String(slots[k]));
      return { ok: false, error: `${available} unit${available === 1 ? '' : 's'} of "${old ? old.name : FALLBACK[k]}" are still available. Use them in manufacturing before assigning a different formula.` };
    }
  }
  const normalized = stores.map((s) => {
    const slot = s.formulaId ? SLOT_KEYS.find((k) => String(next[k]) === String(s.formulaId)) : null;
    return { ...s, formulaType: slot || s.formulaType || 'standard' };
  });
  const now = getTimestamp();
  const writes = [..._feedWrites(list, next, batch, now), [SLOTS_KEY, next], [SLOTS_TS_KEY, now], ['app_stores', normalized], ['app_stores_timestamp', Date.now()]];
  await sqliteStore.setBatch(writes);
  _invalidateStoresCache();
  _afterChange();
  return { ok: true, stores: normalized };
}
async function _saveFormulaStore(list, extraWrites) {
  const now = getTimestamp();
  await sqliteStore.setBatch([[STORE_KEY, list], [STORE_TS_KEY, now], ...(extraWrites || [])]);
  _afterChange();
}
function _totals(ingredients, additionalCost, factor) {
  let raw = 0;
  let weight = 0;
  ingredients.forEach((i) => { raw += (_num(i.cost, 0) * _num(i.quantity, 0)); weight += _num(i.quantity, 0); });
  const perUnit = raw + additionalCost;
  const perKg = factor > 0 ? perUnit / factor : perUnit;
  return { raw, weight, perUnit, perKg };
}
function _liveCost(ing, inventory) {
  let live = inventory.find((i) => String(i.id) === String(ing.id));
  if (!live && ing.name) live = inventory.find((i) => i.name && i.name.trim().toLowerCase() === String(ing.name).trim().toLowerCase());
  const c = live ? Number(live.cost) : NaN;
  return Number.isFinite(c) && c > 0 ? c : _num(ing.cost, 0);
}
function _row(label, value, extra) {
  return `<div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:2px;${extra || ''}"><span>${label}</span><span>${value}</span></div>`;
}
function _card(f, inventory, usedBy) {
  const ings = ensureArray(f.ingredients).map((i) => ({ ...i, cost: _liveCost(i, inventory) }));
  const addl = _num(f.additionalCost, 0);
  const factor = _num(f.costAdjustmentFactor, 1) || 1;
  const t = _totals(ings, addl, factor);
  let html = `<h4 style="margin:0 0 6px 0;font-size:0.9rem;">${esc(f.name || 'Untitled')} (1 Unit)</h4>`;
  html += ings.length ? ings.map((i) => _row(`${esc(i.name)} (${_fmt(_num(i.quantity, 0))} kg)`, _money(_num(i.cost, 0) * _num(i.quantity, 0)))).join('') : '<div class="u-text-muted">No ingredients.</div>';
  if (addl > 0) html += _row(`Additional Cost (${addl} per unit)`, _money(addl), 'color:var(--danger);');
  html += '<div style="border-top:1px dashed var(--glass-border);margin:8px 0 6px 0;"></div>';
  html += _row('Unit Weight', _fmt(t.weight) + ' kg');
  html += _row('Raw Material Cost per Unit', _money(t.raw));
  html += _row('Total Cost per Unit', _money(t.perUnit), 'font-weight:700;');
  html += _row('Cost per kg (Sales/Calc)', _money(t.perKg));
  html += `<div class="formula-store-edit-hint">${usedBy.length ? 'Used by ' + esc(usedBy.join(', ')) + ' · ' : ''}Tap to edit</div>`;
  return `<div class="formula-display formula-store-card" onclick="openFormulaStoreEditor('${esc(String(f.id))}')">${html}</div>`;
}
export async function renderFormulaStoreList() {
  const box = _el('formulaStoreList');
  if (!box) return;
  const [list, stores, slotsNow] = await Promise.all([getFormulaStore(), getAppStores(), getFormulaSlots()]);
  if (!list.length) {
    box.innerHTML = '<div class="u-search-empty" style="padding:24px;text-align:center;">No formulas yet. Tap the + button to add one.</div>';
    return;
  }
  const inventory = ensureArray(await sqliteStore.get('factory_inventory_data'));
  box.innerHTML = list.map((f) => _card(f, inventory, stores.filter((s) => String(s.formulaId || slotsNow[s.formulaType || 'standard']) === String(f.id)).map((s) => s.name))).join('');
}
export async function openFormulaStore() {
  await renderFormulaStoreList();
}
function _createRow(container, selectedId, qtyVal, costVal, savedName, inventory) {
  let currentCost = costVal !== null ? costVal : 0;
  const currentId = selectedId ? String(selectedId) : '';
  let currentName = savedName || '';
  if (currentId) {
    const match = inventory.find((i) => String(i.id) === currentId);
    if (match) {
      currentName = match.name;
      if (costVal === null) currentCost = match.cost;
    }
  }
  const notify = () => container.dispatchEvent(new CustomEvent('formularowchange'));
  const div = document.createElement('div');
  div.className = 'factory-formula-grid';
  div.style.position = 'relative';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'factory-mat-select';
  searchWrap.style.cssText = 'position:relative;';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'factory-mat-search-input';
  searchInput.placeholder = 'Search material…';
  searchInput.value = currentName;
  searchInput.dataset.matId = currentId;
  searchInput.dataset.matCost = String(currentCost);
  searchInput.autocomplete = 'off';
  searchInput.style.cssText = 'width:100%;box-sizing:border-box;';
  const dropdown = document.createElement('div');
  dropdown.className = 'factory-mat-dropdown hidden u-search-dropdown';
  dropdown.style.cssText = 'position:absolute;top:100%;left:0;right:0;z-index:999;max-height:180px;overflow-y:auto;';
  const costInput = document.createElement('input');
  costInput.type = 'number';
  costInput.className = 'factory-mat-cost';
  costInput.placeholder = 'Cost';
  costInput.value = currentCost;
  costInput.readOnly = true;
  costInput.style.cssText = 'background:rgba(0,0,0,0.05);color:var(--text-muted);cursor:default;';
  const renderDropdown = (query) => {
    const q = (query || '').toLowerCase();
    const filtered = q ? inventory.filter((i) => i.name && i.name.toLowerCase().includes(q)) : inventory;
    const typed = (query || '').trim();
    const exact = typed && inventory.some((i) => i.name && i.name.trim().toLowerCase() === typed.toLowerCase());
    const customOpt = typed && !exact ? `<div class="factory-mat-option factory-mat-custom" data-custom="1" data-name="${esc(typed)}" style="padding:9px 10px;cursor:pointer;border-bottom:1px solid var(--glass-border);font-size:0.78rem;font-weight:700;color:var(--accent);">+ Add "${esc(typed)}" (not in inventory)</div>` : '';
    if (!filtered.length) {
      dropdown.innerHTML = (customOpt || '<div class="u-search-empty">No materials found</div>');
    } else {
      dropdown.innerHTML = filtered.map((i) => `<div class="factory-mat-option" data-id="${esc(String(i.id))}" data-cost="${esc(String(i.cost))}" data-name="${esc(i.name)}" style="padding:9px 10px;cursor:pointer;border-bottom:1px solid var(--glass-border);font-size:0.85rem;color:var(--text-main);background:var(--input-bg);">${esc(i.name)}</div>`).join('') + customOpt;
    }
    dropdown.classList.remove('hidden');
    dropdown.querySelectorAll('.factory-mat-option').forEach((opt) => {
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (opt.dataset.custom === '1') {
          searchInput.value = opt.dataset.name;
          searchInput.dataset.matId = 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          searchInput.dataset.custom = '1';
          searchInput.dataset.matCost = '0';
          costInput.value = 0;
          dropdown.classList.add('hidden');
          notify();
          return;
        }
        delete searchInput.dataset.custom;
        searchInput.value = opt.dataset.name;
        searchInput.dataset.matId = opt.dataset.id;
        searchInput.dataset.matCost = opt.dataset.cost;
        costInput.value = opt.dataset.cost;
        dropdown.classList.add('hidden');
        notify();
      });
    });
  };
  searchInput.addEventListener('focus', () => renderDropdown(searchInput.value));
  searchInput.addEventListener('input', () => {
    if (searchInput.dataset.custom === '1') { searchInput.dataset.matId = ''; delete searchInput.dataset.custom; }
    renderDropdown(searchInput.value);
  });
  searchInput.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.add('hidden'), 150);
    if (!searchInput.dataset.matId) {
      const typed = searchInput.value.trim();
      if (typed) {
        const inv = inventory.find((i) => i.name && i.name.trim().toLowerCase() === typed.toLowerCase());
        if (inv) {
          searchInput.value = inv.name;
          searchInput.dataset.matId = String(inv.id);
          searchInput.dataset.matCost = String(inv.cost);
          costInput.value = inv.cost;
        } else {
          searchInput.dataset.matId = 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          searchInput.dataset.custom = '1';
          costInput.value = 0;
        }
        notify();
      } else {
        costInput.value = '';
      }
    }
  });
  searchWrap.appendChild(searchInput);
  searchWrap.appendChild(dropdown);
  const qtyInput = document.createElement('input');
  qtyInput.type = 'number';
  qtyInput.className = 'factory-mat-qty';
  qtyInput.placeholder = 'Qty (kg)';
  qtyInput.value = qtyVal;
  qtyInput.addEventListener('input', notify);
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'factory-row-del-btn';
  delBtn.innerHTML = '&times;';
  delBtn.title = 'Remove row';
  delBtn.onclick = () => {
    div.remove();
    notify();
  };
  div.appendChild(searchWrap);
  div.appendChild(costInput);
  div.appendChild(qtyInput);
  div.appendChild(delBtn);
  container.appendChild(div);
  return div;
}
async function _fillEditor(entry) {
  const inventory = ensureArray(await sqliteStore.get('factory_inventory_data'));
  const container = _el('fsEditContainer');
  if (!container) return;
  container.replaceChildren();
  ensureArray(entry.ingredients).forEach((ing) => {
    let id = ing.id;
    if (/^custom_/.test(String(id)) && ing.name) {
      const inv = inventory.find((i) => i.name && i.name.trim().toLowerCase() === String(ing.name).trim().toLowerCase());
      if (inv) id = inv.id;
    }
    const row = _createRow(container, id, ing.quantity, id === ing.id ? ing.cost : null, ing.name, inventory);
    if (/^custom_/.test(String(id))) { const inp = row.querySelector('.factory-mat-search-input'); if (inp) inp.dataset.custom = '1'; }
  });
  _el('fs-edit-name').value = entry.name || '';
  _el('fs-additional-cost').value = _num(entry.additionalCost, 0);
  _el('fs-cost-factor').value = _num(entry.costAdjustmentFactor, 1);
  updateFormulaStoreSummary();
}
function _collectEditor() {
  const container = _el('fsEditContainer');
  const ingredients = [];
  if (container) {
    container.querySelectorAll('.factory-formula-grid').forEach((row) => {
      const inp = row.querySelector('.factory-mat-search-input');
      const costIn = row.querySelector('.factory-mat-cost');
      const qtyIn = row.querySelector('.factory-mat-qty');
      const name = inp ? inp.value.trim() : '';
      if (inp && inp.dataset.matId && name && qtyIn && _num(qtyIn.value, 0) > 0) {
        ingredients.push({ id: inp.dataset.matId, name, cost: _num(costIn ? costIn.value : 0, 0), quantity: _num(qtyIn.value, 0), ...(inp.dataset.custom === '1' ? { custom: true } : {}) });
      }
    });
  }
  return {
    name: _el('fs-edit-name').value.trim(),
    ingredients,
    additionalCost: _num(_el('fs-additional-cost').value, 0),
    costAdjustmentFactor: _num(_el('fs-cost-factor').value, 1) || 1
  };
}
export function updateFormulaStoreSummary() {
  const c = _collectEditor();
  const t = _totals(c.ingredients, c.additionalCost, c.costAdjustmentFactor);
  const set = (id, v) => { const el = _el(id); if (el) el.innerText = v; };
  set('fsSummaryWeight', _fmt(t.weight) + ' kg');
  set('fsSummaryRaw', _fmt(t.raw));
  set('fsSummaryPerUnit', _fmt(t.perUnit));
  set('fsSummaryPerKg', _fmt(t.perKg));
}
function _bindEditor() {
  const container = _el('fsEditContainer');
  if (!container || container.dataset.bound === '1') return;
  container.dataset.bound = '1';
  container.addEventListener('formularowchange', () => setTimeout(updateFormulaStoreSummary, 0));
}
export async function openFormulaStoreEditor(id) {
  _editingId = id || null;
  const list = await getFormulaStore();
  const entry = id ? list.find((f) => String(f.id) === String(id)) : null;
  if (id && !entry) { showToast('Formula not found', 'warning'); return; }
  const del = _el('fs-delete-btn');
  if (del) del.style.display = entry ? '' : 'none';
  const title = _el('fs-edit-title');
  if (title) title.textContent = entry ? 'Edit Formula' : 'New Formula';
  _bindEditor();
  if (typeof window.openStandaloneScreen === 'function') window.openStandaloneScreen('formula-store-edit-screen');
  await _fillEditor(entry || { name: '', ingredients: [], additionalCost: 0, costAdjustmentFactor: 1 });
}
export async function addFormulaIngredientRow() {
  const container = _el('fsEditContainer');
  if (!container) return;
  _bindEditor();
  const inventory = ensureArray(await sqliteStore.get('factory_inventory_data'));
  const row = _createRow(container, '', '', null, '', inventory);
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const inp = row.querySelector('.factory-mat-search-input');
  if (inp) setTimeout(() => inp.focus(), 200);
  updateFormulaStoreSummary();
}
export async function saveFormulaStoreEntry() {
  const c = _collectEditor();
  if (!c.name) { showToast('Enter a formula name', 'warning'); return false; }
  if (!c.ingredients.length) { showToast('Add at least one ingredient with quantity', 'warning'); return false; }
  const [list, slots, batch] = await Promise.all([getFormulaStore(), getFormulaSlots(), sqliteStore.getBatch(_FEED_KEYS)]);
  const now = getTimestamp();
  const idx = _editingId ? list.findIndex((f) => String(f.id) === String(_editingId)) : -1;
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...c, updatedAt: now };
  } else {
    _editingId = generateUUID('formula');
    list.push({ id: _editingId, ...c, createdAt: now, updatedAt: now });
  }
  const inSlot = SLOT_KEYS.some((k) => String(slots[k]) === String(_editingId));
  await _saveFormulaStore(list, inSlot ? _feedWrites(list, slots, batch, now) : []);
  showToast('Formula saved', 'success');
  sendDeviceNotification(idx >= 0 ? 'Formula updated' : 'Formula created', `"${c.name}" was saved with ${c.ingredients.length} ingredient${c.ingredients.length === 1 ? '' : 's'}.`, 'formula-' + _editingId).catch(() => {});
  if (typeof window.closeStandaloneScreen === 'function') window.closeStandaloneScreen('formula-store-edit-screen');
  return true;
}
export async function deleteFormulaStoreEntry() {
  if (!_editingId) return;
  const [slots, stores] = await Promise.all([getFormulaSlots(), getAppStores()]);
  const users = stores.filter((s) => String(s.formulaId || slots[s.formulaType || 'standard']) === String(_editingId)).map((s) => s.name);
  if (users.length || SLOT_KEYS.some((k) => String(slots[k]) === String(_editingId))) {
    showToast(users.length ? `In use by ${users.join(', ')}. Assign those stores another formula first.` : 'This formula is active in the factory. Assign another formula to the stores first.', 'warning', 4500);
    return;
  }
  const ok = await showGlassConfirm('Delete this formula from the store?', { title: 'Delete Formula', confirmText: 'Delete', danger: true });
  if (!ok) return;
  const fullList = await getFormulaStore();
  const removed = fullList.find((f) => String(f.id) === String(_editingId));
  const list = fullList.filter((f) => String(f.id) !== String(_editingId));
  await _saveFormulaStore(list);
  sendDeviceNotification('Formula deleted', removed && removed.name ? `"${removed.name}" was removed from your formulas.` : 'A formula was removed.', 'formula-del-' + _editingId).catch(() => {});
  _editingId = null;
  if (typeof window.closeStandaloneScreen === 'function') window.closeStandaloneScreen('formula-store-edit-screen');
  showToast('Formula deleted', 'success');
}
function _renderChoice(hostId, items, active, onPick, emptyText) {
  const host = _el(hostId);
  if (!host) return;
  host.textContent = '';
  if (items.length < 2) {
    const only = document.createElement('span');
    only.className = 'formula-label';
    only.textContent = items.length ? items[0].label : emptyText;
    host.appendChild(only);
    return;
  }
  const group = document.createElement('div');
  group.className = 'formula-toggle';
  group.setAttribute('role', 'group');
  items.forEach((it) => {
    const on = it.value === String(active);
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'formula-toggle-opt' + (on ? ' active' : '');
    opt.setAttribute('aria-pressed', on ? 'true' : 'false');
    opt.textContent = it.label;
    opt.addEventListener('click', () => onPick(it.value));
    group.appendChild(opt);
  });
  host.appendChild(group);
}
export async function setStoreFormulaSelection(id) {
  const list = await getFormulaStore();
  const f = list.find((x) => String(x.id) === String(id));
  const input = _el('store-formula-select');
  if (input) input.value = f ? String(f.id) : '';
  const btn = _el('store-formula-btn');
  const sp = btn ? btn.querySelector('span') : null;
  if (sp) sp.textContent = f ? (f.name || 'Untitled') : 'Select formula';
}
export async function openStoreFormulaPicker(btn) {
  const old = document.getElementById('_pop_storeFormula');
  const wasOpen = !!old && old.style.display !== 'none';
  if (old) old.remove();
  if (wasOpen) return;
  const list = await getFormulaStore();
  if (!list.length) { showToast('Add a formula in the Formula Store first', 'warning'); return; }
  window._mkPopover(btn.parentNode, '_pop_storeFormula', list.map((f) => ({ value: String(f.id), label: f.name || 'Untitled' })), (v) => {
    const input = _el('store-formula-select');
    if (input) input.value = v;
  });
  const pop = document.getElementById('_pop_storeFormula');
  if (pop) {
    pop.style.left = '0';
    pop.style.maxHeight = '220px';
    pop.style.overflowY = 'auto';
  }
}
function _slotItems(view, order) {
  return view ? order.map((k) => ({ value: k, label: view.labels[k] })) : [];
}
export function syncFactoryFormulaPicker(slot) {
  const view = window._formulaSlotView;
  const input = _el('factory-formula-value');
  if (input) input.value = slot;
  _renderChoice('factoryFormulaToggle', _slotItems(view, view ? view.entryOrder : []), slot, (k) => { if (typeof window.selectFactoryFormula === 'function') window.selectFactoryFormula(k); }, 'No formula');
}
export function syncFactoryAvailPicker(slot) {
  const view = window._formulaSlotView;
  const input = _el('factory-avail-value');
  if (input) input.value = slot;
  _renderChoice('factoryAvailToggle', _slotItems(view, view ? view.availOrder : []), slot, (k) => { if (typeof window.setFactoryAvailableStore === 'function') window.setFactoryAvailableStore(k); }, 'No formula');
}
export async function refreshFormulaDependentUI() {
  const [labels, slots, stores, tracking] = await Promise.all([getFormulaSlotLabels(), getFormulaSlots(), getAppStores(), sqliteStore.get('factory_unit_tracking')]);
  const used = new Set(stores.map((s) => s.formulaType || 'standard'));
  const typeMap = {};
  stores.forEach((s) => { typeMap[s.key] = s.formulaType || 'standard'; });
  const entryOrder = SLOT_KEYS.filter((k) => !!slots[k] && used.has(k));
  const availOrder = SLOT_KEYS.filter((k) => !!slots[k] && (used.has(k) || _num(tracking && tracking[k] && tracking[k].available, 0) > 0));
  if (!entryOrder.length) entryOrder.push(SLOT_KEYS[0]);
  if (!availOrder.length) availOrder.push(SLOT_KEYS[0]);
  const shown = {};
  SLOT_KEYS.forEach((k) => { shown[k] = slots[k] ? labels[k] : 'No formula'; });
  window._formulaSlotLabels = labels;
  window._formulaSlotView = { labels: shown, entryOrder, availOrder };
  let activeSlot = _slotOfStore(window.currentFactoryEntryStore || 'STORE_A', typeMap);
  if (!entryOrder.includes(activeSlot)) activeSlot = entryOrder[0];
  const rep = stores.find((s) => (s.formulaType || 'standard') === activeSlot);
  if (rep && typeMap[window.currentFactoryEntryStore] !== activeSlot) _set_currentFactoryEntryStore(rep.key);
  syncFactoryFormulaPicker(activeSlot);
  const availInput = _el('factory-avail-value');
  let availSlot = availInput ? availInput.value : availOrder[0];
  if (!availOrder.includes(availSlot)) availSlot = availOrder[0];
  if (typeof window.setFactoryAvailableStore === 'function') await window.setFactoryAvailableStore(availSlot);
  else syncFactoryAvailPicker(availSlot);
  refreshFormulaStoreScreens();
  if (typeof window.renderStoreList === 'function' && _el('store-manager-screen') && _el('store-manager-screen').style.display !== 'none') window.renderStoreList();
  if (typeof window.calculateFactoryProduction === 'function') window.calculateFactoryProduction();
  if (typeof window.renderFactoryHistory === 'function') window.renderFactoryHistory();
}
export function refreshFormulaStoreScreens() {
  const listScreen = _el('formula-store-screen');
  if (listScreen && listScreen.style.display !== 'none') renderFormulaStoreList();
}
Object.assign(window, { openFormulaStore, renderFormulaStoreList, openFormulaStoreEditor, addFormulaIngredientRow, saveFormulaStoreEntry, deleteFormulaStoreEntry, updateFormulaStoreSummary, refreshFormulaStoreScreens, refreshFormulaDependentUI, syncFactoryFormulaPicker, syncFactoryAvailPicker, commitStoresWithFormulas, setStoreFormulaSelection, openStoreFormulaPicker, getStoreFormulaNames, getFormulaSlotLabels, getFormulaSlots, getFormulaStore });
