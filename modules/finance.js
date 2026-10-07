const num = (v, d = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

export function fmtNum(value, maxDecimals = 2) {
  const n = num(value, 0);
  if (!isFinite(n)) return '0';
  const p = Math.pow(10, maxDecimals);
  const rounded = Math.round((Math.abs(n) + Number.EPSILON) * p) / p;
  const [intPart, fracRaw = ''] = rounded.toFixed(maxDecimals).split('.');
  const frac = fracRaw.replace(/0+$/, '');
  let grouped = intPart;
  if (intPart.length > 3) {
    grouped = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + intPart.slice(-3);
  }
  const body = frac ? grouped + '.' + frac : grouped;
  return n < 0 && rounded !== 0 ? '-' + body : body;
}

export function round2(v) {
  const n = Number(v);
  return isFinite(n) ? Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100 : 0;
}

export function lockedUnitPrice(t) {
  if (!t) return 0;
  const up = num(t.unitPrice, 0);
  if (up > 0) return up;
  const qty = num(t.quantity, 0);
  const tv = num(t.totalValue, 0);
  return qty > 0 && tv > 0 ? tv / qty : 0;
}

export function lockedSaleValue(t) {
  if (!t) return null;
  const qty = num(t.quantity, 0);
  if (qty <= 0) return num(t.totalValue, 0);
  const up = num(t.unitPrice, 0);
  if (up > 0) return round2(qty * up);
  const tv = num(t.totalValue, 0);
  return tv > 0 ? round2(tv) : null;
}

export function debtNeedsGross(t) {
  if (!t || t.creditReceived) return false;
  if (t.transactionType === 'OLD_DEBT') return true;
  return t.paymentType === 'CREDIT' && !(t.isMerged && typeof t.creditValue === 'number');
}

export function debtDelta(t, grossValue) {
  if (!t) return 0;
  const partial = num(t.partialPaymentReceived, 0);
  const gross = num(grossValue, 0);
  if (t.transactionType === 'OLD_DEBT') {
    return t.creditReceived ? 0 : round2(Math.max(0, gross - partial));
  }
  if (t.paymentType === 'CREDIT' && !t.creditReceived) {
    if (t.isMerged && typeof t.creditValue === 'number') return round2(Math.max(0, t.creditValue));
    return round2(Math.max(0, gross - partial));
  }
  if (t.paymentType === 'COLLECTION' || t.paymentType === 'PARTIAL_PAYMENT') {
    return round2(-Math.max(0, num(t.totalValue, 0)));
  }
  return 0;
}

export function localDateStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
