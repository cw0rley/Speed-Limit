const {
  withEntitlementsPlist,
  withInfoPlist,
} = require('@expo/config-plugins');

function withCarPlay(config) {
  // 1. Add CarPlay Driving Task entitlement
  config = withEntitlementsPlist(config, (c) => {
    c.modResults['com.apple.developer.carplay-driving-task'] = true;
    return c;
  });

  // 2. Add scene configurations to Info.plist
  //    CarPlaySceneDelegate is our custom delegate from modules/carplay-hud.
  //    WindowApplicationSceneDelegate is provided by react-native-auto-play.
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: true,
      UISceneConfigurations: {
        CPTemplateApplicationSceneSessionRoleApplication: [
          {
            UISceneClassName: 'CPTemplateApplicationScene',
            UISceneConfigurationName: 'CarPlayHeadUnit',
            UISceneDelegateClassName: 'CarPlaySceneDelegate',
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

  return config;
}

module.exports = withCarPlay;
