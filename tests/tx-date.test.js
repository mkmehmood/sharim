import test from 'node:test';
import assert from 'node:assert/strict';
import { txEffectiveDate, txShowTime, txChronoCompare } from '../modules/tx-date.js';

// Keyed in on 6 Oct 2026 for a sale that happened on 3 Oct 2026.
const backdated = { id: 'a', date: '2026-10-06', supplyDate: '2026-10-03', timestamp: 3000, time: '10:00 AM' };
const normal    = { id: 'b', date: '2026-10-05', timestamp: 2000, time: '09:00 AM' };
const sameDay   = { id: 'c', date: '2026-10-05', supplyDate: '2026-10-05', timestamp: 1000 };

test('effective date prefers the picked supply date over the entry date', () => {
  assert.equal(txEffectiveDate(backdated), '2026-10-03');
  assert.equal(txEffectiveDate(normal), '2026-10-05');
});
test('falls back to creation time when no date fields exist', () => {
  const created = new Date(2026, 9, 2, 12).getTime();
  assert.equal(txEffectiveDate({ createdAt: created }), '2026-10-02');
});
test('entry time is hidden next to a backdated supply date only', () => {
  assert.equal(txShowTime(backdated), false);
  assert.equal(txShowTime(normal), true);
  assert.equal(txShowTime(sameDay), true);
});
test('chronological order follows the original date, not the entry time', () => {
  const asc = [normal, backdated, sameDay].sort(txChronoCompare).map(t => t.id);
  // 3 Oct (backdated), then the two 5 Oct entries ordered by creation timestamp
  assert.deepEqual(asc, ['a', 'c', 'b']);
  const desc = [normal, backdated, sameDay].sort((x, y) => txChronoCompare(y, x)).map(t => t.id);
  assert.deepEqual(desc, ['b', 'c', 'a']);
});
