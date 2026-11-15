import StoreKit
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
            deliverUnfinished()
        case "wantNotifications":
            replyHandler(true, nil)
            askForNotifications()
        case "products":
            let ids = (body["ids"] as? [String]) ?? []
            Task {
                do {
                    // prices as the App Store shows them, in the person's currency
                    var prices: [String: String] = [:]
                    for p in try await Product.products(for: ids) { prices[p.id] = p.displayPrice }
                    replyHandler(Self.json(prices), nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }
        case "buy":
            guard let id = body["productId"] as? String, let tokenText = body["accountToken"] as? String,
                  let token = UUID(uuidString: tokenText) else {
                replyHandler(nil, "Bad purchase request")
                return
            }
            Task { await buy(productId: id, accountToken: token, reply: replyHandler) }
        case "finish":
            // the server has recorded the purchase, so the App Store can stop re-delivering it
            let id = UInt64((body["id"] as? String) ?? "") ?? 0
            Task {
                for await result in Transaction.unfinished {
                    if case .verified(let t) = result, t.id == id { await t.finish() }
                }
                replyHandler(true, nil)
            }
        case "restore":
            Task {
                do {
                    try await AppStore.sync()
                    var list: [String] = []
                    for await result in Transaction.currentEntitlements {
                        if case .verified(let t) = result, t.productType == .autoRenewable { list.append(result.jwsRepresentation) }
                    }
                    replyHandler(Self.json(list), nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }
        default:
            replyHandler(nil, "Unknown message \(type)")
        }
    }

    // MARK: In-App Purchase (StoreKit 2)
    // The server checks Apple's signature on every transaction and sets the plan; the app only relays them.
    // A transaction is finished only after the server has recorded it, so nothing is lost if the network drops.

    private func buy(productId: String, accountToken: UUID, reply: @escaping (Any?, String?) -> Void) async {
        do {
            guard let product = try await Product.products(for: [productId]).first else {
                reply(nil, "This plan isn't available in the App Store right now.")
                return
            }
            switch try await product.purchase(options: [.appAccountToken(accountToken)]) {
            case .success(let result):
                guard case .verified(let t) = result else {
                    reply(nil, "The App Store couldn't verify this purchase.")
                    return
                }
                reply(Self.json(["jws": result.jwsRepresentation, "id": String(t.id)]), nil)
            case .userCancelled, .pending: // pending: waiting for Ask to Buy approval; it arrives later via updates
                reply(nil, nil)
            @unknown default:
                reply(nil, nil)
            }
        } catch {
            reply(nil, error.localizedDescription)
        }
    }

    private var updatesTask: Task<Void, Never>?
    /// Renewals, refunds and purchases approved later arrive here, even while the app is closed.
    func listenForTransactions() {
        guard updatesTask == nil else { return }
        updatesTask = Task { [weak self] in
            for await result in Transaction.updates {
                guard case .verified(let t) = result else { continue }
                await self?.deliver(jws: result.jwsRepresentation, transaction: t)
            }
        }
    }

    /// Hands a transaction to the page, which sends it to the server; finished only when the server took it.
    private func deliver(jws: String, transaction: Transaction) async {
        guard pageReady, let web = webView else { return } // stays unfinished and comes back next launch
        let ok = try? await web.callAsyncJavaScript("return window.bpNative && window.bpNative.applePurchase ? await window.bpNative.applePurchase(jws) : false",
                                                    arguments: ["jws": jws], contentWorld: .page)
        if (ok as? Bool) == true { await transaction.finish() }
    }

    private func deliverUnfinished() {
        Task {
            for await result in Transaction.unfinished {
                if case .verified(let t) = result { await deliver(jws: result.jwsRepresentation, transaction: t) }
            }
        }
    }

    static func json(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
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
        Task { @MainActor in NativeBridge.shared.listenForTransactions() }
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
