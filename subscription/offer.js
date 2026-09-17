// Pure helpers that turn RevenueCat packages into paywall copy. No React
// Native imports, so they run under `npm test`.

const UNIT_DAYS = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };

// Free-trial length in days, or null.
//  - App Store: product.introPrice with price 0 (only shown if eligible —
//    eligibility is checked separately).
//  - Google Play: defaultOption.freePhase (Play only offers it to eligible
//    users, so presence == eligible).
export function trialDays(product) {
  if (!product) return null;
  const intro = product.introPrice;
  if (intro && intro.price === 0 && UNIT_DAYS[intro.periodUnit]) {
    return UNIT_DAYS[intro.periodUnit] * (intro.periodNumberOfUnits || 1) * (intro.cycles || 1);
  }
  const free = product.defaultOption && product.defaultOption.freePhase;
  const bp = free && free.billingPeriod;
  if (bp && UNIT_DAYS[bp.unit]) return UNIT_DAYS[bp.unit] * (bp.value || 1);
  return null;
}

const PERIOD = {
  ANNUAL: { noun: 'year', adverb: 'yearly' },
  MONTHLY: { noun: 'month', adverb: 'monthly' },
  WEEKLY: { noun: 'week', adverb: 'weekly' },
};

function trialPhrase(days) {
  if (days === 7) return '1-week';
  if (days % 7 === 0) return `${days / 7}-week`;
  if (days === 30) return '1-month';
  return `${days}-day`;
}

// Annual vs. 12 × monthly, as a whole percentage (or null).
export function annualSavingsPercent(annual, monthly) {
  const a = annual && annual.product && annual.product.price;
  const m = monthly && monthly.product && monthly.product.price;
  if (!a || !m) return null;
  const pct = Math.round((1 - a / (m * 12)) * 100);
  return pct >= 5 ? pct : null;
}

// Everything the paywall needs to show for one package.
//   trialEligible: true / false / null (unknown — don't promise a trial)
export function describePackage(pkg, trialEligible) {
  const product = pkg.product;
  const period = PERIOD[pkg.packageType] || { noun: 'period', adverb: 'recurring' };
  const days = trialEligible === true ? trialDays(product) : null;
  const price = product.priceString;
  return {
    id: pkg.identifier,
    packageType: pkg.packageType,
    title: period.adverb === 'yearly' ? 'Yearly' : period.adverb === 'monthly' ? 'Monthly' : product.title,
    priceLine: `${price} / ${period.noun}`,
    perMonth: pkg.packageType === 'ANNUAL' && product.pricePerMonthString
      ? `${product.pricePerMonthString} / month`
      : null,
    trialDays: days,
    trialLine: days ? `${trialPhrase(days)} free trial, then ${price} / ${period.noun}` : null,
    cta: days ? `Start ${trialPhrase(days)} free trial` : `Subscribe for ${price} / ${period.noun}`,
    renewal: `Renews ${period.adverb} at ${price} until cancelled.`,
  };
}

// Sort for display: annual first, then monthly, then anything else.
export function sortPackages(packages) {
  const rank = { ANNUAL: 0, MONTHLY: 1 };
  return [...(packages || [])].sort(
    (a, b) => (rank[a.packageType] ?? 9) - (rank[b.packageType] ?? 9)
  );
}

// Store-specific fine print required on the paywall (App Review 3.1.2).
export function legalText(platform, anyTrial) {
  const store = platform === 'ios' ? 'Apple ID' : 'Google Play';
  const manage = platform === 'ios' ? 'App Store account settings' : 'Google Play subscriptions';
  return (
    (anyTrial
      ? `Payment is charged to your ${store} account when the free trial ends, unless you cancel before then. `
      : `Payment is charged to your ${store} account when you confirm the purchase. `) +
    'The subscription renews automatically unless cancelled at least 24 hours before the end of ' +
    'the current period; your account is charged for renewal within 24 hours before the period ends. ' +
    `You can manage or cancel it any time in your ${manage}.`
  );
}
