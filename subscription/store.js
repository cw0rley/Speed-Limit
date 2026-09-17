// Subscription state backed by RevenueCat, exposed as a small external store
// (read with useSubscription()).
//
// state.status:
//   'disabled'  — SUBSCRIPTION_MODE is 'off', or no RevenueCat key / native
//                 module (Expo Go, web). The app is never blocked in this state.
//   'loading'   — configuring / first customer-info fetch
//   'ready'     — `active` is authoritative
//   'error'     — couldn't reach the store; `active` reflects the last known value

import { useSyncExternalStore } from 'react';
import { Linking, Platform } from 'react-native';
import { ENTITLEMENT_ID, REVENUECAT_API_KEY, SUBSCRIPTION_MODE } from './config';

let Purchases = null;
let INTRO_ELIGIBLE = 2;
try {
  // Lazy so a missing native module (Expo Go without preview mode, web) can't crash the app.
  const mod = require('react-native-purchases');
  Purchases = mod.default;
  INTRO_ELIGIBLE = mod.INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE;
} catch (_) {
  Purchases = null;
}

let state = {
  status: 'disabled',
  active: false,
  offering: null, // RevenueCat current offering
  trialEligible: {}, // productId -> true | false
  busy: false, // a purchase or restore is in progress
  error: null,
};
const listeners = new Set();

function set(patch) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useSubscription() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state
  );
}

export const getSubscription = () => state;

const isActive = (info) => Boolean(info && info.entitlements && info.entitlements.active[ENTITLEMENT_ID]);

let initialized = false;
export async function initSubscriptions() {
  if (initialized) return;
  initialized = true;
  if (SUBSCRIPTION_MODE === 'off' || !Purchases || !REVENUECAT_API_KEY) return; // stays 'disabled'

  set({ status: 'loading' });
  try {
    if (__DEV__) Purchases.setLogLevel('DEBUG').catch(() => {});
    Purchases.configure({ apiKey: REVENUECAT_API_KEY });
    Purchases.addCustomerInfoUpdateListener((info) => set({ active: isActive(info) }));
    const info = await Purchases.getCustomerInfo();
    set({ active: isActive(info), status: 'ready', error: null });
    await loadOffering();
  } catch (e) {
    set({ status: 'error', error: 'Could not reach the App Store. Check your connection.' });
  }
}

export async function loadOffering() {
  if (!Purchases || state.status === 'disabled') return;
  try {
    const offerings = await Purchases.getOfferings();
    const offering = offerings.current;
    let trialEligible = {};
    if (offering && Platform.OS === 'ios') {
      const ids = offering.availablePackages.map((p) => p.product.identifier);
      const result = await Purchases.checkTrialOrIntroductoryPriceEligibility(ids);
      for (const id of ids) trialEligible[id] = result[id] && result[id].status === INTRO_ELIGIBLE;
    } else if (offering) {
      // Google Play only includes a free phase when the user is eligible.
      for (const p of offering.availablePackages) trialEligible[p.product.identifier] = true;
    }
    set({ offering, trialEligible, error: offering ? null : 'No subscription options are available right now.' });
  } catch (e) {
    set({ error: 'Could not load subscription options. Check your connection.' });
  }
}

// Returns true if the entitlement is now active.
export async function purchase(pkg) {
  if (!Purchases || state.busy) return false;
  set({ busy: true, error: null });
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    const active = isActive(customerInfo);
    set({ active, busy: false });
    return active;
  } catch (e) {
    const cancelled =
      e && (e.userCancelled || e.code === Purchases.PURCHASES_ERROR_CODE?.PURCHASE_CANCELLED_ERROR);
    set({ busy: false, error: cancelled ? null : (e && e.message) || 'The purchase did not complete.' });
    return false;
  }
}

// Returns true if a subscription was found and restored.
export async function restore() {
  if (!Purchases || state.busy) return false;
  set({ busy: true, error: null });
  try {
    const info = await Purchases.restorePurchases();
    const active = isActive(info);
    set({
      active,
      busy: false,
      error: active ? null : 'No active subscription was found for this account.',
    });
    return active;
  } catch (e) {
    set({ busy: false, error: (e && e.message) || 'Restore failed. Try again.' });
    return false;
  }
}

export async function manageSubscription() {
  try {
    if (Purchases && Platform.OS === 'ios') {
      await Purchases.showManageSubscriptions();
      return;
    }
  } catch (_) {
    // fall through to the store page
  }
  Linking.openURL(
    Platform.OS === 'ios'
      ? 'https://apps.apple.com/account/subscriptions'
      : 'https://play.google.com/store/account/subscriptions'
  ).catch(() => {});
}

// RevenueCat's anonymous app user id — sent to the Worker so it can check the
// entitlement before spending a TomTom call (roadmap Phase 2).
export async function getAppUserId() {
  if (!Purchases || state.status === 'disabled') return null;
  try {
    return await Purchases.getAppUserID();
  } catch (_) {
    return null;
  }
}

// Does the app need to be blocked by the paywall right now?
export function paywallRequired(s = state) {
  if (SUBSCRIPTION_MODE !== 'required') return false;
  if (s.status === 'disabled') return false; // misconfigured build: never lock users out
  if (s.status === 'loading') return false; // decided once customer info arrives
  // Couldn't reach the store: fail open rather than lock out a paying user.
  // (RevenueCat caches customer info, so this is rare.)
  if (s.status === 'error') return false;
  return !s.active;
}
