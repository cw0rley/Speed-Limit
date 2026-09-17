import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annualSavingsPercent,
  describePackage,
  legalText,
  sortPackages,
  trialDays,
} from '../offer.js';

const iosProduct = (id, price, priceString, extra = {}) => ({
  identifier: id,
  title: id,
  price,
  priceString,
  pricePerMonthString: extra.pricePerMonthString ?? null,
  introPrice: extra.introPrice ?? null,
  defaultOption: null,
});
const weekTrial = { price: 0, priceString: '$0.00', cycles: 1, period: 'P1W', periodUnit: 'WEEK', periodNumberOfUnits: 1 };

const monthly = {
  identifier: '$rc_monthly',
  packageType: 'MONTHLY',
  product: iosProduct('sl_monthly', 2.99, '$2.99', { introPrice: weekTrial }),
};
const annual = {
  identifier: '$rc_annual',
  packageType: 'ANNUAL',
  product: iosProduct('sl_annual', 24.99, '$24.99', { introPrice: weekTrial, pricePerMonthString: '$2.08' }),
};

test('trialDays: App Store intro price and Google free phase', () => {
  assert.equal(trialDays(monthly.product), 7);
  assert.equal(trialDays({ introPrice: { price: 0.99, periodUnit: 'MONTH', periodNumberOfUnits: 1 } }), null);
  assert.equal(
    trialDays({ introPrice: null, defaultOption: { freePhase: { billingPeriod: { unit: 'DAY', value: 3 } } } }),
    3
  );
  assert.equal(trialDays(null), null);
});

test('describePackage: eligible user sees the trial', () => {
  const d = describePackage(annual, true);
  assert.equal(d.title, 'Yearly');
  assert.equal(d.priceLine, '$24.99 / year');
  assert.equal(d.perMonth, '$2.08 / month');
  assert.equal(d.trialLine, '1-week free trial, then $24.99 / year');
  assert.equal(d.cta, 'Start 1-week free trial');
  assert.equal(d.renewal, 'Renews yearly at $24.99 until cancelled.');
});

test('describePackage: ineligible or unknown user is never promised a trial', () => {
  for (const eligible of [false, null]) {
    const d = describePackage(monthly, eligible);
    assert.equal(d.trialDays, null);
    assert.equal(d.trialLine, null);
    assert.equal(d.cta, 'Subscribe for $2.99 / month');
  }
});

test('annual savings and ordering', () => {
  assert.equal(annualSavingsPercent(annual, monthly), 30); // 24.99 vs 35.88
  assert.equal(annualSavingsPercent(annual, null), null);
  assert.deepEqual(sortPackages([monthly, annual]).map((p) => p.packageType), ['ANNUAL', 'MONTHLY']);
});

test('legal text names the right store and trial wording', () => {
  const ios = legalText('ios', true);
  assert.match(ios, /Apple ID/);
  assert.match(ios, /when the free trial ends/);
  assert.match(ios, /24 hours before the end/);
  const android = legalText('android', false);
  assert.match(android, /Google Play/);
  assert.match(android, /when you confirm the purchase/);
});
