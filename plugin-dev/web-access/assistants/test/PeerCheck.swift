import AppKit
import WebKit
import CryptoKit
import Security
import IrohLib
import DeskLinkCore

@MainActor
final class ProbeNavigation: NSObject, WKNavigationDelegate {
    lazy var delegate = BrowserDelegate(context, onFailure: { [weak self] message in self?.reportedFailure = message })
    let context: BrowserContext
    var failure = ""
    var certificateRejected = false
    var reportedFailure = ""
    init(_ context: BrowserContext) { self.context = context }
    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        delegate.webView(view, decidePolicyFor: action, decisionHandler: decisionHandler)
    }
    func webView(_ view: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        delegate.webView(view, didReceive: challenge) { disposition, credential in
            if disposition == .cancelAuthenticationChallenge {
                self.certificateRejected = true
                let space = challenge.protectionSpace
                let chain = space.serverTrust.flatMap { SecTrustCopyCertificateChain($0) as? [SecCertificate] }
                let matches = chain?.first.map { SecCertificateCopyData($0) as Data == self.context.certificate }
                var trustError: CFError?
                let valid = space.serverTrust.map { SecTrustEvaluateWithError($0, &trustError) }
                FileHandle.standardError.write(Data("Pin diagnostic: method=\(space.authenticationMethod) port=\(space.port) leaf=\(String(describing: matches)) trust=\(String(describing: valid)) error=\(String(describing: trustError))\n".utf8))
                self.failure = "certificate challenge rejected"
            }
            completionHandler(disposition, credential)
        }
    }
    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failure = String(describing: error)
        delegate.webView(view, didFailProvisionalNavigation: navigation, withError: error)
    }
    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failure = String(describing: error)
        delegate.webView(view, didFail: navigation, withError: error)
    }
}

