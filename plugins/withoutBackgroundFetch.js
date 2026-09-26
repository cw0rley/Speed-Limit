const { withInfoPlist } = require('@expo/config-plugins');

// expo-task-manager's config plugin always adds the `fetch` background mode,
// but this app only uses TaskManager for background LOCATION (drive mode) and
// never schedules a background fetch. Unused background modes invite App Review
// questions (guideline 2.5.4), so drop it. Must run AFTER expo-location and
// expo-task-manager in app.json's plugin list.
module.exports = function withoutBackgroundFetch(config) {
  return withInfoPlist(config, (cfg) => {
    const modes = cfg.modResults.UIBackgroundModes;
    if (Array.isArray(modes)) {
      cfg.modResults.UIBackgroundModes = modes.filter((m) => m !== 'fetch');
    }
    return cfg;
  });
};
