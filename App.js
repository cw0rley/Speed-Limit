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
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { activateKeepAwakeAsync } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import SpeedLimitActivity from './modules/speed-limit-activity';

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

// ---- Speed limit providers ----
// Each provider returns { value: number, unit: 'mph' | 'kmh', source: 'here' | 'osm' }
// or null. The main fetchSpeedLimit() tries OSM/Overpass first (free, open) and
// only falls back to HERE (paid past the free tier) where OSM has no maxspeed.
// This keeps HERE transactions — the thing that costs money — to a minimum.

// ⚠️ HERE IS INTENTIONALLY DISABLED. The HERE "free tier" billed ~$1,000 in
// overage (two ~$500 charges) despite the throttle + cache "limits", which had
// gaps and never included a real hard spend cap. HERE stays OFF via this kill
// switch until a proper cap is in place and the decision to re-enable is made.
// DO NOT flip this to true without a hard spend cap on the HERE account first.
// See CLAUDE.md → "HERE is disabled" and memory: here-billing-incident.
const HERE_ENABLED = false;

// Get a key at https://developer.here.com. The free "Base" plan allows 1,000
// transactions/day. For production: proxy this through a small backend — API
// keys shipped inside a mobile app can be extracted by anyone who installs it.
const HERE_API_KEY = '6jTbJVWZkUP4tAtJ-mVBeS24nhj-vs_UD0XVkOK44y4';

// Set this to your deployed Cloudflare Worker URL to proxy HERE API requests
// (keeps the API key server-side). Leave null to call HERE directly (local dev).
// Example: 'https://speed-limit-proxy.your-subdomain.workers.dev'
const PROXY_URL = 'https://speed-limit-proxy.prcunningham.workers.dev';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function parseMaxspeed(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  // e.g. "50", "50 mph", "50mph", "50 km/h", "50kmh"
  const mphMatch = s.match(/^(\d+(?:\.\d+)?)\s*mph$/);
  if (mphMatch) return { value: parseFloat(mphMatch[1]), unit: 'mph' };
  const kmhMatch = s.match(/^(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph)$/);
  if (kmhMatch) return { value: parseFloat(kmhMatch[1]), unit: 'kmh' };
  const numMatch = s.match(/^(\d+(?:\.\d+)?)$/);
  if (numMatch) return { value: parseFloat(numMatch[1]), unit: 'kmh' }; // OSM default
  // Ignore implicit values like "RU:urban", "walk", "none", "signals", etc.
  return null;
}