// This fixture uses ephemeral identities and temporary accounts, never the assistant Keychain.
@main
struct PeerCheck {
    static func emit(_ value: [String: Any]) throws {
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value) + Data([10]))
    }

    @MainActor
    static func loginPage(_ view: WKWebView) async throws {
        for _ in 0..<150 {
            if (try? await view.evaluateJavaScript("!!document.querySelector('.web-login')")) as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw LinkError.invalid("Bundled or fallback login page did not load")
    }

    @MainActor
    static func login(_ view: WKWebView) async throws {
        let status = try await view.callAsyncJavaScript("""
            const response = await fetch('/api/login', {method:'POST',headers:{'content-type':'application/json'},
                body:JSON.stringify({username:'tester',password:'testing-password'})});
            return response.status;
            """, arguments: [:], in: nil, contentWorld: .page) as? Int
        guard status == 200 else { throw LinkError.invalid("Cache fixture login failed") }
    }

    @MainActor
    static func cachedPlugin(_ view: WKWebView, origin: String) async throws {
        let loaded = try await view.callAsyncJavaScript("""
            const session = await (await fetch('/api/session')).json();
            const response = await fetch('/api/rpc', {method:'POST', headers:{'content-type':'application/json','x-deckpg-csrf':session.csrf},
                body:JSON.stringify({method:'plugins.list',args:[]})});
            const entry = (await response.json()).value[0].views[0].entry;
            return await new Promise((resolve, reject) => {
                const frame = document.createElement('iframe');
                const timer = setTimeout(() => reject(new Error('cached plugin timeout')), 10000);
                frame.onload = () => { clearTimeout(timer); resolve(true); };
                frame.src = pluginOrigin + '/' + entry + '?parent=' + encodeURIComponent(location.origin);
                document.body.appendChild(frame);
            });
            """, arguments: ["pluginOrigin": origin], in: nil, contentWorld: .page) as? Bool
        guard loaded == true else { throw LinkError.invalid("Cached plugin did not load") }
    }

    @MainActor
    static func resources(_ context: BrowserContext, pluginOrigin: String) async throws {
        let delegate = BrowserDelegate(context)
        let view = makeBrowser(context, delegate)
        try await loginPage(view)
        guard (try await view.evaluateJavaScript("window.__workDeskShellStarted")) as? String == (try StaticResources.load()).version else {
            throw LinkError.invalid("Built-in shell was not activated")
        }
        try emit(["type": "shell-local"])
        try await login(view)
        try await cachedPlugin(view, origin: pluginOrigin)
        try await Task.sleep(for: .milliseconds(500))
        delegate.stop(view)

        let againDelegate = BrowserDelegate(context)
        let again = makeBrowser(context, againDelegate)
        try await loginPage(again)
        let cookies = await again.configuration.websiteDataStore.httpCookieStore.allCookies()
        guard cookies.isEmpty else { throw LinkError.invalid("Previous grant cookie survived reconnect") }
        try await login(again)
        try await cachedPlugin(again, origin: pluginOrigin)
        try emit(["type": "cache-reused"])
        againDelegate.stop(again)

        let mismatch = BrowserContext(url: context.url.appendingPathComponent("index.html"), certificate: context.certificate,
            policy: context.policy)
        let mismatchDelegate = BrowserDelegate(mismatch)
        let remote = makeBrowser(mismatch, mismatchDelegate)
        try await loginPage(remote)
        guard (try await remote.evaluateJavaScript("!!window.__workDeskShellStarted")) as? Bool == false else {
            throw LinkError.invalid("Mismatched shell activated local code")
        }
        try emit(["type": "shell-mismatch"])
        mismatchDelegate.stop(remote)

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let js = Data("throw new Error('fixture injection failure');".utf8)
        let css = Data()
        let hashes = ["app.js": Data(SHA256.hash(data: js)).hex, "app.css": Data(SHA256.hash(data: css)).hex]
        let inventory = "{\"app.js\":\"\(hashes["app.js"]!)\",\"app.css\":\"\(hashes["app.css"]!)\"}"
        let version = Data(SHA256.hash(data: Data(inventory.utf8))).hex
        try js.write(to: directory.appendingPathComponent("app.js"))
        try css.write(to: directory.appendingPathComponent("app.css"))
        try JSONSerialization.data(withJSONObject: ["version": version, "files": hashes]).write(to: directory.appendingPathComponent("shell-manifest.json"))
        let broken = try StaticResources(directory: directory)
        // The fixture makes the server negotiate this bundle once via its request header-free query.
        try emit(["type": "broken-version", "version": version, "files": hashes])
        try await Task.sleep(for: .milliseconds(200))
        let fallbackDelegate = BrowserDelegate(context, resourceLoader: { broken })
        let fallback = makeBrowser(context, fallbackDelegate)
        try await loginPage(fallback)
        try emit(["type": "shell-fallback"])
        fallbackDelegate.stop(fallback)
        await StaticResources.clear(StaticResources.store(hostId: context.hostId))
    }

    @MainActor
    static func main() async {
        do { try await run() }
        catch {
            FileHandle.standardError.write(Data("PeerCheck failed: \(error)\n".utf8))
            exit(1)
        }
    }

    @MainActor
    static func run() async throws {
        _ = NSApplication.shared
        let input = FileHandle.standardInput.availableData
        let invite = try JSONDecoder().decode(Invitation.self, from: input)
        try invite.validate()
        let builder = EndpointBuilder()
        builder.applyMinimal()
        try builder.bindAddr(addr: "127.0.0.1:0")
        let endpoint = try await builder.bind()
        let original = try EndpointTicket.fromString(str: invite.ticket).endpointAddr()
        let stale = EndpointAddr(id: original.id(), relayUrl: "https://aps1-1.relay.n0.iroh.link./", addresses: original.directAddresses())
        let saved = try SavedHost(hostId: invite.hostId, ticket: EndpointTicket.fromAddr(addr: stale).description)
        let address = try saved.connectionAddress()
        guard address.id().description == invite.hostId, address.directAddresses() == original.directAddresses(),
              address.relayUrl() == nil else {
            throw LinkError.invalid("Direct-only policy retained a relay or changed the pinned identity/direct paths")
        }
        do {
            _ = try SavedHost(hostId: endpoint.id().description, ticket: saved.ticket).connectionAddress()
            throw LinkError.invalid("Mismatched saved host identity was accepted")
        } catch LinkError.invalid("工作台身份与邀请不一致") { }
        let pairing = try await endpoint.connect(addr: address, alpn: wireALPN)
        let control = try await pairing.openBi()
        try await writeFrame(control.send(), ["type": "hello", "version": 1])
        let challenge = try await readFrame(control.recv())
        let proof = try invite.proof(deviceId: endpoint.id().description, nonce: challenge["nonce"] as! String)
        try await writeFrame(control.send(), ["type": "pair", "pairId": invite.pairId, "label": "Swift fixture", "proof": proof])
        let pending = try await readFrame(control.recv())
        try emit(pending)
        guard try await readFrame(control.recv())["type"] as? String == "paired" else { throw LinkError.invalid("Pair denied") }
        try pairing.close(errorCode: 0, reason: Data())

        let connection = try await endpoint.connect(addr: address, alpn: wireALPN)
        let handshake = try await connection.openBi()
        try await writeFrame(handshake.send(), ["type": "hello", "version": 1])
        let services = try await readFrame(handshake.recv())["services"] as! [String]
        try ServiceList.validate(services)
        var origins = [String: String]()
        var listeners = [Loopback]()
        for service in services {
            let receiver = try Loopback(serviceId: service)
            try await receiver.start()
            origins[service] = receiver.origin
            listeners.append(receiver)
        }
        try await writeFrame(handshake.send(), ["type": "connect", "origins": origins])
        let ready = try await readFrame(handshake.recv())
        let pem = ready["certificate"] as! String
        let base64 = pem.replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "").components(separatedBy: .whitespacesAndNewlines).joined()
        let certificate = Data(base64Encoded: base64)!
        guard Data(SHA256.hash(data: certificate)).hex == ready["certificateHash"] as? String else {
            throw LinkError.invalid("Certificate mismatch")
        }
        for receiver in listeners { await receiver.attach(connection) }
        var wrongCertificate = certificate
        wrongCertificate[0] ^= 1
        let rejected = BrowserContext(url: URL(string: origins["workspace"]!)!, certificate: wrongCertificate,
            policy: LoopbackPolicy(origins: Set(origins.values)))
        let rejectionDelegate = ProbeNavigation(rejected)
        let rejectionConfiguration = WKWebViewConfiguration()
        rejectionConfiguration.websiteDataStore = .nonPersistent()
        let rejectionView = WKWebView(frame: .zero, configuration: rejectionConfiguration)
        rejectionView.navigationDelegate = rejectionDelegate
        rejectionView.load(URLRequest(url: rejected.url))
        for _ in 0..<50 {
            if !rejectionDelegate.reportedFailure.isEmpty { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard rejectionDelegate.certificateRejected else { throw LinkError.invalid("Wrong certificate was not rejected by certificate policy") }
        guard !rejectionDelegate.reportedFailure.isEmpty else { throw LinkError.invalid("Navigation failure was hidden from the assistant") }
        rejectionView.stopLoading()
        let context = BrowserContext(url: URL(string: origins["workspace"]!)!, certificate: certificate,
            policy: LoopbackPolicy(origins: Set(origins.values)))
        let resourceContext = BrowserContext(url: context.url, certificate: certificate, policy: context.policy, hostId: UUID().uuidString)
        try await resources(resourceContext, pluginOrigin: origins["plugin:example"]!)
        // App switching must retain the same in-memory page, while explicit stop cancels foreground recovery.
        let lifecycle = ClientModel(savedHost: nil)
        lifecycle.browser = context
        let enteredBackground = Date()
        await lifecycle.sceneChanged(.inactive, now: enteredBackground)
        guard lifecycle.browser?.id == context.id else { throw LinkError.invalid("Inactive scene destroyed the login page") }
        await lifecycle.sceneChanged(.background, now: enteredBackground)
        await lifecycle.sceneChanged(.active, now: enteredBackground.addingTimeInterval(5))
        guard lifecycle.browser?.id == context.id else { throw LinkError.invalid("Short app switch destroyed the login page") }
        await lifecycle.sceneChanged(.background, now: enteredBackground)
        await lifecycle.sceneChanged(.active, now: enteredBackground.addingTimeInterval(21))
        guard lifecycle.browser == nil, !lifecycle.busy else { throw LinkError.invalid("Expired background page was retained") }
        lifecycle.browser = context
        await lifecycle.sceneChanged(.background, now: enteredBackground)
        await lifecycle.disconnect()
        await lifecycle.sceneChanged(.active, now: enteredBackground.addingTimeInterval(5))
        guard lifecycle.browser == nil, !lifecycle.busy,
              lifecycle.status == "已断开；工作台登录状态已清除" else {
            throw LinkError.invalid("Explicit stop was undone by a foreground transition")
        }
        let delegate = ProbeNavigation(context)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        view.navigationDelegate = delegate
        view.load(URLRequest(url: context.url))
        var loaded = false
        for _ in 0..<100 {
            if (try? await view.evaluateJavaScript("document.readyState")) as? String == "complete",
               (try? await view.evaluateJavaScript("location.origin")) as? String == origins["workspace"] {
                loaded = true
                break
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard loaded else { throw LinkError.invalid("Pinned WebKit page did not load: \(delegate.failure)") }
        // A user must be able to pause at login after the HTTP keep-alive socket expires.
        try await Task.sleep(for: .seconds(8))
        guard connection.closeReason() == nil else {
            throw LinkError.invalid("Workspace connection closed while login page was idle: \(connection.closeReason()!)")
        }
        delegate.delegate.webView(view, didFail: nil, withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
        guard delegate.reportedFailure.isEmpty else { throw LinkError.invalid("Normal navigation cancellation was reported as a failure") }
        let result = try await view.callAsyncJavaScript("""
            const before = await fetch('/api/session');
            const login = await fetch('/api/login', {method:'POST',headers:{'content-type':'application/json'},
                body:JSON.stringify({username:'tester',password:'testing-password'})});
            const session = await fetch('/api/session');
            return [before.status,login.status,session.status];
            """, arguments: [:], in: nil, contentWorld: .page) as? [Int]
        guard result == [401, 200, 200] else { throw LinkError.invalid("Pinned WebKit login failed: \(String(describing: result))") }
        let pluginLoaded = try await view.callAsyncJavaScript("""
            return await new Promise((resolve, reject) => {
                const frame = document.createElement('iframe');
                const timer = setTimeout(() => reject(new Error('plugin iframe timeout')), 5000);
                const receive = event => {
                    if (event.origin === pluginOrigin && event.source === frame.contentWindow && event.data === 'desk-plugin-fixture') {
                        clearTimeout(timer);
                        window.removeEventListener('message', receive);
                        resolve(true);
                    }
                };
                window.addEventListener('message', receive);
                frame.src = pluginOrigin + '/index.html?parent=' + encodeURIComponent(location.origin);
                document.body.appendChild(frame);
            });
            """, arguments: ["pluginOrigin": origins["plugin:example"]!], in: nil, contentWorld: .page) as? Bool
        guard pluginLoaded == true else { throw LinkError.invalid("Pinned plugin iframe failed") }
        view.stopLoading()
        for receiver in listeners { await receiver.stop() }
        try await endpoint.close()
        try emit(["type": "verified", "checks": "Swift/Node pairing, QUIC, loopback TLS, wrong-pin rejection, WebKit login, plugin iframe"])
    }
}
