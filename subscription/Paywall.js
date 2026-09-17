// Subscription paywall. Shown full-screen (no close button) when the app
// requires a subscription, or as a dismissible sheet from the notice banner /
// Settings. Includes everything App Review 3.1.1 / 3.1.2 asks for: price and
// period, trial terms, auto-renewal text, Restore Purchases, Terms and Privacy.

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { PRIVACY_URL, TERMS_URL } from './config';
import { annualSavingsPercent, describePackage, legalText, sortPackages } from './offer';
import { loadOffering, purchase, restore, useSubscription } from './store';

const BENEFITS = [
  'Your speed and the posted limit, side by side',
  'Live speed-limit sign on CarPlay and your Lock Screen',
  'Custom over-the-limit color alerts',
];

export default function Paywall({ onClose, onSubscribed }) {
  const sub = useSubscription();
  const packages = useMemo(
    () => sortPackages(sub.offering ? sub.offering.availablePackages : []),
    [sub.offering]
  );
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    if (!sub.offering) loadOffering();
  }, []);

  useEffect(() => {
    if (!selectedId && packages.length) setSelectedId(packages[0].identifier);
  }, [packages, selectedId]);

  useEffect(() => {
    if (sub.active && onSubscribed) onSubscribed();
  }, [sub.active]);

  const annual = packages.find((p) => p.packageType === 'ANNUAL');
  const monthly = packages.find((p) => p.packageType === 'MONTHLY');
  const savings = annualSavingsPercent(annual, monthly);
  const described = packages.map((p) => ({
    pkg: p,
    d: describePackage(p, sub.trialEligible[p.product.identifier] ?? null),
  }));
  const selected = described.find((x) => x.pkg.identifier === selectedId);
  const anyTrial = described.some((x) => x.d.trialDays);

  return (
    <View style={styles.root}>
      {onClose ? (
        <TouchableOpacity
          style={styles.close}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.closeText}>{'✕'}</Text>
        </TouchableOpacity>
      ) : null}

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.sign}>
          <Text style={styles.signLabel}>SPEED{'\n'}LIMIT</Text>
          <Text style={styles.signValue}>PRO</Text>
        </View>

        <Text style={styles.title}>Speed Limit subscription</Text>
        <Text style={styles.subtitle}>Everything in the app, on every drive.</Text>

        <View style={styles.benefits}>
          {BENEFITS.map((b) => (
            <View key={b} style={styles.benefitRow}>
              <Text style={styles.check}>{'✓'}</Text>
              <Text style={styles.benefitText}>{b}</Text>
            </View>
          ))}
        </View>

        {!sub.offering && !sub.error ? (
          <ActivityIndicator color="#fff" style={{ marginVertical: 24 }} />
        ) : null}

        {described.map(({ pkg, d }) => {
          const isSel = pkg.identifier === selectedId;
          return (
            <TouchableOpacity
              key={pkg.identifier}
              style={[styles.option, isSel && styles.optionSelected]}
              onPress={() => setSelectedId(pkg.identifier)}
              accessibilityRole="radio"
              accessibilityState={{ checked: isSel }}
            >
              <View style={{ flex: 1 }}>
                <View style={styles.optionHeader}>
                  <Text style={styles.optionTitle}>{d.title}</Text>
                  {pkg.packageType === 'ANNUAL' && savings ? (
                    <Text style={styles.badge}>SAVE {savings}%</Text>
                  ) : null}
                </View>
                <Text style={styles.optionPrice}>{d.priceLine}</Text>
                {d.perMonth ? <Text style={styles.optionSub}>{d.perMonth}</Text> : null}
                {d.trialLine ? <Text style={styles.optionTrial}>{d.trialLine}</Text> : null}
              </View>
              <View style={[styles.radio, isSel && styles.radioOn]} />
            </TouchableOpacity>
          );
        })}

        {sub.error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{sub.error}</Text>
            {!sub.offering ? (
              <TouchableOpacity onPress={loadOffering}>
                <Text style={styles.link}>Try again</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.cta, (!selected || sub.busy) && styles.ctaDisabled]}
          disabled={!selected || sub.busy}
          onPress={() => selected && purchase(selected.pkg)}
          accessibilityRole="button"
        >
          {sub.busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.ctaText}>{selected ? selected.d.cta : 'Subscribe'}</Text>
          )}
        </TouchableOpacity>
        {selected ? <Text style={styles.renewal}>{selected.d.renewal}</Text> : null}

        <View style={styles.links}>
          <TouchableOpacity onPress={restore} disabled={sub.busy}>
            <Text style={styles.link}>Restore Purchases</Text>
          </TouchableOpacity>
          <Text style={styles.dot}>{'·'}</Text>
          <TouchableOpacity onPress={() => Linking.openURL(TERMS_URL).catch(() => {})}>
            <Text style={styles.link}>Terms of Use</Text>
          </TouchableOpacity>
          {PRIVACY_URL ? (
            <>
              <Text style={styles.dot}>{'·'}</Text>
              <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_URL).catch(() => {})}>
                <Text style={styles.link}>Privacy Policy</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>

        <Text style={styles.legal}>{legalText(Platform.OS, anyTrial)}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0d12' },
  scroll: { paddingHorizontal: 24, paddingTop: 64, paddingBottom: 40 },
  close: { position: 'absolute', top: 52, right: 20, zIndex: 2 },
  closeText: { color: '#8a97a7', fontSize: 22 },
  sign: {
    alignSelf: 'center',
    backgroundColor: '#fff',
    borderColor: '#000',
    borderWidth: 4,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 18,
    alignItems: 'center',
    marginBottom: 20,
  },
  signLabel: { color: '#000', fontSize: 14, fontWeight: '800', textAlign: 'center', lineHeight: 16 },
  signValue: { color: '#000', fontSize: 34, fontWeight: '900' },
  title: { color: '#fff', fontSize: 26, fontWeight: '800', textAlign: 'center' },
  subtitle: { color: '#8a97a7', fontSize: 15, textAlign: 'center', marginTop: 6 },
  benefits: { marginVertical: 24 },
  benefitRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  check: { color: '#22c55e', fontSize: 16, fontWeight: '800', width: 24 },
  benefitText: { color: '#e5e7eb', fontSize: 15, flex: 1, lineHeight: 20 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#2a2f3a',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    backgroundColor: '#12151c',
  },
  optionSelected: { borderColor: '#2563eb', backgroundColor: '#111a2e' },
  optionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  optionTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  badge: {
    color: '#0b0d12',
    backgroundColor: '#FFD700',
    fontSize: 11,
    fontWeight: '800',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  optionPrice: { color: '#e5e7eb', fontSize: 15, marginTop: 4 },
  optionSub: { color: '#8a97a7', fontSize: 13, marginTop: 2 },
  optionTrial: { color: '#22c55e', fontSize: 13, marginTop: 4, fontWeight: '600' },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#4b5563',
    marginLeft: 12,
  },
  radioOn: { borderColor: '#2563eb', backgroundColor: '#2563eb' },
  errorBox: { alignItems: 'center', marginVertical: 8 },
  errorText: { color: '#fca5a5', fontSize: 14, textAlign: 'center' },
  cta: {
    backgroundColor: '#2563eb',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  ctaDisabled: { opacity: 0.5 },
  ctaText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  renewal: { color: '#8a97a7', fontSize: 13, textAlign: 'center', marginTop: 8 },
  links: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 20,
  },
  link: { color: '#60a5fa', fontSize: 14, paddingVertical: 4 },
  dot: { color: '#4b5563', marginHorizontal: 8 },
  legal: { color: '#6b7280', fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 16 },
});
