import test from 'node:test';
import assert from 'node:assert/strict';
import { editDateValue } from '../modules/edit-date.js';

test('uses the record date when it is a valid YYYY-MM-DD', () => {
  assert.equal(editDateValue({ date: '2026-03-05', createdAt: '2026-04-01T10:00:00Z' }), '2026-03-05');
});
test('falls back to creation time when date is missing or empty', () => {
  const created = new Date(2026, 2, 5, 14, 30).toISOString();
  assert.equal(editDateValue({ createdAt: created }), '2026-03-05');
  assert.equal(editDateValue({ date: '', createdAt: created }), '2026-03-05');
});
test('converts timestamps and non-standard strings to a local date', () => {
  assert.equal(editDateValue({ date: new Date(2026, 0, 9, 8, 0).toISOString() }), '2026-01-09');
  assert.equal(editDateValue({ date: new Date(2026, 0, 9, 8, 0).getTime() }), '2026-01-09');
});
test('rejects impossible dates and falls through', () => {
  assert.equal(editDateValue({ date: '2026-02-31', createdAt: new Date(2026, 5, 2, 9).toISOString() }), '2026-06-02');
});
test('honours a custom field order (supplyDate first)', () => {
  assert.equal(editDateValue({ supplyDate: '2026-07-01', date: '2026-07-09' }, ['supplyDate', 'date']), '2026-07-01');
});
test('returns empty string when nothing usable', () => {
  assert.equal(editDateValue(null), '');
  assert.equal(editDateValue({}), '');
});
