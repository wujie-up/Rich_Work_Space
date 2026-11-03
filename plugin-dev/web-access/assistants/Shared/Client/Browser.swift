import SwiftUI
import WebKit
import Security
import DeskLinkCore

final class BrowserDelegate: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let context: BrowserContext
    private let onFailure: (String) -> Void
    private var loading: Task<Void, Never>?
    private var remoteFallback = false
    private var resources: StaticResources?
    private var rpcTraces = 0
    private let resourceLoader: () throws -> StaticResources
    init(_ context: BrowserContext, onFailure: @escaping (String) -> Void = { _ in },
         resourceLoader: @escaping () throws -> StaticResources = StaticResources.load) {
        self.context = context
        self.onFailure = onFailure
        self.resourceLoader = resourceLoader
    }

    // Await session-data removal before the first network request can use a prior grant's cookie.
    func load(_ view: WKWebView) {
        loading = Task { @MainActor [weak self, weak view] in
            guard let self, let view else { return }
            await StaticResources.prepare(view.configuration.websiteDataStore)
            guard !Task.isCancelled else { return }
            do {
                view.configuration.userContentController.addUserScript(try BrowserDiagnostics.script(origin: context.url))
                let bundle = try resourceLoader()
                view.configuration.userContentController.addUserScript(try bundle.script(origin: context.url))
                resources = bundle
            } catch {
                resources = nil
                FileHandle.standardError.write(Data("[web-access:resources:ERROR] host=\(context.hostId ?? "temporary") fallback=remote error=\(error) stack=\(Thread.callStackSymbols)\n".utf8))
            }
            view.load(URLRequest(url: resources?.url(context.url) ?? context.url))
        }
    }

    func stop(_ view: WKWebView) {
        loading?.cancel()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "workDeskResources")
        view.stopLoading()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "https", origin.host == context.url.host,
              origin.port == context.url.port, let value = message.body as? [String: String] else { return }
        if value["type"] == "fallback", let view = message.webView {
            fallback(view)
        } else if value["type"] == "revoked", let view = message.webView {
            Task { @MainActor in await StaticResources.clear(view.configuration.websiteDataStore) }
        } else if value["type"] == "rpc-trace", rpcTraces < 512 {
            rpcTraces += 1
            let keys = ["id", "method", "plugin", "call", "phase", "ms", "status", "bytes", "error"]
            let fields = keys.compactMap { key -> String? in
                guard let field = value[key], field.range(of: "^[a-zA-Z0-9.-]{1,80}$", options: .regularExpression) != nil else { return nil }
                return "\(key)=\(field)"
            }.joined(separator: " ")
            let level = ["fetch-failed", "body-failed", "rpc-error"].contains(value["phase"]) ? "ERROR" : "INFO"
            FileHandle.standardError.write(Data("[web-access:rpc:\(level)] port=\(context.url.port ?? 0) \(fields)\n".utf8))
        }
    }

    private func fallback(_ view: WKWebView) {
        guard !remoteFallback else { return }
        remoteFallback = true
        FileHandle.standardError.write(Data("[web-access:resources:ERROR] host=\(context.hostId ?? "temporary") injection-failed=true fallback=remote\n".utf8))
        view.configuration.userContentController.removeAllUserScripts()
        view.load(URLRequest(url: context.url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if resources != nil, !remoteFallback {
            webView.evaluateJavaScript("!!document.documentElement.dataset.workDeskShell && !window.__workDeskShellStarted") { [weak self, weak webView] value, error in
                if value as? Bool == true || error != nil, let webView { self?.fallback(webView) }
            }
        }
        FileHandle.standardError.write(Data("[web-access:browser:INFO] loaded port=\(context.url.port ?? 0) size=\(webView.bounds.size)\n".utf8))
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        FileHandle.standardError.write(Data("[web-access:browser:INFO] loading port=\(context.url.port ?? 0) size=\(webView.bounds.size)\n".utf8))
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        FileHandle.standardError.write(Data("[web-access:browser:INFO] committed port=\(context.url.port ?? 0)\n".utf8))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        report(NSError(domain: "WorkDesk.WebContent", code: 1))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let response = navigationResponse.response
        FileHandle.standardError.write(Data("[web-access:browser:INFO] response port=\(response.url?.port ?? 0) status=\((response as? HTTPURLResponse)?.statusCode ?? 0) length=\(response.expectedContentLength) main=\(navigationResponse.isForMainFrame)\n".utf8))
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    // Surface navigation errors independently of the QUIC status; never log URLs, cookies or credentials.
    private func report(_ error: Error) {
        let failure = error as NSError
        guard failure.domain != NSURLErrorDomain || failure.code != NSURLErrorCancelled else { return }
        FileHandle.standardError.write(Data("[web-access:browser:ERROR] port=\(context.url.port ?? 0) domain=\(failure.domain) code=\(failure.code)\n".utf8))
        onFailure("网页加载失败：\(failure.domain)（\(failure.code)）。请断开后重新连接。")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = navigationAction.request.url.map(context.policy.allows) == true
        FileHandle.standardError.write(Data("[web-access:browser:INFO] navigation port=\(navigationAction.request.url?.port ?? 0) allowed=\(allowed)\n".utf8))
        decisionHandler(allowed ? .allow : .cancel)
    }

    // Trust only the leaf delivered over the authenticated QUIC connection, for this session's loopback origins.
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        FileHandle.standardError.write(Data("[web-access:browser:INFO] trust-start port=\(space.port)\n".utf8))
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let url = URL(string: "https://\(space.host):\(space.port)"), context.policy.allows(url),
              let trust = space.serverTrust, let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first, SecCertificateCopyData(leaf) as Data == context.certificate,
              let interval = try? CertificateValidity.interval(context.certificate), interval.contains(Date()) else {
            report(NSError(domain: "WorkDesk.Certificate", code: 1))
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, "127.0.0.1" as CFString))
        SecTrustSetAnchorCertificates(trust, [leaf] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        var trustError: CFError?
        FileHandle.standardError.write(Data("[web-access:browser:INFO] trust-evaluate port=\(space.port)\n".utf8))
        guard SecTrustEvaluateWithError(trust, &trustError) else {
            report(trustError.map { $0 as Error } ?? NSError(domain: "WorkDesk.Certificate", code: 2))
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        FileHandle.standardError.write(Data("[web-access:browser:INFO] trust-accepted port=\(space.port)\n".utf8))
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, context.policy.allows(url) { webView.load(navigationAction.request) }
        return nil
    }
}

#if os(macOS)
struct WorkspaceBrowser: NSViewRepresentable {
    let context: BrowserContext
    let onFailure: (String) -> Void
    func makeCoordinator() -> BrowserDelegate { BrowserDelegate(context, onFailure: onFailure) }
    func makeNSView(context coordinator: Context) -> WKWebView { makeBrowser(context, coordinator.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: BrowserDelegate) { coordinator.stop(view); view.loadHTMLString("", baseURL: nil) }
}
#else
struct WorkspaceBrowser: UIViewRepresentable {
    let context: BrowserContext
    let onFailure: (String) -> Void
    func makeCoordinator() -> BrowserDelegate { BrowserDelegate(context, onFailure: onFailure) }
    func makeUIView(context coordinator: Context) -> WKWebView { makeBrowser(context, coordinator.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: BrowserDelegate) { coordinator.stop(view); view.loadHTMLString("", baseURL: nil) }
}
#endif

@MainActor
func makeBrowser(_ context: BrowserContext, _ delegate: BrowserDelegate) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = StaticResources.store(hostId: context.hostId)
    config.userContentController.add(delegate, name: "workDeskResources")
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = delegate
    view.uiDelegate = delegate
    delegate.load(view)
    return view
}
