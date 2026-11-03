import XCTest
@testable import DeskLinkCore

final class ProtocolTests: XCTestCase {
    func testPairingProofMatchesHostWireFormat() throws {
        let invite = Invitation(version: 1, hostId: "host", ticket: "ticket", pairId: "pair", secret: String(repeating: "00", count: 32), expiresAt: 2000)
        XCTAssertEqual(try invite.proof(deviceId: "phone", nonce: "nonce"), "02b59518a75a8fa753a6f431360ffda50707a89d4fdae7443d778cef81bb8e6d")
        XCTAssertThrowsError(try invite.validate(now: 2001))
    }

    func testLoopbackDestinationsAndFrameLimits() throws {
        XCTAssertTrue(LoopbackPolicy(origins: ["https://127.0.0.1:49100"]).allows(URL(string: "https://127.0.0.1:49100/api/session")!))
        let policy = LoopbackPolicy(origins: ["https://127.0.0.1:49100"])
        for value in ["https://evil.example:49100", "http://127.0.0.1:49100", "https://127.0.0.1:22", "https://user@127.0.0.1:49100"] {
            XCTAssertFalse(policy.allows(URL(string: value)!))
        }
        XCTAssertThrowsError(try FrameCodec.length(Data([0, 1, 0, 1])))
        XCTAssertEqual(try FrameCodec.length(Data([0, 0, 0, 12])), 12)
        XCTAssertThrowsError(try ServiceList.validate(["workspace", "127.0.0.1:22"]))
        XCTAssertThrowsError(try ServiceList.validate(["workspace", "workspace"]))
    }
}
