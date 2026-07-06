import CarPlay
import ExpoModulesCore

public final class CarPlayHudModule: Module {
  static weak var shared: CarPlayHudModule?
  private(set) var hudView: CarPlayHudView?

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
    // Replace the window's rootViewController entirely rather than adding a subview.
    // CarPlay's template system sets its own private rootViewController when
    // setRootTemplate is called — overriding it here gives us full control of the screen.
    let hud = CarPlayHudView(frame: window.bounds)
    hud.translatesAutoresizingMaskIntoConstraints = false

    let vc = UIViewController()
    vc.view.backgroundColor = .black
    vc.view.addSubview(hud)
    NSLayoutConstraint.activate([
      hud.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
      hud.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
      hud.topAnchor.constraint(equalTo: vc.view.topAnchor),
      hud.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
    ])

    window.rootViewController = vc
    hudView = hud
  }

  func removeHUD() {
    hudView?.removeFromSuperview()
    hudView = nil
  }
}

struct HudData: Record {
  @Field var speed: Int = -1
  @Field var speedColor: String = "#ffffff"
  @Field var limit: Int?
  @Field var unit: String = "mph"
}
