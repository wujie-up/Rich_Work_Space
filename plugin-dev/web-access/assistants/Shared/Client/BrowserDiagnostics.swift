import Foundation
import WebKit

enum BrowserDiagnostics {
    // Trace the two network stages without reading a second copy of a possibly large RPC response.
    static func script(origin: URL) throws -> WKUserScript {
        let value = "\(origin.scheme!)://\(origin.host!):\(origin.port ?? 443)"
        let encoded = String(data: try JSONEncoder().encode(value), encoding: .utf8)!
        return WKUserScript(source: source.replacingOccurrences(of: "__WORKSPACE_ORIGIN__", with: encoded),
                            injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    static let source = #"""
    (() => {
        if (window.top !== window || location.origin !== __WORKSPACE_ORIGIN__) return;
        const fetch = window.fetch;
        let count = 0;
        let sequence = 0;
        const label = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9.-]{0,79}$/.test(value) ? value : 'unknown';
        const failed = (stage, error) => console.error('[web-access:rpc:ERROR]', stage, label(error.name), new Error('RPC diagnostics').stack);
        const trace = (details, phase, started, extra = {}) => {
            if (count >= 512) return;
            count++;
            try {
                window.webkit.messageHandlers.workDeskResources.postMessage({
                    type: 'rpc-trace', ...details, phase, ms: String(Math.round(performance.now() - started)), ...extra
                });
            } catch (error) {
                failed('trace-failed', error);
            }
        };
        window.fetch = async function(input, options) {
            let details;
            const started = performance.now();
            try {
                const url = new URL(input, location.origin);
                if (url.origin === location.origin && url.pathname === '/api/rpc'
                    && options?.method === 'POST' && typeof options.body === 'string') {
                    const request = JSON.parse(options.body);
                    details = { id: String(++sequence), method: label(request.method), plugin: 'none', call: 'none' };
                    if (request.method === 'plugins.invoke') {
                        details.plugin = label(request.args?.[0]);
                        details.call = label(request.args?.[1]);
                    }
                }
            } catch (error) {
                failed('metadata-failed', error);
            }
            if (!details) return fetch.apply(this, arguments);
            trace(details, 'start', started);
            let response;
            try {
                response = await fetch.apply(this, arguments);
            } catch (error) {
                trace(details, 'fetch-failed', started, { error: label(error.name) });
                throw error;
            }
            try {
                trace(details, 'headers', started, { status: String(response.status), bytes: response.headers.get('content-length') || 'unknown' });
                const json = response.json;
                response.json = async function() {
                    try {
                        const result = await json.apply(this, arguments);
                        trace(details, result?.ok === false ? 'rpc-error' : 'complete', started);
                        return result;
                    } catch (error) {
                        trace(details, 'body-failed', started, { error: label(error.name) });
                        throw error;
                    }
                };
            } catch (error) {
                failed('response-trace-failed', error);
            }
            return response;
        };
    })();
    """#
}