async function fetchSpeedLimitOverpass(lat, lon, signal) {
  // Query ways with highway+maxspeed near the point, ordered implicitly.
  const radius = 25; // meters
  const query = `[out:json][timeout:8];
way(around:${radius},${lat},${lon})[highway][maxspeed];
out tags center 1;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal,
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.elements || data.elements.length === 0) return null;

      // Pick the closest element to (lat, lon) by great-circle distance on the center.
      let best = null;
      let bestDist = Infinity;
      for (const el of data.elements) {
        const c = el.center || { lat: el.lat, lon: el.lon };
        if (c == null || c.lat == null || c.lon == null) continue;
        const d = haversine(lat, lon, c.lat, c.lon);
        if (d < bestDist) {
          bestDist = d;
          best = el;
        }
      }
      if (!best || !best.tags || !best.tags.maxspeed) return null;
      const parsed = parseMaxspeed(best.tags.maxspeed);
      return parsed ? { ...parsed, source: 'osm' } : null;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // try next endpoint
    }
  }
  return null;
}

// HERE Routing v8 returns speedLimit (in m/s) per route span. We construct a
// minimal ~10 m route from (lat, lon) to a nearby point, then read the
// speedLimit of the first span that has one.
async function fetchSpeedLimitHere(lat, lon, signal) {
  // Hard kill switch — HERE is disabled after a ~$1,000 billing incident. This
  // makes "off" a code fact, not just a disabled account key, so re-enabling the
  // key can't silently resume billing. See HERE_ENABLED above.
  if (!HERE_ENABLED) return null;
  if (!PROXY_URL && (!HERE_API_KEY || HERE_API_KEY.startsWith('YOUR_'))) return null;

  const dLat = 0.00009; // ~10 m north
  const lat2 = lat + dLat;
  const lon2 = lon;

  const params =
    `?transportMode=car&origin=${lat},${lon}&destination=${lat2},${lon2}` +
    '&return=polyline&spans=speedLimit';

  // Use proxy if configured, otherwise call HERE directly with embedded key.
  const url = PROXY_URL
    ? `${PROXY_URL}/here-route${params}`
    : `https://router.hereapi.com/v8/routes${params}&apikey=${encodeURIComponent(HERE_API_KEY)}`;

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    const spans = data && data.routes && data.routes[0] && data.routes[0].sections && data.routes[0].sections[0] && data.routes[0].sections[0].spans;
    if (!Array.isArray(spans)) return null;
    const span = spans.find((s) => typeof s.speedLimit === 'number' && s.speedLimit > 0);
    if (!span) return null;
    // HERE returns speedLimit in m/s. Convert to km/h as our canonical unit.
    const kmh = span.speedLimit * 3.6;
    return { value: Math.round(kmh), unit: 'kmh', source: 'here' };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null;
  }
}

// Session-level cache of results by ~11 m geo-grid cell. Skips the network
// entirely when we've already resolved a nearby point this session — cutting both
// OSM and HERE calls on repeat/looping routes. Cleared when the app restarts.
const CELL_PRECISION = 4; // decimal places (~11 m)
const cellCache = new Map();
const CELL_CACHE_MAX = 500;

function cellKey(lat, lon) {
  return `${lat.toFixed(CELL_PRECISION)},${lon.toFixed(CELL_PRECISION)}`;
}

