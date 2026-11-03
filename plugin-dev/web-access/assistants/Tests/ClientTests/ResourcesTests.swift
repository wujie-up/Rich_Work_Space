import XCTest
import WebKit
import IrohLib
@testable import DeskLinkClient

@MainActor
final class ResourcesTests: XCTestCase {
    func testSavedPairingDropsRelayHintsAndKeepsIdentityAndDirectAddresses() async throws {
        let builder = EndpointBuilder()
        builder.applyMinimal()
        try builder.bindAddr(addr: "127.0.0.1:0")
        let endpoint = try await builder.bind()
        do {
            let original = endpoint.addr()
            let old = EndpointAddr(id: original.id(), relayUrl: "https://usw1-1.relay.n0.iroh.link./",
                addresses: original.directAddresses())
            let saved = try SavedHost(hostId: original.id().description, ticket: EndpointTicket.fromAddr(addr: old).description)
            let direct = try saved.connectionAddress()
            XCTAssertNil(direct.relayUrl())
            let fallback = try saved.connectionAddress(relayURL: fallbackRelayURL)
            XCTAssertEqual(fallback.relayUrl(), fallbackRelayURL)
            XCTAssertEqual(fallback.id().description, saved.hostId)
            XCTAssertEqual(fallback.directAddresses(), old.directAddresses())
            XCTAssertEqual(direct.id().description, saved.hostId)
            XCTAssertEqual(direct.directAddresses(), old.directAddresses())
            XCTAssertThrowsError(try SavedHost(hostId: "different-host", ticket: saved.ticket).connectionAddress())
            try await endpoint.close()
        } catch {
            try await endpoint.close()
            throw error
        }
    }

    func testRPCDiagnosticsStayInThePinnedMainFrame() throws {
        let script = try BrowserDiagnostics.script(origin: URL(string: "https://127.0.0.1:51000")!)
        XCTAssertTrue(script.isForMainFrameOnly)
        XCTAssertEqual(script.injectionTime, .atDocumentStart)
        XCTAssertFalse(script.source.contains("__WORKSPACE_ORIGIN__"))
        XCTAssertTrue(script.source.contains("127.0.0.1:51000"))
    }

    func testBundleChecksAndOriginBoundScript() throws {
        let resources = try StaticResources.load()
        XCTAssertEqual(resources.version.count, 64)
        let url = URL(string: "https://127.0.0.1:51000")!
        XCTAssertEqual(URLComponents(url: resources.url(url), resolvingAgainstBaseURL: false)?.queryItems?.first?.value, resources.version)
        let script = try resources.script(origin: url)
        XCTAssertTrue(script.source.contains("location.origin"))
        XCTAssertTrue(script.source.contains("window.top"))
        XCTAssertTrue(script.isForMainFrameOnly)
        XCTAssertThrowsError(try StaticResources(directory: FileManager.default.temporaryDirectory))
    }

    func testCacheStoresAreIsolatedAndOnlyHTTPCacheSurvives() async throws {
        let first = StaticResources.store(hostId: UUID().uuidString)
        let second = StaticResources.store(hostId: UUID().uuidString)
        XCTAssertNotEqual(first.identifier, second.identifier)
        let cookie = HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/", .name: "session", .value: "temporary", .secure: "TRUE"])!
        await first.httpCookieStore.setCookie(cookie)
        let before = await first.httpCookieStore.allCookies()
        XCTAssertEqual(before.count, 1)
        await StaticResources.prepare(first)
        let after = await first.httpCookieStore.allCookies()
        XCTAssertTrue(after.isEmpty)
        await StaticResources.clear(first)
        await StaticResources.clear(second)
    }

    func testStableLoopbackAndOccupiedPortFallback() async throws {
        let host = UUID().uuidString
        let first = try Loopback(serviceId: "workspace", hostId: host)
        try await first.start()
        let origin = first.origin
        let occupied = try Loopback(serviceId: "workspace", hostId: host)
        try await occupied.start()
        XCTAssertNotEqual(occupied.origin, origin)
        XCTAssertTrue(occupied.origin.hasPrefix("https://127.0.0.1:"))
        await occupied.stop()
        await first.stop()
        let again = try Loopback(serviceId: "workspace", hostId: host)
        try await again.start()
        XCTAssertEqual(again.origin, origin)
        await again.stop()
    }
}
