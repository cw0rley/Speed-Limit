const {
  withEntitlementsPlist,
  withInfoPlist,
  withAppDelegate,
} = require('@expo/config-plugins');

// Native method required by @iternio/react-native-auto-play's MapTemplate so it
// can mount a React Native root view into the CarPlay window. Covers both the
// new and old architecture (Expo SDK 54 uses the new arch + a Swift AppDelegate).
// Taken from the library README; may need adjusting if Expo changes the
// AppDelegate shape in a future SDK.
const AUTOPLAY_ROOT_VIEW_METHOD = `
  @objc func getRootViewForAutoplay(
    moduleName: String,
    initialProperties: [String: Any]?
  ) -> UIView? {
    if RCTIsNewArchEnabled() {
      if let factory = reactNativeFactory?.rootViewFactory as? ExpoReactRootViewFactory {
        return factory.superView(
          withModuleName: moduleName,
          initialProperties: initialProperties,
          launchOptions: nil
        )
      }
      return reactNativeFactory?.rootViewFactory.view(
        withModuleName: moduleName,
        initialProperties: initialProperties
      )
    }
    if let rootView = window?.rootViewController?.view as? RCTRootView {
      return RCTRootView(
        bridge: rootView.bridge,
        moduleName: moduleName,
        initialProperties: initialProperties
      )
    }
    return nil
  }
`;

// Inject getRootViewForAutoplay into the app's Swift AppDelegate, plus the
// ExpoModulesCore import it relies on (ExpoReactRootViewFactory).
function withAutoplayRootView(config) {
  return withAppDelegate(config, (cfg) => {
    let contents = cfg.modResults.contents;

    if (!contents.includes('getRootViewForAutoplay')) {
      const classMatch = contents.match(/class AppDelegate[^{]*\{/);
      if (classMatch) {
        const insertAt = classMatch.index + classMatch[0].length;
        contents =
          contents.slice(0, insertAt) +
          '\n' +
          AUTOPLAY_ROOT_VIEW_METHOD +
          contents.slice(insertAt);
      } else {
        throw new Error(
          'withCarPlay: could not find `class AppDelegate` in AppDelegate.swift to inject getRootViewForAutoplay'
        );
      }
    }

    if (!/^import ExpoModulesCore/m.test(contents)) {
      contents = contents.replace(/^(import Expo\b.*)$/m, '$1\nimport ExpoModulesCore');
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
}

function withCarPlay(config) {
  // 1. CarPlay DRIVING TASK entitlement (granted 2026-08-25). Template-only:
  //    Information/List/Grid, updated no more than every ~10 s. Apple REFUSED
  //    the Navigation entitlement (carplay-maps, Case-ID 21844634), so the
  //    full-screen MapTemplate sign is not possible — custom graphics come from
  //    the Live Activity in targets/live-activity instead. Being a CarPlay app
  //    still matters: it lets the Live Activity open the app from CarPlay.
  config = withEntitlementsPlist(config, (c) => {
    c.modResults['com.apple.developer.carplay-driving-task'] = true;
    // Mutually exclusive with driving-task (an app is one CarPlay category).
    delete c.modResults['com.apple.developer.carplay-maps'];
    return c;
  });

  // 2. Scene configurations. The library's HeadUnitSceneDelegate handles the
  //    CarPlay template scene.
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: true,
      UISceneConfigurations: {
        CPTemplateApplicationSceneSessionRoleApplication: [
          {
            UISceneClassName: 'CPTemplateApplicationScene',
            UISceneConfigurationName: 'CarPlayHeadUnit',
            UISceneDelegateClassName: 'HeadUnitSceneDelegate',
          },
        ],
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneClassName: 'UIWindowScene',
            UISceneConfigurationName: 'WindowApplication',
            UISceneDelegateClassName: 'WindowApplicationSceneDelegate',
          },
        ],
      },
    };

    return c;
  });

  // 3. AppDelegate hook the library uses to mount RN root views into the car
  //    window. Not needed by InformationTemplate, but harmless and required if
  //    the library ever renders a component-backed scene.
  config = withAutoplayRootView(config);

  return config;
}

module.exports = withCarPlay;
