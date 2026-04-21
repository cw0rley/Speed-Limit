import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Switch,
  useWindowDimensions,
} from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import { AppState } from 'react-native';

const BACKGROUND_LOCATION_TASK = 'background-location-task';

// Background location handler — receives updates even when the app is backgrounded.
// We store the latest location in a module-level variable so the foreground component
// can pick it up when the app returns.
let _bgLocation = null;
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, ({ data, error }) => {
  if (error) return;
  if (data && data.locations && data.locations.length > 0) {
    _bgLocation = data.locations[data.locations.length - 1];
  }
});

// ---- Unit conversions ----
const MPS_TO_MPH = 2.2369362921;
const MPS_TO_KMH = 3.6;

// ---- Speed limit providers ----
// Each provider returns { value: number, unit: 'mph' | 'kmh', source: 'here' | 'osm' }
// or null. The main fetchSpeedLimit() tries HERE first (better coverage) and falls
// back to Overpass/OSM (free, open) if HERE has no data or errors.

// Get a key at https://developer.here.com. The free "Base" plan allows 1,000
// transactions/day. For production: proxy this through a small backend — API
// keys shipped inside a mobile app can be extracted by anyone who installs it.
const HERE_API_KEY = '6jTbJVWZkUP4tAtJ-mVBeS24nhj-vs_UD0XVkOK44y4';

// Set this to your deployed Cloudflare Worker URL to proxy HERE API requests
// (keeps the API key server-side). Leave null to call HERE directly (local dev).
// Example: 'https://speed-limit-proxy.your-subdomain.workers.dev'
const PROXY_URL = null;

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

