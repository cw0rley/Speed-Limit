import ActivityKit
import SwiftUI
import WidgetKit

// MUST stay identical to the copy in
// modules/speed-limit-activity/ios/SpeedLimitActivityModule.swift — ActivityKit
// matches the app's and the extension's attributes by type name + Codable shape.
struct SpeedLimitAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var speed: Int?
    var limit: Int?
    var unit: String        // "MPH" | "KM/H"
    var speedColor: String  // "#RRGGBB" from the user's alert thresholds
    var isOver: Bool
  }
}

@main
struct SpeedLimitWidgetBundle: WidgetBundle {
  var body: some Widget {
    SpeedLimitLiveActivity()
  }
}

struct SpeedLimitLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: SpeedLimitAttributes.self) { context in
      ActivityRootView(state: context.state, isStale: context.isStale)
        .activityBackgroundTint(context.state.isOver ? Palette.overRed : Palette.background)
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          SpeedReadout(state: context.state, isStale: context.isStale, numberSize: 44)
        }
        DynamicIslandExpandedRegion(.trailing) {
          SpeedLimitSign(limit: shownLimit(context.state, context.isStale), numberSize: 34)
        }
      } compactLeading: {
        Text(speedText(context.state, context.isStale))
          .font(.system(size: 15, weight: .heavy, design: .rounded))
          .foregroundStyle(Color(hex: context.state.speedColor))
      } compactTrailing: {
        MiniSign(limit: shownLimit(context.state, context.isStale))
      } minimal: {
        MiniSign(limit: shownLimit(context.state, context.isStale))
      }
    }
    // .small is the size CarPlay (and the Watch Smart Stack) uses.
    .supplementalActivityFamilies([.small])
  }
}

// MARK: - Layouts

struct ActivityRootView: View {
  @Environment(\.activityFamily) private var family
  let state: SpeedLimitAttributes.ContentState
  let isStale: Bool

  var body: some View {
    switch family {
    case .small:
      // CarPlay Dashboard tile: speed on the left, sign on the right.
      HStack(spacing: 10) {
        SpeedReadout(state: state, isStale: isStale, numberSize: 40)
          .frame(maxWidth: .infinity)
        SpeedLimitSign(limit: shownLimit(state, isStale), numberSize: 34)
      }
      .padding(8)
    default:
      // Lock Screen / banner.
      HStack(spacing: 16) {
        SpeedReadout(state: state, isStale: isStale, numberSize: 64)
          .frame(maxWidth: .infinity)
        SpeedLimitSign(limit: shownLimit(state, isStale), numberSize: 50)
      }
      .padding(16)
    }
  }
}

struct SpeedReadout: View {
  let state: SpeedLimitAttributes.ContentState
  let isStale: Bool
  let numberSize: CGFloat

  var body: some View {
    VStack(spacing: 0) {
      Text(speedText(state, isStale))
        .font(.system(size: numberSize, weight: .heavy, design: .rounded))
        .monospacedDigit()
        .foregroundStyle(isStale ? Palette.dim : Color(hex: state.speedColor))
        .lineLimit(1)
        .minimumScaleFactor(0.5)
      Text(state.unit)
        .font(.system(size: max(10, numberSize * 0.25), weight: .bold))
        .foregroundStyle(Palette.dim)
    }
  }
}

/// US-style (MUTCD R2-1) speed limit sign: white panel, inset black border.
struct SpeedLimitSign: View {
  let limit: Int?
  let numberSize: CGFloat

  var body: some View {
    let corner = numberSize * 0.22
    VStack(spacing: 0) {
      Text("SPEED")
      Text("LIMIT")
      Text(limit.map(String.init) ?? "--")
        .font(.system(size: numberSize, weight: .black))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.5)
    }
    .font(.system(size: numberSize * 0.3, weight: .heavy))
    .foregroundStyle(.black)
    .padding(.horizontal, numberSize * 0.22)
    .padding(.vertical, numberSize * 0.16)
    .frame(minWidth: numberSize * 1.7)
    .background(RoundedRectangle(cornerRadius: corner).fill(.white))
    .overlay(
      RoundedRectangle(cornerRadius: corner * 0.75)
        .inset(by: numberSize * 0.07)
        .stroke(.black, lineWidth: max(2, numberSize * 0.07))
    )
  }
}

/// Tiny sign for the compact / minimal Dynamic Island slots.
struct MiniSign: View {
  let limit: Int?

  var body: some View {
    Text(limit.map(String.init) ?? "--")
      .font(.system(size: 13, weight: .black))
      .monospacedDigit()
      .foregroundStyle(.black)
      .padding(.horizontal, 4)
      .padding(.vertical, 1)
      .background(RoundedRectangle(cornerRadius: 3).fill(.white))
      .overlay(RoundedRectangle(cornerRadius: 3).inset(by: 1).stroke(.black, lineWidth: 1))
  }
}

// MARK: - Helpers

enum Palette {
  static let background = Color(hex: "#0B0D12")
  static let overRed = Color(hex: "#8A0F10")
  static let dim = Color(hex: "#8A97A7")
}

// When the app has stopped sending updates (staleDate passed), the last limit
// may no longer apply — show "--" rather than a frozen number.
func shownLimit(_ state: SpeedLimitAttributes.ContentState, _ isStale: Bool) -> Int? {
  isStale ? nil : state.limit
}

func speedText(_ state: SpeedLimitAttributes.ContentState, _ isStale: Bool) -> String {
  guard !isStale, let speed = state.speed else { return "--" }
  return String(speed)
}

extension Color {
  /// Accepts "#RRGGBB" or "RRGGBB"; anything else renders white.
  init(hex: String) {
    let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    var value: UInt64 = 0
    guard cleaned.count == 6, Scanner(string: cleaned).scanHexInt64(&value) else {
      self = .white
      return
    }
    self.init(
      red: Double((value >> 16) & 0xFF) / 255,
      green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255
    )
  }
}
