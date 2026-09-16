// Live Activity extension: draws the speed + speed-limit sign on the CarPlay
// Dashboard (small family, iOS 26+), the Lock Screen and the Dynamic Island.
// No CarPlay entitlement is needed for Live Activities to appear in CarPlay.
// Generated into the Xcode project by @bacons/apple-targets at prebuild.

/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = () => ({
  type: 'widget',
  // Product/module name. Must not clash with the SpeedLimitActivity pod
  // (modules/speed-limit-activity), which is the JS -> ActivityKit bridge.
  name: 'LiveActivityWidget',
  displayName: 'Speed Limit',
  bundleIdentifier: '.liveactivity',
  // supplementalActivityFamilies / activityFamily need iOS 18. The main app
  // still targets iOS 15.1; older devices simply don't load the extension.
  deploymentTarget: '18.0',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
  colors: {
    $widgetBackground: '#0b0d12',
    $accent: '#2563eb',
  },
});
