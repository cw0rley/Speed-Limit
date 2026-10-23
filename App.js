import React, { useEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Linking,
  useWindowDimensions,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  ScrollView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { activateKeepAwakeAsync } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import SpeedLimitActivity from './modules/speed-limit-activity';
import { createLimitEngine } from './lookup/engine';
import { createAreaStore } from './lookup/areaStore';
import { convertLimit } from './lookup/maxspeed';
import { TOMTOM_TEST_BUILD } from './lookup/tomtom';
import Paywall from './subscription/Paywall';
import SubscriptionNotice from './subscription/SubscriptionNotice';
import {
  getAppUserId,
  initSubscriptions,
  manageSubscription,
  paywallRequired,
  restore as restorePurchases,
  useSubscription,
} from './subscription/store';

// CarPlay — lazy-require to avoid errors in Expo Go.
let HybridAutoPlay, AutoPlayInformationTemplate;
if (Platform.OS === 'ios') {
  try {
    const ap = require('@iternio/react-native-auto-play');
    HybridAutoPlay = ap.HybridAutoPlay;
    AutoPlayInformationTemplate = ap.InformationTemplate;
  } catch (_) {
    // Not available (e.g. Expo Go)
  }
}

// ---- Unit conversions ----
const MPS_TO_MPH = 2.2369362921;
const MPS_TO_KMH = 3.6;

// ---- Speed limit lookup ----
// All lookup logic lives in lookup/ (see lookup/engine.js): OpenStreetMap
// area downloads matched on the device, TomTom through the capped Worker only
// for roads OSM has no limit for. HERE was removed after it billed ~$1,000
// (CLAUDE.md); the Worker's old /here-route returns 410.

const KEEP_AWAKE_TAG = 'speed-limit-keep-awake';

const DEFAULT_THRESHOLDS = [
  { over: 3, color: '#FFD700' },   // yellow
  { over: 8, color: '#FF8C00' },   // orange
  { over: 10, color: '#FF0000' },  // red
];
const STORAGE_KEY = '@speed_limit_thresholds';

// Pure display math shared by the phone UI, the Live Activity and CarPlay.
function computeDisplay(drive, prefs) {
  const currentSpeed =
    prefs.unit === 'mph' ? drive.speedMps * MPS_TO_MPH : drive.speedMps * MPS_TO_KMH;
  const displayLimit = convertLimit(drive.limit, prefs.unit);
  const isOver = displayLimit != null && currentSpeed > displayLimit + 1; // +1 tolerance

  let speedColor = '#FFFFFF';
  const overBy = displayLimit == null ? 0 : Math.round(currentSpeed) - displayLimit;
  if (overBy > 0) {
    // Highest applicable threshold wins
    const sorted = [...prefs.thresholds].sort((a, b) => b.over - a.over);
    const hit = sorted.find((t) => overBy >= t.over);
    if (hit) speedColor = hit.color;
  }
  return { currentSpeed, displayLimit, isOver, speedColor };
}

const unitLabel = (unit) => (unit === 'mph' ? 'MPH' : 'KM/H');

// ---- Drive store ----
// Location + limit state lives at module level (not in <App>) because it is fed
// by two sources: the foreground watchPositionAsync stream and the background
// location task that keeps running while the phone is locked / on CarPlay. The
// UI reads it with useSyncExternalStore.
let drive = { speedMps: 0, accuracy: null, limit: null, driveOn: false };
let prefs = { unit: 'mph', thresholds: DEFAULT_THRESHOLDS };
const driveListeners = new Set();

function setDrive(patch) {
  drive = { ...drive, ...patch };
  driveListeners.forEach((l) => l());
  syncLiveActivity();
  syncCarPlay();
}
function setPrefs(next) {
  prefs = next;
  syncLiveActivity();
  syncCarPlay();
}
const subscribeDrive = (cb) => {
  driveListeners.add(cb);
  return () => driveListeners.delete(cb);
};
const getDrive = () => drive;

// Lookup counters are kept across launches (Settings -> Lookup stats) so real
// drives show how often a limit was found and how many TomTom calls it took.
const STATS_KEY = '@speed_limit_lookup_stats';
const STATS_SAVE_MS = 30 * 1000;
let statsSavedAt = 0;

// Last few limit changes, for diagnosing wrong/stuck limits on real drives.
// Memory only: never saved or sent anywhere, gone when the app closes.
const RECENT_CHANGES_MAX = 20;
const recentLimitChanges = [];

// OSM road data is kept on the device between drives (OSM's licence allows
// it), so a repeated route needs no download. TomTom answers are never stored.
const areaStore = createAreaStore(AsyncStorage);

// RevenueCat's id for this device, fetched once and sent with TomTom lookups
// so the Worker can confirm an active subscription (TOMTOM_ACCESS=subscribers).
let appUserId = null;

const limitEngine = createLimitEngine({
  areaStore,
  getAppUserId: () => appUserId,
  onLimit: (limit) => {
    recentLimitChanges.unshift({
      at: Date.now(),
      text: limit ? `${Math.round(limit.value)} ${limit.unit === 'mph' ? 'mph' : 'km/h'}` : '--',
      source: limit ? (limit.source === 'tomtom' ? 'TomTom' : 'OSM') : '',
      road: (limit && limit.road) || '',
    });
    if (recentLimitChanges.length > RECENT_CHANGES_MAX) recentLimitChanges.pop();
    setDrive({ limit });
  },
  onStats: (stats) => {
    const now = Date.now();
    if (now - statsSavedAt < STATS_SAVE_MS) return;
    statsSavedAt = now;
    AsyncStorage.setItem(STATS_KEY, JSON.stringify(stats)).catch(() => {});
  },
});
AsyncStorage.getItem(STATS_KEY)
  .then((raw) => raw && limitEngine.restoreStats(JSON.parse(raw)))
  .catch(() => {});

function resetLookupStats() {
  limitEngine.resetStats();
  statsSavedAt = Date.now();
  AsyncStorage.setItem(STATS_KEY, JSON.stringify(limitEngine.getStats())).catch(() => {});
}

// Drive mode switches itself off after this long without moving, so a
// forgotten session doesn't run background location (or lookups) for hours.
const DRIVE_IDLE_STOP_MS = 10 * 60 * 1000;
const MOVING_MPS = 2;
let lastMovingAt = 0;

// True while the paywall blocks the app: no map downloads or TomTom calls.
let lookupsPaused = false;

let lastLocationTs = 0;
function handleLocation(loc) {
  // Both sources can deliver the same fix; only process newer ones.
  if (!loc || loc.timestamp <= lastLocationTs) return;
  lastLocationTs = loc.timestamp;
  const { latitude, longitude, speed, heading, accuracy } = loc.coords;
  const speedMps = speed != null && speed >= 0 ? speed : 0; // m/s; null/negative = unknown
  setDrive({ speedMps, accuracy: accuracy != null ? accuracy : null });
  if (!lookupsPaused) {
    limitEngine.update({ lat: latitude, lon: longitude, heading, speed: speedMps, accuracy });
  }

  const now = Date.now();
  if (speedMps > MOVING_MPS) lastMovingAt = now;
  if (drive.driveOn && now - lastMovingAt > DRIVE_IDLE_STOP_MS) {
    stopDriveMode().catch(() => {});
  }
}

// ---- Live Activity (CarPlay Dashboard / Lock Screen / Dynamic Island) ----
// Pushes are de-duplicated, plus a heartbeat so the activity's 30 s staleDate
// doesn't expire while parked with an unchanged reading.
const LIVE_HEARTBEAT_MS = 15000;
let liveOn = false;
let liveSig = '';
let livePushedAt = 0;

function liveState() {
  const d = computeDisplay(drive, prefs);
  return {
    speed: drive.accuracy != null ? Math.round(d.currentSpeed) : null,
    limit: d.displayLimit,
    unit: unitLabel(prefs.unit),
    speedColor: d.speedColor,
    isOver: d.isOver,
  };
}

function syncLiveActivity() {
  if (!liveOn || !SpeedLimitActivity) return;
  const state = liveState();
  const sig = JSON.stringify(state);
  const now = Date.now();
  if (sig === liveSig && now - livePushedAt < LIVE_HEARTBEAT_MS) return;
  liveSig = sig;
  livePushedAt = now;
  SpeedLimitActivity.update(state).catch(() => {});
}

// ---- Drive mode: background location + Live Activity ----
const DRIVE_TASK = 'speed-limit-drive';

// Must be defined at module scope so iOS can deliver updates while backgrounded.
TaskManager.defineTask(DRIVE_TASK, ({ data, error }) => {
  if (error || !data || !data.locations || data.locations.length === 0) return;
  handleLocation(data.locations[data.locations.length - 1]);
});

const driveModeSupported = Platform.OS === 'ios' && SpeedLimitActivity != null;

// Call from the foreground (ActivityKit only allows starting an activity then).
async function startDriveMode() {
  await Location.startLocationUpdatesAsync(DRIVE_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 1000,
    distanceInterval: 0,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    // Blue status-bar pill: lets When-In-Use permission keep running in the
    // background without asking for Always.
    showsBackgroundLocationIndicator: true,
  });
  if (SpeedLimitActivity.areActivitiesEnabled()) {
    const state = liveState();
    await SpeedLimitActivity.start(state);
    liveSig = JSON.stringify(state);
    livePushedAt = Date.now();
    liveOn = true;
  }
  lastMovingAt = Date.now(); // the idle timer starts now
  setDrive({ driveOn: true });
}

