import CarPlay
import UIKit

@objc(CarPlaySceneDelegate)
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {

    private var interfaceController: CPInterfaceController?
    private var carPlayWindow: UIWindow?

    // MARK: - 3-param (iOS passes CPWindow directly)

    func templateApplicationScene(
        _ scene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController,
        to window: CPWindow
    ) {
        self.interfaceController = interfaceController
        self.carPlayWindow = window
        connect(interfaceController: interfaceController, window: window)
    }

    // MARK: - 2-param fallback

    func templateApplicationScene(
        _ scene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController
        findWindowAndAttach(interfaceController: interfaceController, attempt: 0)
    }

    func templateApplicationScene(
        _ scene: CPTemplateApplicationScene,
        didDisconnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = nil
        self.carPlayWindow = nil
        DispatchQueue.main.async {
            CarPlayHudModule.shared?.removeHUD()
        }
    }

    // MARK: - Private

    private func connect(interfaceController: CPInterfaceController, window: UIWindow) {
        // Satisfy CarPlay's template requirement
        let blank = CPInformationTemplate(
            title: "Speed & Limit",
            layout: .leading,
            items: [],
            actions: []
        )
        interfaceController.setRootTemplate(blank, animated: false)

        // setRootTemplate causes CarPlay to asynchronously set its own rootViewController,
        // overwriting ours. We fight back by re-asserting at multiple intervals.
        tryAttach(window: window, attempt: 0)
        for delay in [0.3, 0.7, 1.5] as [Double] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                CarPlayHudModule.shared?.reattachIfNeeded(to: window)
            }
        }
    }

    private func findWindowAndAttach(interfaceController: CPInterfaceController, attempt: Int) {
        let window = carPlayWindow
            ?? UIApplication.shared.windows.first(where: { $0 is CPWindow })
            ?? UIApplication.shared.windows.first(where: { $0.screen != UIScreen.main })

        guard let w = window else {
            guard attempt < 10 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                self?.findWindowAndAttach(interfaceController: interfaceController, attempt: attempt + 1)
            }
            return
        }
        carPlayWindow = w
        connect(interfaceController: interfaceController, window: w)
    }

    private func tryAttach(window: UIWindow, attempt: Int) {
        if let module = CarPlayHudModule.shared {
            module.attachHUD(to: window)
        } else if attempt < 25 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                self?.tryAttach(window: window, attempt: attempt + 1)
            }
        }
    }
}
