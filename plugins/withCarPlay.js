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
  // 1. CarPlay NAVIGATION entitlement — required for CPMapTemplate, the only
  //    CarPlay surface that lets a third-party app draw a full-screen custom
  //    view (our big sign). NOTE: Apple must grant this via the CarPlay
  //    entitlement request form (https://developer.apple.com/contact/carplay/)
  //    and the provisioning profile must be regenerated before a build can be
  //    signed with it. Until then, builds with this entitlement will fail to
  //    sign — that's expected while the request is pending.
  config = withEntitlementsPlist(config, (c) => {
    c.modResults['com.apple.developer.carplay-maps'] = true;
    // Remove the old driving-task entitlement — the two are mutually exclusive
    // (an app is one CarPlay category).
    delete c.modResults['com.apple.developer.carplay-driving-task'];
    return c;
  });

  // 2. Scene configurations. The library's HeadUnitSceneDelegate handles the
  //    CarPlay template scene for both Grid and Map templates, so this is
  //    unchanged from the driving-task setup.
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

  // 3. AppDelegate hook so MapTemplate can mount RN root views into the car window.
  config = withAutoplayRootView(config);

  return config;
}

module.exports = withCarPlay;
