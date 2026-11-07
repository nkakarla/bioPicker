import Photos
import SafariServices
import SwiftUI
import WebKit

/// WKWebView host for the BioPicker web app.
/// Handles what a plain WKWebView leaves out: downloads (Word, backup zip, MP4, captions)
/// go to the share sheet, JS alert/confirm/prompt get native dialogs, new-window links
/// open in place (same server) or in Safari (elsewhere), and pull-to-refresh reloads.
struct WebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    let onError: (String) -> Void
    let onLoaded: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps the login cookie and localStorage between launches
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = [] // voice previews play after an async fetch
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        config.userContentController.addScriptMessageHandler(NativeBridge.shared, contentWorld: .page, name: NativeBridge.handlerName)

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = UIColor(RootView.background)
        web.scrollView.backgroundColor = UIColor(RootView.background)
        web.isInspectable = true // Safari ▸ Develop ▸ iPhone for debugging
        web.customUserAgent = nil
        let refresh = UIRefreshControl()
        refresh.tintColor = .systemOrange
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.pullToRefresh(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh

        context.coordinator.web = web
        context.coordinator.loadedToken = reloadToken
        NativeBridge.shared.webView = web
        NativeBridge.shared.serverURL = url
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.loadedToken != reloadToken {
            context.coordinator.loadedToken = reloadToken
            NativeBridge.shared.serverURL = url
            web.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        var parent: WebView
        weak var web: WKWebView?
        var loadedToken = 0
        private var downloadFiles: [ObjectIdentifier: URL] = [:]

        init(_ parent: WebView) { self.parent = parent }

        @objc func pullToRefresh(_ sender: UIRefreshControl) {
            if web?.url == nil { web?.load(URLRequest(url: parent.url)) } else { web?.reload() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { sender.endRefreshing() }
        }

        private var isSameServer: (URL?) -> Bool {
            { [parent] u in u?.host == parent.url.host && u?.port == parent.url.port }
        }

        // MARK: navigation

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            if action.shouldPerformDownload { return .download }
            guard let u = action.request.url, let scheme = u.scheme?.lowercased() else { return .allow }
            // otpauth:// (add to authenticator), mailto:, tel: … belong to other apps
            if !["http", "https", "about", "blob", "data"].contains(scheme) {
                await UIApplication.shared.open(u)
                return .cancel
            }
            if action.targetFrame?.isMainFrame == true && ["http", "https"].contains(scheme) && !isSameServer(u) {
                await UIApplication.shared.open(u)
                return .cancel
            }
            if action.targetFrame?.isMainFrame == true { NativeBridge.shared.pageWillLoad() }
            return .allow
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            if let http = response.response as? HTTPURLResponse,
               let cd = http.value(forHTTPHeaderField: "Content-Disposition"), cd.lowercased().hasPrefix("attachment") {
                return .download
            }
            return response.canShowMIMEType ? .allow : .download
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.scrollView.refreshControl?.endRefreshing()
            parent.onLoaded()
            NativeBridge.shared.pageDidLoad()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        private func fail(_ error: Error) {
            web?.scrollView.refreshControl?.endRefreshing()
            let ns = error as NSError
            // cancelled navigations and "frame load interrupted" (a download took over) are not failures
            if ns.code == NSURLErrorCancelled || (ns.domain == "WebKitErrorDomain" && ns.code == 102) { return }
            parent.onError(ns.localizedDescription)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

        // MARK: downloads → share sheet

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Downloads", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = dir.appendingPathComponent(suggestedFilename.isEmpty ? "download" : suggestedFilename)
            try? FileManager.default.removeItem(at: dest)
            downloadFiles[ObjectIdentifier(download)] = dest
            return dest
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) else { return }
            if ["mp4", "mov", "m4v"].contains(file.pathExtension.lowercased()) {
                let a = UIAlertController(title: "Your film", message: file.lastPathComponent, preferredStyle: .actionSheet)
                a.addAction(UIAlertAction(title: "Save to Photos", style: .default) { [weak self] _ in self?.saveVideoToPhotos(file) })
                a.addAction(UIAlertAction(title: "Share…", style: .default) { [weak self] _ in self?.share(file) })
                a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
                present(a)
            } else {
                share(file)
            }
        }

        private func share(_ file: URL) {
            present(UIActivityViewController(activityItems: [file], applicationActivities: nil))
        }

        private func saveVideoToPhotos(_ file: URL) {
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                guard status == .authorized || status == .limited else {
                    DispatchQueue.main.async { self.alert(title: "Can't save to Photos", message: "Allow BioPicker to add photos in Settings ▸ BioPicker ▸ Photos.") }
                    return
                }
                PHPhotoLibrary.shared().performChanges({
                    PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: file)
                }) { ok, error in
                    DispatchQueue.main.async {
                        if ok { NativeBridge.shared.toast("Saved to Photos.") }
                        else { self.alert(title: "Couldn't save the film", message: error?.localizedDescription ?? "") }
                    }
                }
            }
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            downloadFiles.removeValue(forKey: ObjectIdentifier(download))
            alert(title: "Download failed", message: error.localizedDescription)
        }

        // MARK: windows and JS dialogs

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // links that open a new window (Terms, Privacy, a public film) show in an in-app browser,
            // so whatever is on the page underneath (e.g. a half-filled sign-up form) is kept
            if let u = action.request.url, ["http", "https"].contains(u.scheme?.lowercased() ?? "") {
                present(SFSafariViewController(url: u))
            } else if let u = action.request.url {
                UIApplication.shared.open(u)
            }
            return nil
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(a, orElse: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            present(a, orElse: { completionHandler(false) })
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            a.addTextField { $0.text = defaultText }
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { [weak a] _ in completionHandler(a?.textFields?.first?.text) })
            present(a, orElse: { completionHandler(nil) })
        }

        // MARK: helpers

        private func alert(title: String, message: String) {
            let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default))
            present(a)
        }

        private func present(_ vc: UIViewController, orElse fallback: (() -> Void)? = nil) {
            guard let web, var top = web.window?.rootViewController else { fallback?(); return }
            while let next = top.presentedViewController { top = next }
            if let pop = vc.popoverPresentationController { // iPad
                pop.sourceView = web
                pop.sourceRect = CGRect(x: web.bounds.midX, y: web.bounds.midY, width: 0, height: 0)
                pop.permittedArrowDirections = []
            }
            top.present(vc, animated: true)
        }
    }
}
