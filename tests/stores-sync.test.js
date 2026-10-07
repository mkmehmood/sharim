import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../modules/sync.js', import.meta.url), 'utf8');
function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in sync.js`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const { keepLocal, fillFromCloud } = new Function(
  `${grab('_keepLocalSalePrices')}\n${grab('_fillStoresFromCloud')}\nreturn { keepLocal: _keepLocalSalePrices, fillFromCloud: _fillStoresFromCloud };`
)();

const cloud = [
  { key: 'STORE_A', name: 'ZUBAIR', formulaType: 'standard', formulaId: 'f1', salePrice: 520 },
  { key: 'STORE_B', name: 'MAHMOOD', formulaType: 'standard', formulaId: 'f1', salePrice: 515 },
  { key: 'STORE_C', name: 'ASAAN', formulaType: 'asaan', formulaId: 'f2', salePrice: 610 },
];
const defaults = [
  { key: 'STORE_A', name: 'ZUBAIR', formulaType: 'standard' },
  { key: 'STORE_B', name: 'MAHMOOD', formulaType: 'standard' },
  { key: 'STORE_C', name: 'ASAAN', formulaType: 'asaan' },
];

describe('store sync never replaces real cloud data with defaults', () => {
  it('first upload from a device holding default stores keeps cloud prices and formulas', () => {
    const { stores, changed } = fillFromCloud(defaults, cloud);
    assert.equal(changed, true);
    assert.deepEqual(stores.map(s => s.salePrice), [520, 515, 610]);
    assert.equal(stores[2].formulaId, 'f2');
  });
  it('a first edit of one store keeps the other stores\' cloud prices', () => {
    const edited = defaults.map(s => ({ ...s }));
    edited[0] = { ...edited[0], salePrice: 540, formulaId: 'f1' };
    const { stores } = fillFromCloud(edited, cloud);
    assert.equal(stores[0].salePrice, 540);
    assert.equal(stores[1].salePrice, 515);
    assert.equal(stores[2].salePrice, 610);
  });
  it('does not override a real local price', () => {
    const local = [{ key: 'STORE_A', salePrice: 999, formulaId: 'x' }];
    const { stores } = fillFromCloud(local, cloud);
    assert.equal(stores[0].salePrice, 999);
    assert.equal(stores[0].formulaId, 'x');
  });
  it('stores that exist only in the cloud are kept', () => {
    const { stores } = fillFromCloud([defaults[0]], cloud);
    assert.deepEqual(stores.map(s => s.key), ['STORE_A', 'STORE_B', 'STORE_C']);
  });
  it('cloud download keeps local price/formula when the cloud copy lacks them', () => {
    const out = keepLocal(defaults, cloud);
    assert.equal(out[2].salePrice, 610);
    assert.equal(out[2].formulaId, 'f2');
  });
  it('cloud download still wins when it has real values', () => {
    const out = keepLocal(cloud, [{ key: 'STORE_A', salePrice: 1, formulaId: 'old' }]);
    assert.equal(out[0].salePrice, 520);
    assert.equal(out[0].formulaId, 'f1');
  });
});
