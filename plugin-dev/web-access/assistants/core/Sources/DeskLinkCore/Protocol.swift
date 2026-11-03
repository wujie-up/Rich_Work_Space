import Foundation
import CryptoKit

public enum LinkError: LocalizedError {
    case invalid(String)
    public var errorDescription: String? {
        switch self { case .invalid(let message): return message }
    }
}

public struct Invitation: Codable, Sendable {
    public let version: Int
    public let hostId: String
    public let ticket: String
    public let pairId: String
    public let secret: String
    public let expiresAt: Double

    public init(version: Int, hostId: String, ticket: String, pairId: String, secret: String, expiresAt: Double) {
        self.version = version
        self.hostId = hostId
        self.ticket = ticket
        self.pairId = pairId
        self.secret = secret
        self.expiresAt = expiresAt
    }

    public func validate(now: Double = Date().timeIntervalSince1970 * 1000) throws {
        guard version == 1, expiresAt > now, !hostId.isEmpty, hostId.count <= 128, !pairId.isEmpty,
              ticket.count <= 4096, !ticket.isEmpty, Data(hex: secret)?.count == 32 else {
            throw LinkError.invalid("配对邀请无效或已过期")
        }
    }

    public func proof(deviceId: String, nonce: String) throws -> String {
        guard let bytes = Data(hex: secret), bytes.count == 32 else { throw LinkError.invalid("配对密钥无效") }
        let input = "work-desk/web-access/1\n\(hostId)\n\(deviceId)\n\(pairId)\n\(nonce)"
        return Data(HMAC<SHA256>.authenticationCode(for: Data(input.utf8), using: SymmetricKey(data: bytes))).hex
    }
}

public enum FrameCodec {
    public static func length(_ data: Data) throws -> Int {
        guard data.count == 4 else { throw LinkError.invalid("协议帧无效") }
        let size = data.reduce(0) { ($0 << 8) | Int($1) }
        guard size > 0, size <= 16384 else { throw LinkError.invalid("协议帧过大") }
        return size
    }

    public static func encode(_ object: [String: Any]) throws -> Data {
        let payload = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard payload.count <= 16384, !payload.isEmpty else { throw LinkError.invalid("协议帧过大") }
        let size = UInt32(payload.count)
        return Data([UInt8(size >> 24), UInt8((size >> 16) & 255), UInt8((size >> 8) & 255), UInt8(size & 255)]) + payload
    }
}

public enum ServiceList {
    public static func validate(_ services: [String]) throws {
        guard services.contains("workspace"), services.count <= 128, Set(services).count == services.count,
              services.allSatisfy({ $0 == "workspace" || $0.range(of: "^plugin:[a-z][a-z0-9-]{0,63}$", options: .regularExpression) != nil }) else {
            throw LinkError.invalid("工作台服务列表无效")
        }
    }
}

public struct LoopbackPolicy: Sendable {
    public let origins: Set<String>
    public init(origins: Set<String>) { self.origins = origins }
    public func allows(_ url: URL) -> Bool {
        guard url.scheme == "https", url.host == "127.0.0.1", let port = url.port, port >= 1024,
              url.user == nil, url.password == nil else { return false }
        return origins.contains("https://127.0.0.1:\(port)")
    }
}

public extension Data {
    init?(hex: String) {
        guard hex.count % 2 == 0, hex.allSatisfy({ $0.isHexDigit }) else { return nil }
        var bytes = [UInt8]()
        var index = hex.startIndex
        while index < hex.endIndex {
            let end = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<end], radix: 16) else { return nil }
            bytes.append(byte)
            index = end
        }
        self.init(bytes)
    }
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
