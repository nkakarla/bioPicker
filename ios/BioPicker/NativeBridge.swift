import UIKit
import UserNotifications
import WebKit

/// The page talks to the app through `window.webkit.messageHandlers.bpNative.postMessage({type: …})`,
/// and the app answers through `window.bpNative.*` (see public/assets/app.js).
/// Messages are only accepted from the BioPicker server the app is pointed at.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let shared = NativeBridge()
    static let handlerName = "bpNative"

    weak var webView: WKWebView?
    var serverURL: URL = ServerConfig.url
    private var pendingHash: String?
    private var deviceToken: String?
    private var pageReady = false

    #if DEBUG
    private let apnsEnvironment = "development"
    #else
    private let apnsEnvironment = "production"
    #endif

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard origin.protocol == serverURL.scheme, origin.host == serverURL.host, origin.port == (serverURL.port ?? 0),
              let body = message.body as? [String: Any], let type = body["type"] as? String else {
            replyHandler(nil, "Not allowed")
            return
        }
        switch type {
        case "pickPhotos":
            guard let s = body["uploadUrl"] as? String, let url = URL(string: s), url.host == serverURL.host, let web = webView else {
                replyHandler(nil, "Bad upload address")
                return
            }
            Task {
                do {
                    let json = try await PhotoImporter(webView: web).pickAndUpload(to: url)
                    replyHandler(json, nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }
        case "signedIn":
            replyHandler(true, nil)
            registerIfAllowed()
        case "wantNotifications":
            replyHandler(true, nil)
            askForNotifications()
        default:
            replyHandler(nil, "Unknown message \(type)")
        }
    }

    // MARK: page → native helpers

    func toast(_ text: String, error: Bool = false) {
        let js = "window.bpNative && window.bpNative.toast(\(Self.jsString(text)), \(error))"
        webView?.evaluateJavaScript(js)
    }

    func pageDidLoad() {
        pageReady = true
        if let hash = pendingHash {
            pendingHash = nil
            open(hash: hash)
        }
        if let token = deviceToken { sendToken(token) }
    }

    func pageWillLoad() { pageReady = false }

    /// Opens a place in the web app, e.g. "p=abc123&s=render" (from a tapped notification).
    func open(hash: String) {
        guard pageReady, let web = webView else {
            pendingHash = hash
            return
        }
        web.evaluateJavaScript("location.hash = \(Self.jsString(hash))")
    }

    // MARK: push notifications

    private func registerIfAllowed() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    /// Asked when a render starts: that's when "tell me when it's done" makes sense to the user.
    private func askForNotifications() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                    guard granted else { return }
                    DispatchQueue.main.async {
                        UIApplication.shared.registerForRemoteNotifications()
                        NativeBridge.shared.toast("We'll notify you when the film is ready.")
                    }
                }
            case .authorized, .provisional, .ephemeral:
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            default:
                break
            }
        }
    }

    func didRegister(deviceToken data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        if pageReady { sendToken(token) }
    }

    private func sendToken(_ token: String) {
        webView?.evaluateJavaScript("window.bpNative && window.bpNative.registerDevice(\(Self.jsString(token)), \(Self.jsString(apnsEnvironment)))")
    }

    static func jsString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(arr.dropFirst().dropLast())
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in NativeBridge.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("Push registration failed: \(error.localizedDescription)")
    }

    // show the banner even while the app is open
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    // tapping "Your film is ready" opens that biopic's Render step
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let id = info["projectId"] as? String, id.range(of: "^[A-Za-z0-9]{6,32}$", options: .regularExpression) != nil else { return }
        let step = (info["step"] as? String).flatMap { $0.range(of: "^[a-z]+$", options: .regularExpression) != nil ? $0 : nil } ?? "render"
        await MainActor.run { NativeBridge.shared.open(hash: "p=\(id)&s=\(step)") }
    }
}
