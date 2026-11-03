import Foundation

// Check validity explicitly because a pinned self-signed certificate is also a trust anchor.
public enum CertificateValidity {
    private struct DER {
        let bytes: [UInt8]
        var offset = 0
        mutating func next() throws -> (UInt8, [UInt8]) {
            guard offset + 2 <= bytes.count else { throw LinkError.invalid("证书格式无效") }
            let tag = bytes[offset]
            var size = Int(bytes[offset + 1])
            offset += 2
            if size & 128 != 0 {
                let count = size & 127
                guard count > 0, count <= 4, offset + count <= bytes.count else { throw LinkError.invalid("证书长度无效") }
                size = 0
                for _ in 0..<count { size = size * 256 + Int(bytes[offset]); offset += 1 }
            }
            guard size <= bytes.count - offset else { throw LinkError.invalid("证书内容不完整") }
            let payload = Array(bytes[offset..<(offset + size)])
            offset += size
            return (tag, payload)
        }
    }

    public static func interval(_ certificate: Data) throws -> DateInterval {
        var root = DER(bytes: Array(certificate))
        let outer = try root.next()
        guard outer.0 == 48 else { throw LinkError.invalid("证书格式无效") }
        var sequence = DER(bytes: outer.1)
        let tbs = try sequence.next()
        guard tbs.0 == 48 else { throw LinkError.invalid("证书格式无效") }
        var fields = DER(bytes: tbs.1)
        let first = try fields.next()
        if first.0 == 160 { _ = try fields.next() }
        _ = try fields.next()
        _ = try fields.next()
        let validity = try fields.next()
        guard validity.0 == 48 else { throw LinkError.invalid("证书有效期无效") }
        var dates = DER(bytes: validity.1)
        let start = try date(dates.next())
        let end = try date(dates.next())
        guard end > start else { throw LinkError.invalid("证书有效期无效") }
        return DateInterval(start: start, end: end)
    }

    private static func date(_ field: (UInt8, [UInt8])) throws -> Date {
        guard [23, 24].contains(field.0), let text = String(bytes: field.1, encoding: .ascii), text.hasSuffix("Z") else {
            throw LinkError.invalid("证书日期无效")
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = field.0 == 23 ? "yyMMddHHmmss'Z'" : "yyyyMMddHHmmss'Z'"
        formatter.twoDigitStartDate = Date(timeIntervalSince1970: -631152000)
        guard let date = formatter.date(from: text) else { throw LinkError.invalid("证书日期无效") }
        return date
    }
}
