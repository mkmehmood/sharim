import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../modules/business.js', import.meta.url), 'utf8');
function grab(name) {
  const start = src.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1).replace('export ', '');
  }
  throw new Error('unbalanced ' + name);
}
const NOW = 1_800_000_000_000;
const { ensure } = new Function('generateUUID', 'getTimestamp',
  `${grab('validateTimestamp')}\n${grab('ensureRecordIntegrity')}\nreturn { ensure: ensureRecordIntegrity };`
)((p) => p + '_id', () => NOW);

describe('ensureRecordIntegrity keeps its repair mode (used by sync merge/restore paths)', () => {
  const CREATED = 1_700_000_000_000;
  it('repair mode: missing updatedAt falls back to createdAt, never "now"', () => {
    const r = ensure({ id: 'a', createdAt: CREATED }, false, true);
    assert.equal(r.updatedAt, CREATED);
    assert.equal(r.timestamp, CREATED);
  });
  it('normal mode: missing updatedAt becomes now', () => {
    const r = ensure({ id: 'a', createdAt: CREATED }, false, false);
    assert.equal(r.updatedAt, NOW);
  });
  it('repair mode accepts future-dated timestamps without rewriting them', () => {
    const future = Date.now() + 10 * 24 * 3600 * 1000;
    const r = ensure({ id: 'a', createdAt: future, updatedAt: future, timestamp: future }, false, true);
    assert.equal(r.createdAt, future);
    assert.equal(r.updatedAt, future);
  });
  it('assigns an id when missing and fixes updatedAt < createdAt', () => {
    const r = ensure({ createdAt: CREATED, updatedAt: CREATED - 5000 }, false, true);
    assert.ok(r.id);
    assert.equal(r.updatedAt, CREATED);
  });
});
