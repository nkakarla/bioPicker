import ImageIO
import Photos
import PhotosUI
import UniformTypeIdentifiers
import WebKit

/// Native photo picking for the "Photos & documents" step.
/// Unlike a web file input, this keeps the date and place each photo was taken (from the file's
/// metadata, or from the Photos library when the file lacks it), converts HEIC to JPEG, and
/// uploads straight to the server with the signed-in session.
@MainActor
final class PhotoImporter: NSObject, PHPickerViewControllerDelegate {
    private let webView: WKWebView
    private var continuation: CheckedContinuation<[PHPickerResult], Never>?
    private static let chunkSize = 20

    init(webView: WKWebView) { self.webView = webView }

    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ s: String) { errorDescription = s }
    }

    /// Returns the server's JSON ({project, errors, added}) as a string, or nil if the user cancelled.
    func pickAndUpload(to url: URL) async throws -> String? {
        let results = await pick()
        if results.isEmpty { return nil }
        let bridge = NativeBridge.shared

        // Library access is only needed for photos whose files don't carry a date or place.
        var files: [(name: String, data: Data)] = []
        var lastProject: Any?
        var errors: [String] = []
        var added = 0
        var askedLibrary = false

        for (i, r) in results.enumerated() {
            bridge.toast("Preparing photo \(i + 1) of \(results.count)…")
            do {
                var data = try await Self.loadImageData(r.itemProvider)
                var meta = Self.metadata(of: data)
                if (meta.date == nil || !meta.hasGPS), let id = r.assetIdentifier {
                    if !askedLibrary, PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined {
                        askedLibrary = true
                        _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
                    }
                    if let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject {
                        meta.fill(from: asset)
                    }
                }
                data = try Self.jpeg(from: data, meta: meta)
                let base = (r.itemProvider.suggestedName ?? "photo-\(i + 1)").replacingOccurrences(of: "/", with: "-")
                files.append((name: "\(base).jpg", data: data))
            } catch {
                errors.append("\(r.itemProvider.suggestedName ?? "A photo"): \(error.localizedDescription)")
            }
            if files.count == Self.chunkSize || (i == results.count - 1 && !files.isEmpty) {
                bridge.toast("Uploading \(added + files.count) of \(results.count)…")
                let response = try await upload(files, to: url)
                lastProject = response["project"] ?? lastProject
                let rejected = (response["errors"] as? [String]) ?? []
                errors += rejected
                added += max(0, files.count - rejected.count)
                files.removeAll()
            }
        }
        var out: [String: Any] = ["errors": errors, "added": added]
        if let lastProject { out["project"] = lastProject }
        let json = try JSONSerialization.data(withJSONObject: out)
        return String(data: json, encoding: .utf8)
    }

    // MARK: picker

    private func pick() async -> [PHPickerResult] {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .images
        config.selectionLimit = 200
        config.selection = .ordered
        config.preferredAssetRepresentationMode = .current // originals, with their metadata
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        guard var top = webView.window?.rootViewController else { return [] }
        while let next = top.presentedViewController { top = next }
        return await withCheckedContinuation { c in
            continuation = c
            top.present(picker, animated: true)
        }
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        Task { @MainActor in
            picker.dismiss(animated: true)
            self.continuation?.resume(returning: results)
            self.continuation = nil
        }
    }

    private static func loadImageData(_ provider: NSItemProvider) async throws -> Data {
        try await withCheckedThrowingContinuation { c in
            provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, error in
                // the file is deleted when this block returns, so read it now
                if let url, let data = try? Data(contentsOf: url) { c.resume(returning: data) }
                else { c.resume(throwing: error ?? Failure("Couldn't read this photo.")) }
            }
        }
    }

    // MARK: metadata

    struct Meta {
        var properties: [CFString: Any]
        var date: String? // EXIF "yyyy:MM:dd HH:mm:ss"
        var hasGPS: Bool

        mutating func fill(from asset: PHAsset) {
            if date == nil, let d = asset.creationDate {
                let f = DateFormatter()
                f.locale = Locale(identifier: "en_US_POSIX")
                f.dateFormat = "yyyy:MM:dd HH:mm:ss"
                let s = f.string(from: d)
                var exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
                exif[kCGImagePropertyExifDateTimeOriginal] = s
                properties[kCGImagePropertyExifDictionary] = exif
                date = s
            }
            if !hasGPS, let loc = asset.location {
                let c = loc.coordinate
                properties[kCGImagePropertyGPSDictionary] = [
                    kCGImagePropertyGPSLatitude: abs(c.latitude),
                    kCGImagePropertyGPSLatitudeRef: c.latitude >= 0 ? "N" : "S",
                    kCGImagePropertyGPSLongitude: abs(c.longitude),
                    kCGImagePropertyGPSLongitudeRef: c.longitude >= 0 ? "E" : "W",
                    kCGImagePropertyGPSAltitude: abs(loc.altitude),
                ] as [CFString: Any]
                hasGPS = true
            }
        }
    }

    private static func metadata(of data: Data) -> Meta {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else {
            return Meta(properties: [:], date: nil, hasGPS: false)
        }
        let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any]
        let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
        let date = (exif?[kCGImagePropertyExifDateTimeOriginal] ?? exif?[kCGImagePropertyExifDateTimeDigitized] ?? tiff?[kCGImagePropertyTIFFDateTime]) as? String
        let gps = props[kCGImagePropertyGPSDictionary] as? [CFString: Any]
        return Meta(properties: props, date: date, hasGPS: gps?[kCGImagePropertyGPSLatitude] != nil)
    }

    /// Re-encodes as JPEG (max 4096 px, upright) keeping EXIF, GPS and TIFF metadata.
    private static func jpeg(from data: Data, meta: Meta) throws -> Data {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { throw Failure("Unsupported image.") }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { throw Failure("Couldn't decode this photo.") }
        var props: [CFString: Any] = [:]
        for key in [kCGImagePropertyExifDictionary, kCGImagePropertyGPSDictionary, kCGImagePropertyTIFFDictionary, kCGImagePropertyIPTCDictionary] {
            if let v = meta.properties[key] { props[key] = v }
        }
        if var tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            tiff[kCGImagePropertyTIFFOrientation] = 1
            props[kCGImagePropertyTIFFDictionary] = tiff
        }
        props[kCGImagePropertyOrientation] = 1 // pixels are already upright
        props[kCGImageDestinationLossyCompressionQuality] = 0.9
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { throw Failure("Couldn't convert this photo.") }
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw Failure("Couldn't convert this photo.") }
        return out as Data
    }

    // MARK: upload (multipart, same fields as the web page)

    private func upload(_ files: [(name: String, data: Data)], to url: URL) async throws -> [String: Any] {
        let boundary = "bp-\(UUID().uuidString)"
        var body = Data()
        for f in files {
            let safe = f.name.replacingOccurrences(of: "\"", with: "'")
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"photos\"; filename=\"\(safe)\"\r\nContent-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
            body.append(f.data)
            body.append("\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        var req = URLRequest(url: url, timeoutInterval: 300)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
            .filter { url.host?.hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) == true }
        for (k, v) in HTTPCookie.requestHeaderFields(with: cookies) { req.setValue(v, forHTTPHeaderField: k) }

        let (data, response) = try await URLSession.shared.upload(for: req, from: body)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw Failure((json["error"] as? String) ?? "Upload failed (HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)).")
        }
        return json
    }
}
