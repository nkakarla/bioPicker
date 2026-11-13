import SwiftUI

/// Shows the web app, or a "can't reach the server" screen with an editable address.
/// Shake the phone at any time to change the server address.
struct RootView: View {
    @State private var serverURL = ServerConfig.url
    @State private var loadError: String?
    @State private var showSettings = false
    @State private var reloadToken = 0

    static let background = Color(red: 0x0f / 255, green: 0x0d / 255, blue: 0x0a / 255)

    var body: some View {
        ZStack {
            Self.background.ignoresSafeArea()
            WebView(url: serverURL, reloadToken: reloadToken, onError: { loadError = $0 }, onLoaded: { loadError = nil })
                .ignoresSafeArea(.container, edges: .bottom)
                .opacity(loadError == nil ? 1 : 0)
            if let loadError {
                ServerErrorView(message: loadError, url: serverURL) { newURL in
                    apply(newURL)
                }
            }
        }
        .onShake { showSettings = true }
        .sheet(isPresented: $showSettings) {
            ServerSettingsView(current: serverURL) { newURL in
                showSettings = false
                apply(newURL)
            }
            .presentationDetents([.medium])
        }
    }

    private func apply(_ url: URL) {
        ServerConfig.url = url
        serverURL = url
        loadError = nil
        reloadToken += 1
    }
}

struct ServerErrorView: View {
    let message: String
    let url: URL
    let retry: (URL) -> Void
    @State private var text = ""

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "film.stack").font(.system(size: 44)).foregroundStyle(.orange)
            Text("Can't reach BioPicker").font(.title2.bold())
            Text(message).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            ServerField(text: $text)
            Button {
                if let u = ServerConfig.parse(text) { retry(u) }
            } label: {
                Text("Connect").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).tint(.orange)
            .disabled(ServerConfig.parse(text) == nil)
            Text("Check that the server is up, or enter another address (shake the phone to change it any time).")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(28)
        .frame(maxWidth: 460)
        .onAppear { text = url.absoluteString }
    }
}

struct ServerSettingsView: View {
    let current: URL
    let save: (URL) -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("BioPicker server").font(.headline)
            ServerField(text: $text)
            Button {
                if let u = ServerConfig.parse(text) { save(u) }
            } label: {
                Text("Save and reload").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).tint(.orange)
            .disabled(ServerConfig.parse(text) == nil)
            Spacer()
        }
        .padding(24)
        .onAppear { text = current.absoluteString }
    }
}

private struct ServerField: View {
    @Binding var text: String
    var body: some View {
        TextField("https://biopicker.eperflabs.com", text: $text)
            .textFieldStyle(.roundedBorder)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.go)
    }
}

// MARK: - shake gesture

extension UIWindow {
    open override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake { NotificationCenter.default.post(name: .deviceDidShake, object: nil) }
        super.motionEnded(motion, with: event)
    }
}

extension Notification.Name {
    static let deviceDidShake = Notification.Name("BioPickerDeviceDidShake")
}

extension View {
    func onShake(_ action: @escaping () -> Void) -> some View {
        onReceive(NotificationCenter.default.publisher(for: .deviceDidShake)) { _ in action() }
    }
}
