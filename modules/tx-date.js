// Effective ("original") date of a sale/collection for customer history screens.
// Sales store `date` = day the entry was keyed in and `supplyDate` = the date the user picked,
// so history must show and sort by supplyDate (falling back to date, then creation time).
import { editDateValue } from './edit-date.js';

export function txEffectiveDate(t) {
  return editDateValue(t, ['supplyDate', 'date', 'createdAt', 'timestamp']);
}

// Time of entry is only meaningful next to the entry date, not next to a backdated supply date.
export function txShowTime(t) {
  return !t || !t.supplyDate || t.supplyDate === t.date;
}

// Ascending chronological order: effective date, then creation timestamp.
export function txChronoCompare(a, b) {
  const da = txEffectiveDate(a), db = txEffectiveDate(b);
  if (da !== db) return da < db ? -1 : 1;
  return (Number(a && a.timestamp) || 0) - (Number(b && b.timestamp) || 0);
}
