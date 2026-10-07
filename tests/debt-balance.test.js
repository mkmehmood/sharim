import test from 'node:test';
import assert from 'node:assert/strict';

import * as mod from '../modules/finance.js';
const { debtDelta, debtNeedsGross, round2, fmtNum, lockedSaleValue, lockedUnitPrice } = mod;

test('helpers load', () => {
  assert.equal(typeof debtDelta, 'function');
});

test('credit sale adds gross minus partial payment', () => {
  assert.equal(debtDelta({ paymentType: 'CREDIT', partialPaymentReceived: 200 }, 1000), 800);
});

test('paid credit and cash sales add nothing', () => {
  assert.equal(debtDelta({ paymentType: 'CREDIT', creditReceived: true }, 1000), 0);
  assert.equal(debtDelta({ paymentType: 'CASH' }, 1000), 0);
});

test('merged credit uses creditValue', () => {
  const t = { paymentType: 'CREDIT', isMerged: true, creditValue: 300, totalValue: 900 };
  assert.equal(debtNeedsGross(t), false);
  assert.equal(debtDelta(t, 900), 300);
});

test('old debt counts unless received', () => {
  assert.equal(debtDelta({ transactionType: 'OLD_DEBT', paymentType: 'CREDIT' }, 500), 500);
  assert.equal(debtDelta({ transactionType: 'OLD_DEBT', paymentType: 'CREDIT', creditReceived: true }, 500), 0);
});

test('collections reduce debt', () => {
  assert.equal(debtDelta({ paymentType: 'COLLECTION', totalValue: 250 }, 0), -250);
});

test('a sale never produces negative debt from over-recorded partial payment', () => {
  assert.equal(debtDelta({ paymentType: 'CREDIT', partialPaymentReceived: 1500 }, 1000), 0);
});

test('floating point drift is removed', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1234.5649999), 1234.56);
});

test('collection order does not change the final balance', () => {
  const rows = [
    { paymentType: 'COLLECTION', totalValue: 400 },
    { paymentType: 'CREDIT' , _g: 1000 },
    { paymentType: 'CREDIT', _g: 250.1 },
  ];
  const sum = (arr) => Math.max(0, arr.reduce((a, t) => round2(a + debtDelta(t, t._g || 0)), 0));
  assert.equal(sum(rows), sum([...rows].reverse()));
  assert.equal(sum(rows), 850.1);
});

test('fmtNum uses Indian grouping and hides .00', () => {
  assert.equal(fmtNum(22050790), '2,20,50,790');
  assert.equal(fmtNum(1234.5), '1,234.5');
  assert.equal(fmtNum(1000.00), '1,000');
});

test('sale value is locked to the price recorded at sale time', () => {
  assert.equal(lockedSaleValue({ quantity: 10, unitPrice: 250, totalValue: 2500 }), 2500);
  assert.equal(lockedSaleValue({ quantity: 10, unitPrice: 300, totalValue: 2500 }), 3000);
});

test('legacy records without unitPrice fall back to stored totalValue', () => {
  assert.equal(lockedSaleValue({ quantity: 4, totalValue: 1000 }), 1000);
  assert.equal(lockedUnitPrice({ quantity: 4, totalValue: 1000 }), 250);
});

test('records with no stored price defer to the live price lookup', () => {
  assert.equal(lockedSaleValue({ quantity: 4 }), null);
  assert.equal(lockedUnitPrice({ quantity: 4 }), 0);
});

test('zero-quantity records use their stored value', () => {
  assert.equal(lockedSaleValue({ quantity: 0, totalValue: 500 }), 500);
});

test('localDateStr uses the local calendar day, not UTC', () => {
  const { localDateStr } = mod;
  assert.equal(localDateStr(new Date(2026, 8, 29, 0, 30)), '2026-09-29');
  assert.equal(localDateStr(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});
