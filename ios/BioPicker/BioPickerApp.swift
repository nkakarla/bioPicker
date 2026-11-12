// BioPicker iOS shell. Copyright (c) 2026 EPerf
//
// A thin native wrapper around the BioPicker web app: a WKWebView pointed at a
// running BioPicker server (see ios/README.md). All the work happens server side.

import AVFoundation
import SwiftUI

@main
struct BioPickerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        // narration previews and films play even with the ring/silent switch on
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
        }
    }
}

enum ServerConfig {
    static let key = "serverURL"
    static let fallback = "https://biopicker.eperflabs.com/"

    static var url: URL {
        get { URL(string: UserDefaults.standard.string(forKey: key) ?? fallback) ?? URL(string: fallback)! }
        set { UserDefaults.standard.set(newValue.absoluteString, forKey: key) }
    }

    /// Accepts "192.168.1.5:8095", "myhost", "https://bio.example.com" and normalizes to a URL.
    static func parse(_ text: String) -> URL? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "http://" + s }
        guard let u = URL(string: s), let scheme = u.scheme, ["http", "https"].contains(scheme), u.host != nil else { return nil }
        return u
    }
}
