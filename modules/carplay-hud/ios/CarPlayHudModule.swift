import CarPlay
import ExpoModulesCore

public final class CarPlayHudModule: Module {
  static weak var shared: CarPlayHudModule?
  private(set) var hudView: CarPlayHudView?
  private weak var hudVC: UIViewController?

  public func definition() -> ModuleDefinition {
    Name("CarPlayHud")

    OnCreate {
      CarPlayHudModule.shared = self
    }

    OnDestroy {
      if CarPlayHudModule.shared === self {
        CarPlayHudModule.shared = nil
      }
    }

    AsyncFunction("update") { (data: HudData) in
      self.hudView?.update(data: data)
    }
    .runOnQueue(.main)

    AsyncFunction("show") { }.runOnQueue(.main)
    AsyncFunction("hide") { }.runOnQueue(.main)
  }

  // MARK: - Called from CarPlaySceneDelegate (main queue only)

  func attachHUD(to window: UIWindow) {
    let vc = UIViewController()
    vc.view.backgroundColor = UIColor(red: 0.043, green: 0.051, blue: 0.071, alpha: 1)

    // Use window.bounds (valid now) not vc.view.bounds (zero until VC enters hierarchy).
    let hud = CarPlayHudView(frame: window.bounds)
    hud.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    vc.view.addSubview(hud)

    hudVC = vc
    hudView = hud
    window.rootViewController = vc
  }

  // Re-asserts our rootVC if CarPlay has replaced it asynchronously.
  func reattachIfNeeded(to window: UIWindow) {
    guard let vc = hudVC, window.rootViewController !== vc else { return }
    window.rootViewController = vc
  }

  func removeHUD() {
    hudView?.removeFromSuperview()
    hudView = nil
    hudVC = nil
  }
}

struct HudData: Record {
  @Field var speed: Int = -1
  @Field var speedColor: String = "#ffffff"
  @Field var limit: Int?
  @Field var unit: String = "mph"
}
