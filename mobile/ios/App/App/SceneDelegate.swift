import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        #if DEBUG
        if ProcessInfo.processInfo.environment["ATLAS_NATIVE_SMOKE"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
                let script = "JSON.stringify({secureContext:window.isSecureContext,cryptoRandom:typeof window.crypto?.getRandomValues,bridge:typeof window.Capacitor?.nativePromise,headers:(window.Capacitor?.PluginHeaders || []).map(p=>p.name)})"
                (self?.window?.rootViewController as? CAPBridgeViewController)?.webView?.evaluateJavaScript(script) { result, error in
                    NSLog("%@", "ATLAS_NATIVE_SMOKE runtime=\(result as? String ?? "unavailable") evaluationFailed=\(error != nil)")
                }
            }
        }
        #endif

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
