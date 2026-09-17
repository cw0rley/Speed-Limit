// Subscription settings. Values that change per release live in app.json
// (expo.extra.subscription) so a notice release and the paywall release differ
// only by config.
//
//   mode: 'off'      — no subscription UI at all (current store builds)
//         'notice'   — app stays free; a dismissible banner announces the switch
//                      and offers the 7-day trial early
//         'required' — no active subscription => paywall instead of the app
//   startDate:        'YYYY-MM-DD' shown in the notice
//   iosApiKey /
//   androidApiKey:    RevenueCat PUBLIC SDK keys (appl_… / goog_…). These are
//                     designed to ship inside apps; they are not secrets.
//   privacyUrl:       hosted privacy policy (required on the paywall)

import Constants from 'expo-constants';
import { Platform } from 'react-native';

const extra = (Constants.expoConfig && Constants.expoConfig.extra) || {};
const sub = extra.subscription || {};
// Only non-empty strings count as "set" (Expo can surface null config values
// as {}).
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const SUBSCRIPTION_MODE = ['off', 'notice', 'required'].includes(sub.mode) ? sub.mode : 'off';
export const SUBSCRIPTION_START_DATE = /^\d{4}-\d{2}-\d{2}$/.test(str(sub.startDate) || '')
  ? str(sub.startDate)
  : null;

export const REVENUECAT_API_KEY =
  Platform.OS === 'ios' ? str(sub.iosApiKey) : Platform.OS === 'android' ? str(sub.androidApiKey) : null;

// Entitlement configured in the RevenueCat dashboard; both products grant it.
export const ENTITLEMENT_ID = 'pro';

// Apple's standard licence agreement (used unless a custom EULA is set in
// App Store Connect).
export const TERMS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
export const PRIVACY_URL = str(sub.privacyUrl);

// Human-readable start date, e.g. "November 1, 2026".
export function formatStartDate() {
  if (!SUBSCRIPTION_START_DATE) return null;
  const [y, m, d] = SUBSCRIPTION_START_DATE.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