async function stopDriveMode() {
  liveOn = false;
  liveSig = '';
  setDrive({ driveOn: false });
  await SpeedLimitActivity.end().catch(() => {});
  if (await Location.hasStartedLocationUpdatesAsync(DRIVE_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(DRIVE_TASK);
  }
}

// ---- CarPlay (Driving Task: template-only) ----
// Apple refused the Navigation entitlement, so the head unit can only show
// Apple's templates. We show the limit + a pointer to the Live Activity, which
// is where the custom sign graphic lives. Driving Task apps must not refresh
// more than about every 10 s, so updates are rate-limited.
//
// Driven by drive-store changes (i.e. GPS fixes), NOT by React effects or
// timers: with the phone locked, JS timers may not fire, which froze this
// screen on an old limit (reported 2026-09-18: "stuck on 55").
const CARPLAY_MIN_UPDATE_MS = 10000;
let carplayTemplate = null;
let carplaySig = '';
let carplayPushedAt = 0;

function syncCarPlay(force = false) {
  if (!carplayTemplate) return;
  const d = computeDisplay(drive, prefs);
  const limitText = d.displayLimit != null ? `${d.displayLimit} ${unitLabel(prefs.unit)}` : '--';
  const sig = `${limitText}|${drive.driveOn}`;
  if (sig === carplaySig) return;
  const now = Date.now();
  // A newer value that arrives inside the 10 s window is picked up by a later
  // fix (they come every second while moving).
  if (!force && now - carplayPushedAt < CARPLAY_MIN_UPDATE_MS) return;
  carplaySig = sig;
  carplayPushedAt = now;
  carplayTemplate.updateItems(carplayItems(limitText, drive.driveOn)).catch(() => {});
}

function carplayItems(limitText, driveOn) {
  return [
    { type: 'text', title: { text: limitText }, detailedText: { text: 'Speed limit' } },
    {
      type: 'text',
      title: { text: driveOn ? 'Live speed on your Dashboard' : 'Drive mode is off' },
      detailedText: {
        text: driveOn
          ? 'Your speed and the sign show as a Live Activity on the CarPlay Dashboard.'
          : 'Open Speed Limit on your iPhone and tap CarPlay to start.',
      },
    },
  ];
}

// Settings -> "Lookup stats": how often a limit was found while moving, and
// what it cost. Refreshes every 2 s while the settings sheet is open. Collapsed
// by default — the thresholds are what people come here for, and the numbers
// below used to push Reset off the bottom of the sheet.
function LookupStats() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState(() => limitEngine.getStats());
  useEffect(() => {
    const id = setInterval(() => setStats(limitEngine.getStats()), 2000);
    return () => clearInterval(id);
  }, []);

  const moving = stats.movingSeconds;
  const pct = (secs) => (moving > 0 ? `${Math.round((secs / moving) * 100)}%` : '–');
  const minutes = Math.round(moving / 60);
  const since = new Date(stats.since).toLocaleDateString();
  const rows = [
    ['Driving time', `${minutes} min`],
    ['Limit from OpenStreetMap', pct(stats.osmSeconds)],
    ['  inherited from same road', pct(stats.inferredSeconds || 0)],
    ['Limit from TomTom', pct(stats.tomtomSeconds)],
    ['No limit shown', pct(stats.unknownSeconds)],
    ['Map downloads (failed / timed out)', `${stats.areaFetches} (${stats.areaFailures} / ${stats.areaTimeouts || 0})`],
    ['Maps reused from device', `${stats.areaFromStore || 0}`],
    ['Limit changes', `${stats.limitChanges || 0}`],
    ['TomTom calls', `${stats.tomtomCalls}`],
    ['  found / none', `${stats.tomtomHits} / ${stats.tomtomMisses}`],
    ['  off or capped / errors', `${stats.tomtomBackoffs} / ${stats.tomtomErrors}`],
  ];

  // Collapsed line: the two numbers worth a glance — how long the stats cover
  // and how much of that time showed nothing.
  const summary = moving > 0
    ? `${minutes} min · ${pct(stats.unknownSeconds)} blank`
    : 'no driving yet';

  return (
    <View style={styles.statsBox}>
      <TouchableOpacity style={styles.statsHeader} onPress={() => setOpen(!open)}>
        <Text style={styles.statsTitle}>Lookup stats</Text>
        <Text style={styles.statsDisclosure}>{open ? 'Hide' : `${summary}  ›`}</Text>
      </TouchableOpacity>

      {open ? (
        <>
          <View style={styles.statsRow}>
            <Text style={styles.statsLabel}>Since {since}</Text>
            <TouchableOpacity onPress={() => { resetLookupStats(); setStats(limitEngine.getStats()); }}>
              <Text style={styles.statsResetInline}>Reset stats</Text>
            </TouchableOpacity>
          </View>

          {rows.map(([label, value]) => (
            <View key={label} style={styles.statsRow}>
              <Text style={styles.statsLabel}>{label}</Text>
              <Text style={styles.statsValue}>{value}</Text>
            </View>
          ))}

          <Text style={[styles.statsTitle, { marginTop: 14 }]}>Recent limit changes</Text>
          {recentLimitChanges.length === 0 ? (
            <Text style={styles.statsLabel}>None since the app started.</Text>
          ) : (
            recentLimitChanges.map((c) => (
              <View key={c.at} style={styles.statsRow}>
                <Text style={styles.statsLabel} numberOfLines={1}>
                  {new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                  {c.road ? `  ${c.road}` : ''}
                </Text>
                <Text style={styles.statsValue}>
                  {c.text}
                  {c.source ? ` · ${c.source}` : ''}
                </Text>
              </View>
            ))
          )}
        </>
      ) : null}
    </View>
  );
}

// Settings -> "Subscription": status plus the store actions App Review expects
// to be reachable outside the paywall.
function SubscriptionSettings({ onSeePlans }) {
  const sub = useSubscription();
  if (sub.status === 'disabled') return null;
  return (
    <View style={styles.statsBox}>
      <Text style={styles.statsTitle}>Subscription</Text>
      <Text style={styles.statsLabel}>
        {sub.active ? 'Active — thank you!' : 'Not subscribed'}
      </Text>
      <View style={styles.subActions}>
        {sub.active ? (
          <TouchableOpacity onPress={manageSubscription}>
            <Text style={styles.statsReset}>Manage subscription</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={onSeePlans}>
            <Text style={styles.statsReset}>See plans</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={restorePurchases} disabled={sub.busy}>
          <Text style={styles.statsReset}>Restore purchases</Text>
        </TouchableOpacity>
      </View>
      {sub.error ? <Text style={styles.errorText}>{sub.error}</Text> : null}
    </View>
  );
}

export default function App() {
  const [unit, setUnit] = useState('mph'); // 'mph' | 'kmh'

  // Always keep screen on
  useEffect(() => {
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
  }, []);

  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [editThresholds, setEditThresholds] = useState(DEFAULT_THRESHOLDS);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((val) => {
      if (val) {
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed) && parsed.length === 3) {
            setThresholds(parsed);
          }
        } catch (_) {}
      }
    });
  }, []);

  const saveThresholds = useCallback((t) => {
    setThresholds(t);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(t)).catch(() => {});
  }, []);

  // ---- Subscription ----
  const sub = useSubscription();
  const locked = paywallRequired(sub);
  const [paywallOpen, setPaywallOpen] = useState(false);
  useEffect(() => {
    initSubscriptions().then(() => {
      getAppUserId().then((id) => {
        appUserId = id;
      });
    });
  }, []);
  useEffect(() => {
    lookupsPaused = locked;
    if (locked && drive.driveOn) stopDriveMode().catch(() => {});
  }, [locked]);

  const [permStatus, setPermStatus] = useState('pending'); // pending | granted | denied
  const [errorMsg, setErrorMsg] = useState(null);
  const [driveBusy, setDriveBusy] = useState(false);

  const { speedMps, accuracy: accuracyMps, limit, driveOn } = useSyncExternalStore(
    subscribeDrive,
    getDrive
  );

  // Mirror display prefs into the module-level store (Live Activity reads them).
  useEffect(() => {
    setPrefs({ unit, thresholds });
  }, [unit, thresholds]);

  // Request permission + start streaming location
  useEffect(() => {
    let cancelled = false;
    let sub = null;
    (async () => {
      try {
        // Check existing status first — on iOS a prior denial means we must
        // send the user to Settings instead of calling request again (which
        // would silently return 'denied' without showing a prompt).
        const existing = await Location.getForegroundPermissionsAsync();
        if (cancelled) return;

        let status = existing.status;
        if (status !== 'granted') {
          if (existing.canAskAgain === false) {
            // User previously denied and the OS won't show the prompt again
            setPermStatus('denied');
            setErrorMsg('Location permission was denied. Enable it in Settings to use this app.');
            return;
          }
          const result = await Location.requestForegroundPermissionsAsync();
          if (cancelled) return;
          status = result.status;
        }

        if (status !== 'granted') {
          setPermStatus('denied');
          setErrorMsg('Location permission was denied. Enable it in Settings to use this app.');
          return;
        }
        setPermStatus('granted');

        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1000,
            distanceInterval: 1,
          },
          handleLocation
        );
        if (cancelled) sub.remove();
      } catch (e) {
        setErrorMsg('Could not start location updates: ' + e.message);
      }
    })();

    return () => {
      cancelled = true;
      if (sub) sub.remove();
    };
  }, []);

  // Drive mode survives app restarts only as a stray background task / Live
  // Activity. On launch: resume it if the location task is still running,
  // otherwise clean up any leftover activity.
  useEffect(() => {
    if (!driveModeSupported || permStatus !== 'granted') return;
    (async () => {
      const running = await Location.hasStartedLocationUpdatesAsync(DRIVE_TASK).catch(() => false);
      if (running) {
        try {
          await startDriveMode();
        } catch (_) {
          await stopDriveMode();
        }
      } else {
        await SpeedLimitActivity.end().catch(() => {});
      }
    })();
  }, [permStatus]);

  const toggleDriveMode = useCallback(async () => {
    if (driveBusy) return;
    setDriveBusy(true);
    try {
      if (driveOn) {
        await stopDriveMode();
      } else {
        if (!SpeedLimitActivity.areActivitiesEnabled()) {
          setErrorMsg('Live Activities are turned off for Speed Limit in Settings.');
        }
        await startDriveMode();
      }
    } catch (e) {
      setErrorMsg('Could not start drive mode: ' + e.message);
      await stopDriveMode();
    } finally {
      setDriveBusy(false);
    }
  }, [driveOn, driveBusy]);

  const { currentSpeed, displayLimit, isOver, speedColor } = computeDisplay(
    { speedMps, limit },
    { unit, thresholds }
  );

  // Haptic feedback on crossing the limit
  const lastOverRef = useRef(false);
  useEffect(() => {
    if (isOver && !lastOverRef.current) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
    lastOverRef.current = isOver;
  }, [isOver]);

  // ---- CarPlay (InformationTemplate): connect/disconnect only; updates are
  // pushed by syncCarPlay() from the drive store. ----
  useEffect(() => {
    if (!HybridAutoPlay || !AutoPlayInformationTemplate) return;

    const onConnect = () => {
      const tpl = new AutoPlayInformationTemplate({
        title: { text: 'Speed Limit' },
        items: carplayItems('--', false),
      });
      tpl.setRootTemplate();
      carplayTemplate = tpl;
      carplaySig = '';
      syncCarPlay(true); // fill in the current values right away
    };
    const onDisconnect = () => {
      carplayTemplate = null;
    };

    const cleanupConnect = HybridAutoPlay.addListener('didConnect', onConnect);
    const cleanupDisconnect = HybridAutoPlay.addListener('didDisconnect', onDisconnect);

    // If already connected when component mounts
    if (HybridAutoPlay.isConnected()) {
      onConnect();
    }

    return () => {
      cleanupConnect();
      cleanupDisconnect();
    };
  }, []);

  const sourceName = limit && limit.source === 'tomtom' ? 'TomTom' : 'OpenStreetMap';
  const statusLine =
    (accuracyMps != null ? `GPS ±${Math.round(accuracyMps)} m` : 'Acquiring GPS…') +
    `  ·  Limits: ${sourceName}` +
    (TOMTOM_TEST_BUILD ? '  ·  TEST BUILD' : '');

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  // Subscription required and not active: the paywall is the whole app.
  if (locked) {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <Paywall />
      </View>
    );
  }

  // Waiting for permission — show a loading indicator
  if (permStatus === 'pending') {
    return (
      <View style={[styles.container, { backgroundColor: '#0b0d12', justifyContent: 'center', alignItems: 'center' }]}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#fff" style={{ marginBottom: 20 }} />
        <Text style={{ color: '#aaa', fontSize: 16, textAlign: 'center', paddingHorizontal: 30 }}>
          Waiting for location permission…
        </Text>
      </View>
    );
  }

  // Permission denied — show a full-screen message with an Open Settings button
  if (permStatus === 'denied') {
    return (
      <View style={[styles.container, { backgroundColor: '#0b0d12', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30 }]}>
        <StatusBar style="light" />
        <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 16 }}>
          Location Permission Required
        </Text>
        <Text style={{ color: '#aaa', fontSize: 15, textAlign: 'center', lineHeight: 22, marginBottom: 30 }}>
          Speed Limit needs access to your location to show your current speed and the posted speed limit. Please enable location access in Settings.
        </Text>
        <TouchableOpacity
          style={{ backgroundColor: '#2563eb', paddingVertical: 14, paddingHorizontal: 36, borderRadius: 12 }}
          onPress={() => Linking.openSettings()}
        >
          <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Open Settings</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: '#0b0d12' }, isLandscape && styles.containerLandscape]}>
      <StatusBar style="light" />
      <SubscriptionNotice onSeePlans={() => setPaywallOpen(true)} />

      {isLandscape ? (
        <View style={styles.landscapeBody}>
          <View style={[styles.landscapeLeftBase, { backgroundColor: '#0b0d12' }]}>
            <Text style={styles.label}>CURRENT SPEED</Text>
            <Text style={[styles.speedValueLandscape, { color: speedColor }]}>
              {permStatus === 'granted' ? Math.round(currentSpeed) : '--'}
            </Text>
          </View>

          <View style={styles.landscapeRight}>
            <View style={styles.landscapeSignBorder}>
              <Text style={[styles.label, { color: '#666' }]}>SPEED LIMIT</Text>
              <Text style={styles.limitValueLandscape}>
                {displayLimit != null ? displayLimit : '--'}
              </Text>
            </View>
          </View>
        </View>
      ) : (
        <>
          <View style={[styles.centerBlock, { backgroundColor: '#0b0d12' }]}>
            <Text style={styles.label}>CURRENT SPEED</Text>
            <Text style={[styles.speedValue, { color: speedColor }]}>
              {permStatus === 'granted' ? Math.round(currentSpeed) : '--'}
            </Text>
          </View>

          <View style={styles.limitBlockWhite}>
            <View style={styles.signBorder}>
              <Text style={[styles.label, { color: '#666' }]}>SPEED LIMIT</Text>
            <Text style={styles.limitValuePlain}>
              {displayLimit != null ? displayLimit : '--'}
            </Text>
            </View>
          </View>
        </>
      )}

      <View style={[styles.footer, isLandscape && styles.footerLandscape, !isLandscape && { backgroundColor: '#fff', paddingHorizontal: 20 }]}>
        <Text
          style={[styles.footerStatus, !isLandscape && { color: '#555' }]}
          numberOfLines={1}
        >
          {statusLine}
        </Text>
        {errorMsg && permStatus === 'granted' ? (
          <Text style={[styles.errorText, !isLandscape && { color: '#b91c1c' }]} numberOfLines={2}>
            {errorMsg}
          </Text>
        ) : null}

        <View style={styles.footerRow}>
          <TouchableOpacity
            style={[styles.unitBtn, !isLandscape && styles.unitBtnLight]}
            onPress={() => setUnit((u) => (u === 'mph' ? 'kmh' : 'mph'))}
          >
            <Text style={[styles.unitBtnText, !isLandscape && { color: '#000' }]}>
              {unit === 'mph' ? 'MPH' : 'KM/H'}
            </Text>
          </TouchableOpacity>

          {driveModeSupported ? (
            <TouchableOpacity
              style={[
                styles.driveBtn,
                !isLandscape && styles.unitBtnLight,
                driveOn && styles.driveBtnOn,
              ]}
              onPress={toggleDriveMode}
              disabled={driveBusy}
              accessibilityRole="switch"
              accessibilityState={{ checked: driveOn }}
              accessibilityHint="Keeps your speed and the speed limit on the CarPlay Dashboard and Lock Screen while the phone is locked"
            >
              <Text
                style={[
                  styles.unitBtnText,
                  !isLandscape && { color: '#000' },
                  driveOn && { color: '#fff' },
                ]}
                numberOfLines={1}
              >
                {driveOn ? '●  Showing on CarPlay' : 'Show on CarPlay'}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={{ flex: 1 }} />
          )}

          <TouchableOpacity
            style={styles.gearBtn}
            onPress={() => {
              setEditThresholds([...thresholds]);
              setSettingsVisible(true);
            }}
          >
            <Text style={[styles.gearText, !isLandscape && { color: '#000' }]}>
              {'⚙'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <Modal
        visible={settingsVisible}
        animationType="slide"
        transparent={true}
        supportedOrientations={['portrait', 'landscape', 'landscape-left', 'landscape-right']}
        onRequestClose={() => setSettingsVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <ScrollView
              style={{ alignSelf: 'stretch' }}
              contentContainerStyle={{ alignItems: 'center' }}
              keyboardShouldPersistTaps="handled"
            >
            <Text style={styles.modalTitle}>Speed Alert Thresholds</Text>
            <Text style={styles.modalSubtitle}>
              {unit === 'mph' ? 'MPH' : 'KM/H'} over the limit
            </Text>

            {editThresholds.map((t, i) => (
              <View key={i} style={styles.thresholdRow}>
                <View style={[styles.colorSwatch, { backgroundColor: t.color }]} />
                <Text style={styles.thresholdLabel}>+</Text>
                <TextInput
                  style={styles.thresholdInput}
                  keyboardType="number-pad"
                  value={String(t.over)}
                  onChangeText={(val) => {
                    const num = parseInt(val, 10);
                    const updated = [...editThresholds];
                    updated[i] = { ...updated[i], over: isNaN(num) ? 0 : num };
                    setEditThresholds(updated);
                  }}
                />
                <Text style={styles.thresholdLabel}>{unit === 'mph' ? 'MPH' : 'KM/H'} over</Text>
              </View>
            ))}

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: '#666' }]}
                onPress={() => setSettingsVisible(false)}
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: '#2563eb' }]}
                onPress={() => {
                  const sorted = [...editThresholds].sort((a, b) => a.over - b.over);
                  saveThresholds(sorted);
                  setSettingsVisible(false);
                }}
              >
                <Text style={styles.modalBtnText}>Save</Text>
              </TouchableOpacity>
            </View>

            <SubscriptionSettings
              onSeePlans={() => {
                setSettingsVisible(false);
                setPaywallOpen(true);
              }}
            />
            <LookupStats />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={paywallOpen}
        animationType="slide"
        supportedOrientations={['portrait', 'landscape', 'landscape-left', 'landscape-right']}
        onRequestClose={() => setPaywallOpen(false)}
      >
        <Paywall onClose={() => setPaywallOpen(false)} onSubscribed={() => setPaywallOpen(false)} />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 0,
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
  },
  unitBtnLight: {
    borderColor: '#000',
  },
  unitBtn: {
    borderWidth: 1.5,
    borderColor: '#fff',
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  unitBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  driveBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#fff',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginHorizontal: 12,
    alignItems: 'center',
  },
  gearBtn: {
    paddingLeft: 4,
  },
  footerStatus: {
    color: '#aaa',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 8,
  },
  driveBtnOn: {
    backgroundColor: '#16a34a',
    borderColor: '#16a34a',
  },
  gearText: {
    color: '#ccc',
    fontSize: 22,
  },
  centerBlock: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  label: {
    color: '#aaa',
    fontSize: 14,
    letterSpacing: 3,
    marginBottom: 6,
  },
  speedValue: {
    color: '#fff',
    fontSize: 160,
    fontWeight: '800',
    lineHeight: 160,
    includeFontPadding: false,
  },
  limitBlockWhite: {
    flex: 1,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  signBorder: {
    borderWidth: 4,
    borderColor: '#000',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    width: '100%',
  },
  limitValuePlain: {
    color: '#000',
    fontSize: 140,
    fontWeight: '800',
    lineHeight: 140,
    includeFontPadding: false,
  },
  footer: {
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 30 : 16,
  },
  footerLandscape: {
    paddingTop: 6,
    paddingBottom: 6,
    paddingHorizontal: 16,
  },
  errorText: {
    color: '#ffb4b4',
    fontSize: 13,
    textAlign: 'center',
  },
  // Landscape styles
  containerLandscape: {
    paddingTop: 0,
    paddingBottom: 0,
  },
  landscapeBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
  },
  landscapeLeftBase: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  landscapeRight: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: '#fff',
    padding: 16,
    borderLeftWidth: 2,
    borderLeftColor: '#ccc',
  },
  landscapeSignBorder: {
    borderWidth: 4,
    borderColor: '#000',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    width: '100%',
  },
  speedValueLandscape: {
    color: '#fff',
    fontSize: 120,
    fontWeight: '800',
    lineHeight: 120,
    includeFontPadding: false,
  },
  limitValueLandscape: {
    color: '#000',
    fontSize: 120,
    fontWeight: '800',
    lineHeight: 120,
    includeFontPadding: false,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  modalContent: {
    backgroundColor: '#1a1d24',
    borderRadius: 16,
    padding: 24,
    width: '85%',
    maxWidth: 400,
    maxHeight: '85%',
    alignItems: 'center',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 4,
  },
  modalSubtitle: {
    color: '#999',
    fontSize: 13,
    marginBottom: 20,
  },
  thresholdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    gap: 8,
  },
  colorSwatch: {
    width: 28,
    height: 28,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#555',
  },
  thresholdLabel: {
    color: '#ccc',
    fontSize: 16,
  },
  thresholdInput: {
    backgroundColor: '#2a2d34',
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    width: 50,
    textAlign: 'center',
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#444',
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  modalBtn: {
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 10,
  },
  statsBox: {
    alignSelf: 'stretch',
    marginTop: 20,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
  statsTitle: {
    color: '#999',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  statsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  statsDisclosure: {
    color: '#60a5fa',
    fontSize: 13,
    marginBottom: 8,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  statsLabel: {
    color: '#bbb',
    fontSize: 13,
  },
  statsValue: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  subActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statsReset: {
    color: '#60a5fa',
    fontSize: 13,
    marginTop: 10,
    textAlign: 'right',
  },
  statsResetInline: {
    color: '#60a5fa',
    fontSize: 13,
    textAlign: 'right',
  },
  modalBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
