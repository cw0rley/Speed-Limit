import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

// JS bridge to the iOS Live Activity (CarPlay Dashboard / Lock Screen /
// Dynamic Island). null on Android and in Expo Go, which lack the native module.
//
// API:
//   areActivitiesEnabled(): boolean
//   isActive(): boolean
//   start(state): Promise<string | null>   // foreground only
//   update(state): Promise<void>
//   end(): Promise<void>
// state = { speed: number|null, limit: number|null, unit: 'MPH'|'KM/H',
//           speedColor: '#RRGGBB', isOver: boolean }
const SpeedLimitActivity =
  Platform.OS === 'ios' ? requireOptionalNativeModule('SpeedLimitActivity') : null;

export default SpeedLimitActivity;