// Try HERE first (better coverage), fall back to OSM/Overpass.
async function fetchSpeedLimit(lat, lon, signal) {
  const here = await fetchSpeedLimitHere(lat, lon, signal);
  if (here) return here;
  return await fetchSpeedLimitOverpass(lat, lon, signal);
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

export default function App() {
  const [unit, setUnit] = useState('mph'); // 'mph' | 'kmh'
  const [keepAwake, setKeepAwake] = useState(true);

  // Keep the screen on while this toggle is enabled.
  useEffect(() => {
    if (keepAwake) {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    } else {
      try { deactivateKeepAwake(KEEP_AWAKE_TAG); } catch (_) {}
    }
    return () => {
      try { deactivateKeepAwake(KEEP_AWAKE_TAG); } catch (_) {}
    };
  }, [keepAwake]);
  const [permStatus, setPermStatus] = useState('pending'); // pending | granted | denied
  const [speedMps, setSpeedMps] = useState(0);
  const [accuracyMps, setAccuracyMps] = useState(null);
  const [limit, setLimit] = useState(null); // { value, unit, source } in source unit
  const [limitLoading, setLimitLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const subRef = useRef(null);
  const lastQueriedRef = useRef({ lat: null, lon: null, t: 0 });
  const abortRef = useRef(null);
  const lastOverRef = useRef(false);
  const smoothedSpeedRef = useRef(0); // EMA smoothed speed (m/s)

  const handleLocation = useCallback((loc) => {
    const s = loc.coords.speed;
    const raw = s != null && s >= 0 ? s : 0;
    const EMA_ALPHA = 0.3;
    let smoothed;
    if (raw < 0.5) {
      smoothed = 0;
    } else {
      smoothed = EMA_ALPHA * raw + (1 - EMA_ALPHA) * smoothedSpeedRef.current;
    }
    smoothedSpeedRef.current = smoothed;
    setSpeedMps(smoothed);
    setAccuracyMps(loc.coords.accuracy != null ? loc.coords.accuracy : null);

    const { latitude, longitude } = loc.coords;
    maybeFetchLimit(latitude, longitude);
  }, []);

  // Request permission + start streaming location
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (status !== 'granted') {
          setPermStatus('denied');
          setErrorMsg('Location permission was denied. Enable it in Settings to use this app.');
          return;
        }
        setPermStatus('granted');

        // Request background permission (user can decline — foreground still works)
        const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
        if (!cancelled && bgStatus === 'granted') {
          const isRunning = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
          if (!isRunning) {
            await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
              accuracy: Location.Accuracy.BestForNavigation,
              timeInterval: 2000,
              distanceInterval: 5,
              foregroundService: {
                notificationTitle: 'Speed Limit',
                notificationBody: 'Tracking your speed in the background',
              },
              showsBackgroundLocationIndicator: true,
            });
          }
        }

        const sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1000,
            distanceInterval: 1,
          },
          handleLocation
        );
        subRef.current = sub;
      } catch (e) {
        setErrorMsg('Could not start location updates: ' + e.message);
      }
    })();

    return () => {
      cancelled = true;
      if (subRef.current) {
        subRef.current.remove();
        subRef.current = null;
      }
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // Pick up background location data when app returns to foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && _bgLocation) {
        handleLocation(_bgLocation);
        _bgLocation = null;
      }
    });
    return () => subscription.remove();
  }, [handleLocation]);

  // Throttle: query if moved > 40 m or > 15 s since last query.
  const maybeFetchLimit = useCallback(async (lat, lon) => {
    const now = Date.now();
    const last = lastQueriedRef.current;
    if (
      last.lat != null &&
      haversine(last.lat, last.lon, lat, lon) < 40 &&
      now - last.t < 15000
    ) {
      return;
    }
    lastQueriedRef.current = { lat, lon, t: now };

    try {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLimitLoading(true);
      const result = await fetchSpeedLimit(lat, lon, controller.signal);
      setLimit(result);
    } catch (e) {
      if (e.name !== 'AbortError') {
        // Silent failure for network issues; display will show a dash
      }
    } finally {
      setLimitLoading(false);
    }
  }, []);

  // Derived display values
  const currentSpeed =
    unit === 'mph' ? speedMps * MPS_TO_MPH : speedMps * MPS_TO_KMH;
  const displayLimit = convertLimit(limit, unit);
  const isOver =
    displayLimit != null && currentSpeed > displayLimit + 1; // +1 tolerance

  // Haptic feedback on crossing the limit
  useEffect(() => {
    if (isOver && !lastOverRef.current) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
        () => {}
      );
    }
    lastOverRef.current = isOver;
  }, [isOver]);

  const bgColor = isOver ? '#8a0f10' : '#0b0d12';

  const sourceLabel = limit
    ? (limit.source === 'here' ? 'Limit Data: HERE' : 'Limit Data: OpenStreetMap')
    : 'Limit Data: HERE (primary), OpenStreetMap (fallback)';

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  return (
    <View style={[styles.container, { backgroundColor: '#0b0d12' }, isLandscape && styles.containerLandscape]}>
      <StatusBar style="light" />

      {isLandscape ? (
        <View style={styles.landscapeBody}>
          <View style={[styles.landscapeLeftBase, { backgroundColor: '#0b0d12' }]}>
            <Text style={styles.label}>CURRENT SPEED</Text>
            <Text style={[styles.speedValueLandscape, isOver && { color: '#ff2020' }]}>
              {permStatus === 'granted' ? Math.round(currentSpeed) : '--'}
            </Text>
          </View>

          <View style={styles.landscapeRight}>
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
      ) : (
        <>
          <View style={[styles.centerBlock, { backgroundColor: '#0b0d12' }]}>
            <Text style={styles.label}>CURRENT SPEED</Text>
            <Text style={[styles.speedValue, isOver && { color: '#ff2020' }]}>
              {permStatus === 'granted' ? Math.round(currentSpeed) : '--'}
            </Text>
          </View>

          <View style={[styles.limitBlock, styles.limitBlockWhite]}>
            <Text style={[styles.label, { color: '#666' }]}>SPEED LIMIT</Text>
            {limitLoading && displayLimit == null ? (
              <ActivityIndicator color="#000" size="large" />
            ) : (
              <Text style={styles.limitValuePlain}>
                {displayLimit != null ? displayLimit : '--'}
              </Text>
            )}
          </View>
        </>
      )}

      <View style={[styles.footer, !isLandscape && { backgroundColor: '#fff', paddingHorizontal: 20 }]}>
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
            {errorMsg ? (
              <Text style={[styles.footerText, !isLandscape && { color: '#c00' }]}>{errorMsg}</Text>
            ) : (
              <Text style={[styles.footerText, !isLandscape && { color: '#333' }]}>
                {accuracyMps != null
                  ? 'GPS +/- ' + Math.round(accuracyMps) + ' m'
                  : 'Acquiring GPS...'}
                {isOver ? '   OVER LIMIT' : ''}
              </Text>
            )}
            <Text style={[styles.footerTextDim, !isLandscape && { color: '#999' }]}>{sourceLabel}</Text>
          </View>

          <View style={[styles.keepAwakeRow, !isLandscape && styles.keepAwakeCol]}>
            <Text style={[styles.smallLabel, !isLandscape && { color: '#666' }]}>Screen on</Text>
            <Switch value={keepAwake} onValueChange={setKeepAwake} />
          </View>
        </View>
      </View>
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
    borderWidth: 2,
    borderColor: '#fff',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  unitBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  unitBtnSub: {
    color: '#aaa',
    fontSize: 10,
    textAlign: 'center',
    marginTop: 2,
  },
  keepAwakeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  keepAwakeCol: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
  },
  smallLabel: {
    color: '#ccc',
    fontSize: 12,
    marginRight: 6,
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
  limitBlock: {
    alignItems: 'center',
    marginBottom: 0,
  },
  limitBlockWhite: {
    flex: 1,
    backgroundColor: '#fff',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  limitValuePlain: {
    color: '#000',
    fontSize: 160,
    fontWeight: '800',
    lineHeight: 160,
    includeFontPadding: false,
  },
  footer: {
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 30 : 16,
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
    alignItems: 'center',
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
});
