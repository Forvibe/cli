import UIKit
import StoreKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    let apiKey = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE-FAKEFAKE"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        return true
    }

    func createAccount(email: String) {
        // Fixture placeholder: real account creation logic lives elsewhere.
        print("Creating account for \(email)")
    }
}