// Try OSM/Overpass first (free), fall back to HERE (paid) only where OSM has no
// data. Results are memoized per grid cell so repeat passes hit no provider.
async function fetchSpeedLimit(lat, lon, signal) {
  const key = cellKey(lat, lon);
  if (cellCache.has(key)) return cellCache.get(key);

  let result = await fetchSpeedLimitOverpass(lat, lon, signal);
  if (!result) result = await fetchSpeedLimitHere(lat, lon, signal);

  // Only cache real hits. A null may just be a flaky Overpass endpoint; caching it
  // would suppress a valid HERE fallback on the next pass.
  if (result) {
    if (cellCache.size >= CELL_CACHE_MAX) {
      cellCache.delete(cellCache.keys().next().value);
    }
    cellCache.set(key, result);
  }
  return result;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Convert a limit given in one unit to the user's display unit.
function convertLimit(limit, displayUnit) {
  if (!limit) return null;
  if (limit.unit === displayUnit) return Math.round(limit.value);
  if (limit.unit === 'mph' && displayUnit === 'kmh') {
    return Math.round(limit.value * 1.609344);
  }
  if (limit.unit === 'kmh' && displayUnit === 'mph') {
    return Math.round(limit.value / 1.609344);
  }
  return Math.round(limit.value);
}

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
let drive = { speedMps: 0, accuracy: null, limit: null, limitLoading: false };
let prefs = { unit: 'mph', thresholds: DEFAULT_THRESHOLDS };
const driveListeners = new Set();

function setDrive(patch) {
  drive = { ...drive, ...patch };
  driveListeners.forEach((l) => l());
  syncLiveActivity();
}
function setPrefs(next) {
  prefs = next;
  syncLiveActivity();
}
const subscribeDrive = (cb) => {
  driveListeners.add(cb);
  return () => driveListeners.delete(cb);
};
const getDrive = () => drive;

let lastLocationTs = 0;
function handleLocation(loc) {
  // Both sources can deliver the same fix; only process newer ones.
  if (!loc || loc.timestamp <= lastLocationTs) return;
  lastLocationTs = loc.timestamp;
  const s = loc.coords.speed;
  // expo-location returns m/s; can be negative or null if unknown
  setDrive({
    speedMps: s != null && s >= 0 ? s : 0,
    accuracy: loc.coords.accuracy != null ? loc.coords.accuracy : null,
  });
  maybeFetchLimit(loc.coords.latitude, loc.coords.longitude);
}

// Throttle: never more often than every MIN_QUERY_MS; otherwise query once
// moved >= 40 m or 15 s have passed. The floor matters now that the background
// task keeps this running for whole drives (see the Throttling note in
// CLAUDE.md — the proper fix is roadmap Phase 1).
const MIN_QUERY_MS = 5000;
let lastQueried = { lat: null, lon: null, t: 0 };
let limitAbort = null;
async function maybeFetchLimit(lat, lon) {
  const now = Date.now();
  if (now - lastQueried.t < MIN_QUERY_MS) return;
  if (
    lastQueried.lat != null &&
    haversine(lastQueried.lat, lastQueried.lon, lat, lon) < 40 &&
    now - lastQueried.t < 15000
  ) {
    return;
  }
  lastQueried = { lat, lon, t: now };

  if (limitAbort) limitAbort.abort();
  const controller = new AbortController();
  limitAbort = controller;
  setDrive({ limitLoading: true });
  try {
    const result = await fetchSpeedLimit(lat, lon, controller.signal);
    setDrive({ limit: result });
  } catch (e) {
    // AbortError or network failure: keep the previous limit
  } finally {
    if (limitAbort === controller) setDrive({ limitLoading: false });
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
}

async function stopDriveMode() {
  liveOn = false;
  liveSig = '';
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
const CARPLAY_MIN_UPDATE_MS = 10000;

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

  const [permStatus, setPermStatus] = useState('pending'); // pending | granted | denied
  const [errorMsg, setErrorMsg] = useState(null);
  const [driveOn, setDriveOn] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);

  const { speedMps, accuracy: accuracyMps, limit, limitLoading } = useSyncExternalStore(
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
      if (limitAbort) limitAbort.abort();
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
          setDriveOn(true);
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
        setDriveOn(false);
      } else {
        if (!SpeedLimitActivity.areActivitiesEnabled()) {
          setErrorMsg('Live Activities are turned off for Speed Limit in Settings.');
        }
        await startDriveMode();
        setDriveOn(true);
      }
    } catch (e) {
      setErrorMsg('Could not start drive mode: ' + e.message);
      await stopDriveMode();
      setDriveOn(false);
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

  // ---- CarPlay (InformationTemplate) ----
  const [carplayTemplate, setCarplayTemplate] = useState(null);
  const [carplayPushed, setCarplayPushed] = useState({ sig: '', at: 0 });

  useEffect(() => {
    if (!HybridAutoPlay || !AutoPlayInformationTemplate) return;

    const onConnect = () => {
      const tpl = new AutoPlayInformationTemplate({
        title: { text: 'Speed Limit' },
        items: carplayItems('--', false),
      });
      tpl.setRootTemplate();
      setCarplayPushed({ sig: '', at: 0 }); // force a push to the new template
      setCarplayTemplate(tpl);
    };
    const onDisconnect = () => setCarplayTemplate(null);

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

  // Push the limit + drive-mode hint to CarPlay, at most every 10 s (Driving
  // Task rule). A trailing timer delivers the latest value after the wait.
  const carplayLimitText =
    displayLimit != null ? `${displayLimit} ${unitLabel(unit)}` : '--';
  useEffect(() => {
    if (!carplayTemplate) return;
    const sig = `${carplayLimitText}|${driveOn}`;
    if (sig === carplayPushed.sig) return;
    const wait = Math.max(0, carplayPushed.at + CARPLAY_MIN_UPDATE_MS - Date.now());
    const timer = setTimeout(() => {
      carplayTemplate.updateItems(carplayItems(carplayLimitText, driveOn)).catch(() => {});
      setCarplayPushed({ sig, at: Date.now() });
    }, wait);
    return () => clearTimeout(timer);
  }, [carplayTemplate, carplayLimitText, driveOn, carplayPushed]);

  const sourceLabel = limit
    ? (limit.source === 'here' ? 'Limit Data: HERE' : 'Limit Data: OpenStreetMap')
    : 'Limit Data: OpenStreetMap';

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

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
              {limitLoading && displayLimit == null ? (
                <ActivityIndicator color="#000" size="large" />
              ) : (
                <Text style={styles.limitValueLandscape}>
                  {displayLimit != null ? displayLimit : '--'}
                </Text>
              )}
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
            {limitLoading && displayLimit == null ? (
              <ActivityIndicator color="#000" size="large" />
            ) : (
              <Text style={styles.limitValuePlain}>
                {displayLimit != null ? displayLimit : '--'}
              </Text>
            )}
            </View>
          </View>
        </>
      )}

      <View style={[styles.footer, isLandscape && styles.footerLandscape, !isLandscape && { backgroundColor: '#fff', paddingHorizontal: 20 }]}>
        <View style={styles.footerRow}>
          <TouchableOpacity
            style={[styles.unitBtn, !isLandscape && styles.unitBtnLight]}
            onPress={() => setUnit((u) => (u === 'mph' ? 'kmh' : 'mph'))}
          >
            <Text style={[styles.unitBtnText, !isLandscape && { color: '#000' }]}>
              {unit === 'mph' ? 'MPH' : 'KM/H'}
            </Text>
          </TouchableOpacity>

          <View style={styles.footerCenter}>
            <Text style={[styles.footerText, !isLandscape && { color: '#333' }]}>
              {accuracyMps != null
                ? 'GPS +/- ' + Math.round(accuracyMps) + ' m'
                : 'Acquiring GPS...'}
            </Text>
            <Text style={[styles.footerTextDim, !isLandscape && { color: '#999' }]}>{sourceLabel}</Text>
            {errorMsg && permStatus === 'granted' ? (
              <Text style={[styles.errorText, !isLandscape && { color: '#b91c1c' }]}>{errorMsg}</Text>
            ) : null}
          </View>

          {driveModeSupported && (
            <TouchableOpacity
              style={[
                styles.driveBtn,
                !isLandscape && styles.unitBtnLight,
                driveOn && styles.driveBtnOn,
              ]}
              onPress={toggleDriveMode}
              disabled={driveBusy}
            >
              <Text
                style={[
                  styles.unitBtnText,
                  !isLandscape && { color: '#000' },
                  driveOn && { color: '#fff' },
                ]}
              >
                {driveOn ? 'CarPlay ON' : 'CarPlay'}
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={() => {
              setEditThresholds([...thresholds]);
              setSettingsVisible(true);
            }}
          >
            <Text style={[styles.gearText, !isLandscape && { color: '#000' }]}>
              {'\u2699'}
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
          </View>
        </KeyboardAvoidingView>
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
  footerCenter: {
    flex: 1,
    alignItems: 'center',
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
    borderWidth: 1.5,
    borderColor: '#fff',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginRight: 12,
  },
  driveBtnOn: {
    backgroundColor: '#16a34a',
    borderColor: '#16a34a',
  },
  gearText: {
    color: '#ccc',
    fontSize: 22,
  },
  unitBtnSub: {
    color: '#aaa',
    fontSize: 10,
    textAlign: 'center',
    marginTop: 2,
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
  footerText: {
    color: '#ddd',
    fontSize: 13,
  },
  footerTextDim: {
    color: '#777',
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
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
  modalBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
