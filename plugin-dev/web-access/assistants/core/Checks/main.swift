import Foundation
import DeskLinkCore

func rejects(_ operation: () throws -> Void) {
    do { try operation(); fatalError("Expected rejection") } catch {}
}
let invite = Invitation(version: 1, hostId: "host", ticket: "ticket", pairId: "pair", secret: String(repeating: "00", count: 32), expiresAt: 2000)
let proof = try invite.proof(deviceId: "phone", nonce: "nonce")
precondition(proof == "02b59518a75a8fa753a6f431360ffda50707a89d4fdae7443d778cef81bb8e6d")
rejects { try invite.validate(now: 2001) }
let policy = LoopbackPolicy(origins: ["https://127.0.0.1:49100"])
precondition(policy.allows(URL(string: "https://127.0.0.1:49100/api/session")!))
for text in ["https://evil.example:49100", "http://127.0.0.1:49100", "https://127.0.0.1:22", "https://user@127.0.0.1:49100"] {
    precondition(!policy.allows(URL(string: text)!))
}
rejects { _ = try FrameCodec.length(Data([0, 1, 0, 1])) }
let length = try FrameCodec.length(Data([0, 0, 0, 12]))
precondition(length == 12)
rejects { try ServiceList.validate(["workspace", "127.0.0.1:22"]) }
rejects { try ServiceList.validate(["workspace", "workspace"]) }
rejects { _ = try CertificateValidity.interval(Data([48, 255])) }
if CommandLine.arguments.count > 1 {
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let interval = try CertificateValidity.interval(data)
    precondition(interval.contains(Date()))
    precondition(!interval.contains(Date(timeIntervalSince1970: 0)))
}
print("CoreCheck passed: HMAC, invitation expiry, origin policy, frame bounds, service allowlist, certificate validity")

actor BlockedRead {
    var continuation: CheckedContinuation<Void, Never>?
    var released = false
    func wait() async {
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() {
        released = true
        continuation?.resume()
        continuation = nil
    }
}
struct ReadFailure: Error {}
let blocked = BlockedRead()
let fallback = Task {
    try await Task.sleep(for: .seconds(1))
    await blocked.release()
}
let began = ContinuousClock.now
do {
    try await runDuplex(upload: { throw ReadFailure() }, download: { await blocked.wait() }, close: { await blocked.release() })
    throw LinkError.invalid("Expected stream failure")
} catch is ReadFailure {}
fallback.cancel()
guard began.duration(to: .now) < .milliseconds(500) else { throw LinkError.invalid("Failed stream waited for its blocked sibling") }
print("CoreCheck passed: duplex failure closes the blocked sibling immediately")
