const { withAndroidManifest } = require('@expo/config-plugins');

// The @iternio/react-native-auto-play library merges its own AndroidManifest.xml
// into the app during autolinking. That manifest declares a full Android Auto
// navigation CarAppService (androidx.car.app.category.NAVIGATION) plus car
// permissions. We only implement CarPlay on iOS — there is no Android Auto UI —
// so this phantom declaration makes Google Play review the app under the Auto
// App Quality Guidelines and launch it on a head unit, where nothing loads. That
// got version code 9 rejected ("the content of your application is not able to
// load").
//
// This plugin strips those Auto-only nodes back out via `tools:node="remove"`,
// which the manifest merger honors against library-contributed nodes. iOS
// CarPlay is unaffected (it's driven by ios entitlements/Info.plist in
// withCarPlay.js, not the Android manifest).

const SERVICES_TO_REMOVE = [
  'com.margelo.nitro.swe.iternio.reactnativeautoplay.AndroidAutoService',
];

const METADATA_TO_REMOVE = [
  'com.google.android.gms.car.application',
  'androidx.car.app.minCarApiLevel',
];

const PERMISSIONS_TO_REMOVE = [
  'androidx.car.app.NAVIGATION_TEMPLATES',
  'androidx.car.app.MAP_TEMPLATES',
  'androidx.car.app.ACCESS_SURFACE',
  'com.google.android.gms.permission.CAR_FUEL',
  'com.google.android.gms.permission.CAR_MILEAGE',
  'com.google.android.gms.permission.CAR_SPEED',
  'android.permission.RECORD_AUDIO',
];

function pushRemoval(list, name) {
  const already = list.some(
    (el) => el.$ && el.$['android:name'] === name && el.$['tools:node'] === 'remove'
  );
  if (!already) {
    list.push({ $: { 'android:name': name, 'tools:node': 'remove' } });
  }
}

function withRemoveAndroidAuto(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    // Make sure the tools namespace is declared so tools:node is understood.
    manifest.$ = manifest.$ || {};
    manifest.$['xmlns:tools'] =
      manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools';

    const app = manifest.application[0];

    app.service = app.service || [];
    SERVICES_TO_REMOVE.forEach((name) => pushRemoval(app.service, name));

    app['meta-data'] = app['meta-data'] || [];
    METADATA_TO_REMOVE.forEach((name) => pushRemoval(app['meta-data'], name));

    manifest['uses-permission'] = manifest['uses-permission'] || [];
    PERMISSIONS_TO_REMOVE.forEach((name) =>
      pushRemoval(manifest['uses-permission'], name)
    );

    return config;
  });
}

module.exports = withRemoveAndroidAuto;
