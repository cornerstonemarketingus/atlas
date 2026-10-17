import UIKit
import Capacitor
#if DEBUG
import Security
#endif

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
                let keychainQuery: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: "atlas.ci.nonsecret-check",
                    kSecAttrAccount as String: "probe",
                    kSecValueData as String: Data("nonsecret".utf8),
                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
                ]
                SecItemDelete(keychainQuery as CFDictionary)
                let keychainStatus = SecItemAdd(keychainQuery as CFDictionary, nil)
                SecItemDelete(keychainQuery as CFDictionary)
                NSLog("ATLAS_NATIVE_SMOKE keychainStatus=%d", keychainStatus)
                let probe = """
                (()=>{const s=window.__atlasSmokeStorage={stage:'set'};const key='atlas.ci.nonsecret-check';const call=(method,options)=>window.Capacitor.nativePromise('SecureStoragePlugin',method,options);call('set',{key,value:'nonsecret'}).then(()=>{s.stage='get';return call('get',{key})}).then(r=>{s.matches=r.value==='nonsecret';s.stage='remove';return call('remove',{key})}).then(()=>s.stage='complete').catch(()=>{s.failed=true;call('remove',{key}).catch(()=>{})});return true})()
                """
                (self?.window?.rootViewController as? CAPBridgeViewController)?.webView?.evaluateJavaScript(probe)
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                    let storage = "JSON.stringify(window.__atlasSmokeStorage || {})"
                    (self?.window?.rootViewController as? CAPBridgeViewController)?.webView?.evaluateJavaScript(storage) { result, error in
                        NSLog("%@", "ATLAS_NATIVE_SMOKE storage=\(result as? String ?? "unavailable") evaluationFailed=\(error != nil)")
                    }
                }
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
