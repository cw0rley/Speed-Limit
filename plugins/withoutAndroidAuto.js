const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

// This app has no Android Auto feature — @iternio/react-native-auto-play is
// required behind `Platform.OS === 'ios'` in App.js and is only ever used for
// CarPlay. Its Android manifest, though, declares the app as an Android Auto
// navigation app: a `androidx.car.app.CarAppService` plus the
// `com.google.android.gms.car.application` meta-data that is what actually
// advertises Auto support. On a head unit that service starts, shows an empty
// placeholder template (app name + icon) and waits for a JS screen that never
// arrives. Google's automated Auto test read that as a crash — Play policy
// issue "Auto App Quality Guidelines: App crashes" ("the content of your
// application is not able to load"), enforced 2026-08-20, which rolled the
// Play listing back to the previous version. Google's own remedy is to remove
// the Android Auto manifest entry, which is what this plugin does.
//
// The entries come from the library's manifest, not the app's, so they can only
// be dropped through the manifest merger: re-declare each one in the app
// manifest with tools:node="remove" and the merger leaves it out of the final
// AndroidManifest.xml. Check a build with
// `android/app/build/intermediates/merged_manifests/.../AndroidManifest.xml`.
//
// iOS/CarPlay is untouched — this is an Android-only mod.

// Auto-only permissions the library asks for. The app's own permissions are in
// app.json (android.permissions); nothing here overlaps with them.
//
// RECORD_AUDIO is on this list for the same reason: the library requests it for
// Android Auto voice input, and it is the only thing in the whole dependency
// tree that asks for a microphone — the app has no audio code and no audio
// package. Left in, the Play listing tells users Speed Limit can record audio.
const AUTO_PERMISSIONS = [
  'androidx.car.app.NAVIGATION_TEMPLATES',
  'androidx.car.app.MAP_TEMPLATES',
  'androidx.car.app.ACCESS_SURFACE',
  'com.google.android.gms.permission.CAR_FUEL',
  'com.google.android.gms.permission.CAR_MILEAGE',
  'com.google.android.gms.permission.CAR_SPEED',
  'android.permission.RECORD_AUDIO',
];

// `com.google.android.gms.car.application` is the declaration Android Auto and
// Play look for; minCarApiLevel only means anything alongside it.
const AUTO_META_DATA = [
  'com.google.android.gms.car.application',
  'androidx.car.app.minCarApiLevel',
];

// The CarAppService Android Auto would launch.
const AUTO_SERVICES = [
  'com.margelo.nitro.swe.iternio.reactnativeautoplay.AndroidAutoService',
];

// Mark `name` for removal by the merger, reusing an existing declaration if the
// app manifest already has one so prebuild stays idempotent.
function markForRemoval(nodes, name) {
  const existing = nodes.find((node) => node && node.$ && node.$['android:name'] === name);
  if (existing) {
    existing.$['tools:node'] = 'remove';
    return;
  }
  nodes.push({ $: { 'android:name': name, 'tools:node': 'remove' } });
}

module.exports = function withoutAndroidAuto(config) {
  return withAndroidManifest(config, (cfg) => {
    const androidManifest = cfg.modResults;
    const { manifest } = androidManifest;

    // tools:node is only honoured if the namespace is declared.
    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    manifest['uses-permission'] = manifest['uses-permission'] || [];
    AUTO_PERMISSIONS.forEach((name) => markForRemoval(manifest['uses-permission'], name));

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);

    application['meta-data'] = application['meta-data'] || [];
    AUTO_META_DATA.forEach((name) => markForRemoval(application['meta-data'], name));

    application.service = application.service || [];
    AUTO_SERVICES.forEach((name) => markForRemoval(application.service, name));

    return cfg;
  });
};
