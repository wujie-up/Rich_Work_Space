import Foundation
import IrohLib
import DeskLinkCore

let wireALPN = Data("work-desk/web-access/1".utf8)

func readFrame(_ stream: RecvStream) async throws -> [String: Any] {
    let size = try FrameCodec.length(try await stream.readExact(size: 4))
    let payload = try await stream.readExact(size: UInt32(size))
    guard let value = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
        throw LinkError.invalid("工作台返回了无效协议帧")
    }
    return value
}

func writeFrame(_ stream: SendStream, _ object: [String: Any]) async throws {
    try await stream.writeAll(buf: FrameCodec.encode(object))
}
