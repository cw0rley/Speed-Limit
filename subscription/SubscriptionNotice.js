// Banner for the "notice" release: tells current users the app is becoming a
// subscription, and lets them start the trial early. "Not now" hides it for
// NOTICE_SNOOZE_DAYS.

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SUBSCRIPTION_MODE, formatStartDate } from './config';
import { useSubscription } from './store';

const SNOOZE_KEY = '@speed_limit_sub_notice_snoozed_at';
const NOTICE_SNOOZE_DAYS = 3;

export function noticeText(dateText) {
  return dateText
    ? `Speed Limit becomes a subscription on ${dateText}. Start your free trial any time.`
    : 'Speed Limit is becoming a subscription soon. Start your free trial any time.';
}

export default function SubscriptionNotice({ onSeePlans }) {
  const sub = useSubscription();
  const [snoozed, setSnoozed] = useState(true); // hidden until storage is read

  useEffect(() => {
    AsyncStorage.getItem(SNOOZE_KEY)
      .then((v) => {
        const at = Number(v) || 0;
        setSnoozed(Date.now() - at < NOTICE_SNOOZE_DAYS * 24 * 3600 * 1000);
      })
      .catch(() => setSnoozed(false));
  }, []);

  if (SUBSCRIPTION_MODE !== 'notice' || sub.status === 'disabled' || sub.active || snoozed) {
    return null;
  }

  const snooze = () => {
    setSnoozed(true);
    AsyncStorage.setItem(SNOOZE_KEY, String(Date.now())).catch(() => {});
  };

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.text}>{noticeText(formatStartDate())}</Text>
      <View style={styles.row}>
        <TouchableOpacity onPress={snooze} style={styles.btn}>
          <Text style={styles.later}>Not now</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onSeePlans} style={[styles.btn, styles.primary]}>
          <Text style={styles.primaryText}>See plans</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#111a2e',
    borderBottomWidth: 1,
    borderBottomColor: '#2563eb',
    paddingTop: 54,
    paddingBottom: 10,
    paddingHorizontal: 16,
  },
  text: { color: '#e5e7eb', fontSize: 14, lineHeight: 19 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8, gap: 8 },
  btn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8 },
  later: { color: '#8a97a7', fontSize: 14 },
  primary: { backgroundColor: '#2563eb' },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
