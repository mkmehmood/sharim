// Resolve the date to show in a date picker when an existing record is opened for editing.
// Uses the record's original date; falls back to its creation time so the picker is never empty.
// Returns a local 'YYYY-MM-DD' string (the only format <input type="date"> accepts), or ''.
const _pad = n => String(n).padStart(2, '0');
const _local = d => d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate());

export function editDateValue(rec, fields = ['date', 'createdAt', 'timestamp']) {
  if (!rec) return '';
  for (const f of fields) {
    const v = rec[f];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, d] = v.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return v;
      continue;
    }
    const dt = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
    if (!isNaN(dt.getTime())) return _local(dt);
  }
  return '';
}
