import Foundation
import CryptoKit
import WebKit
import DeskLinkCore

private final class ResourceBundleFinder: NSObject {}

struct StaticResources {
    let version: String
    private let javascript: String
    private let stylesheet: String

    init(directory: URL) throws {
        struct Manifest: Decodable { let version: String; let files: [String: String] }
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: directory.appendingPathComponent("shell-manifest.json")))
        let js = try Data(contentsOf: directory.appendingPathComponent("app.js"))
        let css = try Data(contentsOf: directory.appendingPathComponent("app.css"))
        let hashes = ["app.js": Data(SHA256.hash(data: js)).hex, "app.css": Data(SHA256.hash(data: css)).hex]
        let inventory = "{\"app.js\":\"\(hashes["app.js"]!)\",\"app.css\":\"\(hashes["app.css"]!)\"}"
        guard manifest.files == hashes, manifest.version == Data(SHA256.hash(data: Data(inventory.utf8))).hex,
              let javascript = String(data: js, encoding: .utf8), let stylesheet = String(data: css, encoding: .utf8) else {
            throw LinkError.invalid("内置工作台资源校验失败")
        }
        version = manifest.version
        self.javascript = javascript
        self.stylesheet = stylesheet
    }

    static func load() throws -> StaticResources {
        let roots = [Bundle.main.resourceURL, Bundle(for: ResourceBundleFinder.self).resourceURL, Bundle.main.bundleURL]
        let bundle = roots.compactMap { $0?.appendingPathComponent("DeskLink_DeskLinkClient.bundle") }.compactMap(Bundle.init(url:)).first
        guard let directory = bundle?.url(forResource: "WebShell", withExtension: nil) else {
            throw LinkError.invalid("内置工作台资源缺失")
        }
        return try StaticResources(directory: directory)
    }

    func url(_ origin: URL) -> URL {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "deskShell", value: version)]
        return components.url!
    }

    // Main-frame injection preserves the pinned HTTPS origin and never runs inside plugin frames.
    func script(origin: URL) throws -> WKUserScript {
        let encode = { (value: String) throws -> String in String(data: try JSONEncoder().encode(value), encoding: .utf8)! }
        let expectedOrigin = "\(origin.scheme!)://\(origin.host!):\(origin.port ?? 443)"
        let source = """
        (() => {
            if (window.top !== window || location.origin !== \(try encode(expectedOrigin))
                || document.documentElement.dataset.workDeskShell !== \(try encode(version))) return;
            try {
                const style = document.createElement('style');
                style.textContent = \(try encode(stylesheet));
                document.head.appendChild(style);
                window.__workDeskShellStarted = \(try encode(version));
                (async () => {
                    \(javascript)
                })().catch(() => window.webkit.messageHandlers.workDeskResources.postMessage({type:'fallback'}));
            } catch (_) {
                window.webkit.messageHandlers.workDeskResources.postMessage({type:'fallback'});
            }
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
    }

    @MainActor
    static func store(hostId: String?) -> WKWebsiteDataStore {
        guard let hostId else { return .nonPersistent() }
        let bytes = Array(SHA256.hash(data: Data("work-desk-cache:\(hostId)".utf8)).prefix(16))
        let identifier = UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                                     bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
        return WKWebsiteDataStore(forIdentifier: identifier)
    }

    // Only HTTP response caches survive a new grant. Cookies, storage, workers and credentials do not.
    @MainActor
    static func prepare(_ store: WKWebsiteDataStore) async {
        let remove = WKWebsiteDataStore.allWebsiteDataTypes().subtracting([WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache])
        await store.removeData(ofTypes: remove, modifiedSince: .distantPast)
    }

    @MainActor
    static func clear(_ store: WKWebsiteDataStore) async {
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }
}
