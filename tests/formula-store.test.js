import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../modules/formula-store.js', import.meta.url), 'utf8');
const DEFAULTS = [
  { key: 'STORE_A', name: 'ZUBAIR', formulaType: 'standard' },
  { key: 'STORE_B', name: 'MAHMOOD', formulaType: 'standard' },
  { key: 'STORE_C', name: 'ASAAN', formulaType: 'asaan' },
];

function load(initial = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  const notes = [];
  const sqliteStore = {
    get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : null),
    set: async (k, v) => { writes.push(k); data.set(k, structuredClone(v)); },
    setBatch: async (pairs) => { for (const [k, v] of pairs) { writes.push(k); data.set(k, structuredClone(v)); } },
    getBatch: async (keys) => new Map(keys.map((k) => [k, data.has(k) ? structuredClone(data.get(k)) : undefined])),
  };
  const window = {};
  const document = { getElementById: () => null };
  const stubs = {
    ensureArray: (v) => (Array.isArray(v) ? v : []),
    esc: (v) => String(v), generateUUID: (p) => p + '_id', getTimestamp: () => 1000, sqliteStore,
    showGlassConfirm: async () => true, showToast: () => {},
    sendDeviceNotification: async (t, b) => { notes.push([t, b]); },
    notifyDataChange: () => {}, triggerAutoSync: () => {},
    _invalidateStoresCache: () => {}, _set_currentFactoryEntryStore: () => {},
    getAppStores: async () => { const s = data.get('app_stores'); return Array.isArray(s) && s.length ? structuredClone(s) : structuredClone(DEFAULTS); },
    window, document,
  };
  const body = src.replace(/^import .*$/gm, '').replace(/^export (async )?function/gm, '$1function');
  const ctx = vm.createContext({ ...stubs, console, structuredClone, Promise, Number, String, Array, Math, Date, JSON });
  vm.runInContext(body + '\nthis.api = { commitStoresWithFormulas, getFormulaStore, getFormulaSlots };', ctx);
  return { api: ctx.api, data, writes, notes };
}

const legacy = { factory_default_formulas: { standard: [{ name: 'a', quantity: 1, cost: 2 }], asaan: [{ name: 'b', quantity: 1, cost: 3 }] } };

describe('commitStoresWithFormulas', () => {
  const base = () => ({
    ...legacy,
    factory_formula_store: [{ id: 'f1', name: 'Std', ingredients: [] }, { id: 'f2', name: 'Asn', ingredients: [] }],
    factory_formula_slots: { standard: 'f1', asaan: 'f2' },
  });
  it('editing one store keeps the others on their own formulas and prices', async () => {
    const { api, data } = load(base());
    const stores = structuredClone(DEFAULTS);
    stores[0] = { ...stores[0], formulaId: 'f1', salePrice: 540 };
    stores[1] = { ...stores[1], salePrice: 515 };
    stores[2] = { ...stores[2], salePrice: 610 };
    const r = await api.commitStoresWithFormulas(stores);
    assert.equal(r.ok, true, r.error);
    const saved = data.get('app_stores');
    assert.deepEqual(saved.map((s) => s.salePrice), [540, 515, 610]);
    assert.deepEqual(saved.map((s) => s.formulaId), ['f1', 'f1', 'f2']);
    assert.deepEqual(saved.map((s) => s.formulaType), ['standard', 'standard', 'asaan']);
    assert.ok(data.get('app_stores_timestamp') > 0);
  });
  it('does not silently move other stores when a third formula is chosen', async () => {
    const t = load({ ...base(), factory_formula_store: [...base().factory_formula_store, { id: 'f3', name: 'New', ingredients: [] }] });
    const stores = structuredClone(DEFAULTS);
    stores[0] = { ...stores[0], formulaId: 'f3' };
    const r = await t.api.commitStoresWithFormulas(stores);
    assert.equal(r.ok, false);
    assert.match(r.error, /Only two different formulas/);
    assert.ok(!t.writes.includes('app_stores'));
  });
});
