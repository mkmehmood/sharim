import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RECORD_STORES, AUX_STATE, SQLITE_TO_FIRESTORE, FIRESTORE_TO_SQLITE,
  normaliseBackupFields, collectAuxBackupFields, applyAuxBackupFields,
  mergeStringLists, mergeById, mergeSlots, resolveExpenseCategories,
} from '../modules/data-keys.js';

const read = f => readFileSync(new URL(`../modules/${f}`, import.meta.url), 'utf8');
const sync = read('sync.js');
const sales = read('utilities-sales.js');
const payments = read('utilities-payments.js');
const admin = read('admin-data.js');

function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
function objectLiteral(src, name) {
  const start = src.indexOf(`export const ${name} = {`);
  assert.ok(start >= 0, `${name} not found`);
  const end = src.indexOf('\n};', start);
  return src.slice(start, end);
}
function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { async get(k) { return m.has(k) ? m.get(k) : undefined; }, async set(k, v) { m.set(k, v); }, _m: m };
}

describe('registry matches the maps the cloud sync really uses', () => {
  it('SQLiteToFirestoreMap in sync.js equals the registry', () => {
    const lit = objectLiteral(sync, 'SQLiteToFirestoreMap');
    const pairs = [...lit.matchAll(/'([a-z_]+)':\s*\{\s*collection:\s*'([a-z_]+)'/g)].map(m => [m[1], m[2]]);
    assert.deepEqual(Object.fromEntries(pairs), SQLITE_TO_FIRESTORE);
  });
  it('FirestoreToSQLiteMap in sync.js equals the registry inverse', () => {
    const lit = objectLiteral(sync, 'FirestoreToSQLiteMap');
    const pairs = [...lit.matchAll(/'([a-z_]+)':\s*'([a-z_]+)'/g)].map(m => [m[1], m[2]]);
    assert.deepEqual(Object.fromEntries(pairs), FIRESTORE_TO_SQLITE);
  });
  it('registry has no duplicate keys', () => {
    for (const field of ['sqlite', 'collection', 'backup']) {
      const vals = RECORD_STORES.map(s => s[field]);
      assert.equal(new Set(vals).size, vals.length, `duplicate ${field}`);
    }
  });
});

describe('every backup writer carries every record store and every aux key', () => {
  const writers = {
    unifiedBackup: fnBody(sales, 'unifiedBackup'),
    triggerLocalBackup: fnBody(payments, 'triggerLocalBackup'),
    closeYearBackup: admin.slice(admin.indexOf('const backupData = {'), admin.indexOf('const backupData = {') + 2500),
  };
  for (const [name, body] of Object.entries(writers)) {
    it(`${name} writes all record stores`, () => {
      for (const s of RECORD_STORES) {
        assert.ok(new RegExp(`\\b${s.backup}\\s*:`).test(body), `${name} is missing backup field "${s.backup}" (${s.sqlite})`);
      }
    });
    it(`${name} writes expense categories, formula store/slots and photos via the shared collector`, () => {
      assert.ok(body.includes('collectAuxBackupFields(sqliteStore)'), `${name} must spread collectAuxBackupFields`);
    });
  }
  it('both restore paths apply the aux fields', () => {
    const merge = fnBody(sales, '_doRestoreMerge');
    const yc = fnBody(sales, '_doYearCloseRestore');
    assert.ok(merge.includes("applyAuxBackupFields(data, sqliteStore, settingsTimestamp, 'merge')"));
    assert.ok(yc.includes("applyAuxBackupFields(data, sqliteStore, settingsTimestamp, 'replace')"));
  });
});

describe('cloud sync uses the same keys the app reads', () => {
  it('every write of current_rep_profile also writes repProfile', () => {
    const lines = sync.split('\n');
    lines.forEach((l, i) => {
      if (!l.includes("'current_rep_profile'") || l.includes('sqlite:')) return;
      const around = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
      assert.ok(around.includes("'repProfile'"), `sync.js line ${i + 1} writes current_rep_profile without repProfile`);
    });
  });
  it('settings/config upload carries its timestamp (listeners compare it)', () => {
    assert.ok(/naswar_default_settings:\s*_ds \|\| \{\},\s*naswar_default_settings_timestamp:\s*localSettingsTs/.test(sync));
  });
  it('expense category upload carries categories_timestamp (listeners compare it)', () => {
    assert.ok(/categories:\s*_ec \|\| \[\],\s*categories_timestamp:\s*localExpCatTs/.test(sync));
  });
  it('local expense category edits stamp expense_categories_timestamp', () => {
    const sets = (payments.match(/set\('expense_categories',/g) || []).length;
    const stamps = (payments.match(/set\('expense_categories_timestamp'/g) || []).length;
    assert.ok(stamps >= 3, `expected stamps next to category writes, found ${stamps} (writes: ${sets})`);
  });
});

describe('backup field normalisation', () => {
  it('keeps the legacy mfg/sales twins', () => {
    const d = normaliseBackupFields({ mfg: [1], sales: [2] });
    assert.deepEqual([d.mfg_pro_pkr, d.noman_history], [[1], [2]]);
  });
  it('accepts snake_case spellings from older exports', () => {
    const d = normaliseBackupFields({ expense_categories: ['Fuel'], factory_formula_store: [{ id: 'a' }], customer_sales: [{ id: 's' }] });
    assert.deepEqual(d.expenseCategories, ['Fuel']);
    assert.deepEqual(d.factoryFormulaStore, [{ id: 'a' }]);
    assert.deepEqual(d.customerSales, [{ id: 's' }]);
  });
  it('never overwrites a field that is already present', () => {
    const d = normaliseBackupFields({ expenseCategories: ['A'], expense_categories: ['B'] });
    assert.deepEqual(d.expenseCategories, ['A']);
  });
});

describe('aux state round trip: backup -> restore into a fresh device', () => {
  const source = () => memStore({
    expense_categories: ['Fuel', 'Tea'],
    factory_formula_store: [{ id: 'f1', name: 'Std' }, { id: 'f2', name: 'Asaan' }],
    factory_formula_slots: { standard: 'f1', asaan: 'f2' },
    person_photos: { a: 'data:x' },
    person_photos_timestamps: { a: 5 },
  });
  it('collect captures every aux key', async () => {
    const out = await collectAuxBackupFields(source());
    for (const s of AUX_STATE) assert.ok(s.backup in out, s.backup);
    assert.deepEqual(out.person_photos, { a: 'data:x' });
  });
  it('merge restore fills an empty device and stamps timestamps', async () => {
    const data = await collectAuxBackupFields(source());
    const fresh = memStore();
    const written = await applyAuxBackupFields(data, fresh, 123, 'merge');
    assert.deepEqual(written.sort(), ['expense_categories', 'factory_formula_slots', 'factory_formula_store']);
    assert.deepEqual(fresh._m.get('expense_categories'), ['Fuel', 'Tea']);
    assert.equal(fresh._m.get('expense_categories_timestamp'), 123);
    assert.equal(fresh._m.get('factory_formula_store').length, 2);
    assert.deepEqual(fresh._m.get('factory_formula_slots'), { standard: 'f1', asaan: 'f2' });
  });
  it('merge restore never drops local data', async () => {
    const data = await collectAuxBackupFields(source());
    const dev = memStore({ expense_categories: ['Rent'], factory_formula_store: [{ id: 'f9' }], factory_formula_slots: { standard: 'f9', asaan: null } });
    await applyAuxBackupFields(data, dev, 1, 'merge');
    assert.deepEqual(dev._m.get('expense_categories'), ['Rent', 'Fuel', 'Tea']);
    assert.deepEqual(dev._m.get('factory_formula_store').map(f => f.id), ['f9', 'f1', 'f2']);
    assert.deepEqual(dev._m.get('factory_formula_slots'), { standard: 'f9', asaan: 'f2' });
  });
  it('replace restore (year-close reversal) makes the backup win', async () => {
    const data = await collectAuxBackupFields(source());
    const dev = memStore({ expense_categories: ['Rent'], factory_formula_store: [{ id: 'f9' }], factory_formula_slots: { standard: 'f9', asaan: null } });
    await applyAuxBackupFields(data, dev, 1, 'replace');
    assert.deepEqual(dev._m.get('expense_categories'), ['Fuel', 'Tea']);
    assert.deepEqual(dev._m.get('factory_formula_store').map(f => f.id), ['f1', 'f2']);
    assert.deepEqual(dev._m.get('factory_formula_slots'), { standard: 'f1', asaan: 'f2' });
  });
  it('old backups without these fields restore without touching local data', async () => {
    const dev = memStore({ expense_categories: ['Rent'] });
    const written = await applyAuxBackupFields({ mfg: [] }, dev, 1, 'merge');
    assert.deepEqual(written, []);
    assert.deepEqual(dev._m.get('expense_categories'), ['Rent']);
  });
});

describe('merge helpers and cloud category resolution', () => {
  it('mergeStringLists trims, drops blanks and duplicates, keeps order', () => {
    assert.deepEqual(mergeStringLists(['a', ' b '], ['b', '', 'c', 7]), ['a', 'b', 'c']);
  });
  it('mergeById keeps local, adds new, skips id-less', () => {
    assert.deepEqual(mergeById([{ id: 1, v: 'L' }], [{ id: 1, v: 'B' }, { id: 2 }, { v: 'x' }]), [{ id: 1, v: 'L' }, { id: 2 }]);
  });
  it('mergeSlots fills only the missing side', () => {
    assert.deepEqual(mergeSlots({ standard: 'a' }, { standard: 'z', asaan: 'b' }), { standard: 'a', asaan: 'b' });
  });
  it('newer cloud stamp replaces local', () => {
    const r = resolveExpenseCategories(['A', 'B'], ['A'], 10, 20);
    assert.deepEqual(r, { value: ['A'], ts: 20, changed: true });
  });
  it('legacy cloud doc (no stamp) never deletes local-only categories', () => {
    const r = resolveExpenseCategories(['A', 'B'], ['A', 'C'], 5, 0);
    assert.deepEqual(r.value, ['A', 'B', 'C']);
    assert.equal(r.ts, 5);
  });
  it('older cloud stamp leaves local untouched', () => {
    const r = resolveExpenseCategories(['A', 'B'], ['Z'], 30, 20);
    assert.deepEqual(r, { value: ['A', 'B'], ts: 30, changed: false });
  });
});
