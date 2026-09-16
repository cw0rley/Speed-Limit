import ActivityKit
import ExpoModulesCore

// MUST stay identical to the copy in
// targets/live-activity/SpeedLimitLiveActivity.swift — ActivityKit matches the
// app's and the extension's attributes by type name + Codable shape.
@available(iOS 16.1, *)
struct SpeedLimitAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var speed: Int?
    var limit: Int?
    var unit: String
    var speedColor: String
    var isOver: Bool
  }
}

struct ActivityStateRecord: Record {
  @Field var speed: Int? = nil
  @Field var limit: Int? = nil
  @Field var unit: String = "MPH"
  @Field var speedColor: String = "#FFFFFF"
  @Field var isOver: Bool = false

  @available(iOS 16.2, *)
  func content() -> ActivityContent<SpeedLimitAttributes.ContentState> {
    let state = SpeedLimitAttributes.ContentState(
      speed: speed,
      limit: limit,
      unit: unit,
      speedColor: speedColor,
      isOver: isOver
    )
    // If the app stops pushing (killed, GPS lost), the system marks the activity
    // stale and the extension shows "--" instead of a frozen, wrong speed.
    return ActivityContent(state: state, staleDate: Date().addingTimeInterval(STALE_AFTER_SECONDS))
  }
}

private let STALE_AFTER_SECONDS: TimeInterval = 30

public class SpeedLimitActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SpeedLimitActivity")

    Function("areActivitiesEnabled") { () -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    Function("isActive") { () -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      return Activity<SpeedLimitAttributes>.activities.contains { $0.activityState == .active }
    }

    // Must be called while the app is in the foreground. Ends any leftover
    // activity first so there is only ever one.
    AsyncFunction("start") { (record: ActivityStateRecord) async throws -> String? in
      guard #available(iOS 16.2, *) else { return nil }
      for activity in Activity<SpeedLimitAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      let activity = try Activity.request(
        attributes: SpeedLimitAttributes(),
        content: record.content(),
        pushType: nil
      )
      return activity.id
    }

    AsyncFunction("update") { (record: ActivityStateRecord) async in
      guard #available(iOS 16.2, *) else { return }
      let content = record.content()
      for activity in Activity<SpeedLimitAttributes>.activities {
        await activity.update(content)
      }
    }

    AsyncFunction("end") { () async in
      guard #available(iOS 16.2, *) else { return }
      for activity in Activity<SpeedLimitAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
  }
}
