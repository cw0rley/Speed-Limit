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
        setupAndAttach(interfaceController: interfaceController, window: window)
    }

    // MARK: - 2-param fallback

    func templateApplicationScene(
        _ scene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController
        // Find window; retry if not ready yet
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

    private func setupAndAttach(interfaceController: CPInterfaceController, window: UIWindow) {
        // 1. Satisfy CarPlay's template requirement
        let blank = CPInformationTemplate(
            title: "Speed & Limit",
            layout: .leading,
            items: [],
            actions: []
        )
        interfaceController.setRootTemplate(blank, animated: false)

        // 2. Wait briefly for the template system to set its rootViewController,
        //    then replace it with ours. Retry until the module is initialised.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            self?.tryAttach(window: window, attempt: 0)
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
        setupAndAttach(interfaceController: interfaceController, window: w)
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
