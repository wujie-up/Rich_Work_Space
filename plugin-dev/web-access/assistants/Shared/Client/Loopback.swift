import Foundation
import CryptoKit
import Network
import IrohLib
import DeskLinkCore

// Each service owns a different loopback origin; no LAN listener, VPN or arbitrary target exists.
final class Loopback {
    let serviceId: String
    private var listener: NWListener
    private let queue = DispatchQueue(label: "work-desk.loopback")
    private var clients = [UUID: NWConnection]()
    private var tasks = [UUID: Task<Void, Never>]()
    private var stopped = false
    private(set) var origin = ""
    private var connection: Connection?
    var onFailure: ((Error) -> Void)?

    init(serviceId: String, hostId: String? = nil) throws {
        self.serviceId = serviceId
        let port: UInt16 = hostId.map {
            let hash = Array(SHA256.hash(data: Data("\($0):\(serviceId)".utf8)))
            return 49152 + (UInt16(hash[0]) << 8 | UInt16(hash[1])) % 16384
        } ?? 0
        self.listener = try Self.listener(port: port)
    }

    private static func listener(port: UInt16) throws -> NWListener {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
        parameters.allowLocalEndpointReuse = false
        return try NWListener(using: parameters)
    }

    // Occupied stable ports fall back to an exclusive random loopback listener, never to reuse or a LAN bind.
    func start() async throws {
        do {
            try await startListener()
        } catch NWError.posix(.EADDRINUSE) {
            listener.cancel()
            FileHandle.standardError.write(Data("[web-access:loopback:INFO] service=\(serviceId) stable-port-occupied=true fallback=random\n".utf8))
            listener = try Self.listener(port: 0)
            try await startListener()
        }
    }

    private func startListener() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            var completed = false
            listener.stateUpdateHandler = { [weak self] state in
                guard !completed else { return }
                if case .ready = state, let self, let port = self.listener.port {
                    completed = true
                    self.origin = "https://127.0.0.1:\(port.rawValue)"
                    continuation.resume()
                } else if case .failed(let error) = state {
                    completed = true
                    continuation.resume(throwing: error)
                } else if case .cancelled = state {
                    completed = true
                    continuation.resume(throwing: LinkError.invalid("本地服务已关闭"))
                }
            }
            listener.newConnectionHandler = { [weak self] client in self?.accept(client) }
            listener.start(queue: queue)
        }
    }

    func attach(_ connection: Connection) async {
        await withCheckedContinuation { continuation in
            queue.async { self.connection = connection; continuation.resume() }
        }
    }

    private func accept(_ client: NWConnection) {
        guard !stopped, let connection, clients.count < 32 else { client.cancel(); return }
        let id = UUID()
        clients[id] = client
        client.start(queue: queue)
        tasks[id] = Task { [weak self] in
            guard let self else { return }
            do {
                var uploaded = 0
                var downloaded = 0
                var uploads = 0
                var downloads = 0
                defer { self.log(id, "closed upload=\(uploaded) download=\(downloaded)") }
                let stream = try await connection.openBi()
                try await writeFrame(stream.send(), ["type": "stream", "serviceId": self.serviceId])
                try await runDuplex(upload: {
                        while !Task.isCancelled {
                            let data = try await self.receive(client)
                            if data.isEmpty { break }
                            try await stream.send().writeAll(buf: data)
                            uploaded += data.count
                            uploads += 1
                            if uploads <= 8 { self.log(id, "upload=\(data.count) total=\(uploaded)") }
                        }
                        try await stream.send().finish()
                    }, download: {
                        while !Task.isCancelled {
                            let data = try await stream.recv().read(sizeLimit: 65536)
                            if data.isEmpty { break }
                            try await self.send(client, data)
                            downloaded += data.count
                            downloads += 1
                            if downloads <= 8 { self.log(id, "download=\(data.count) total=\(downloaded)") }
                        }
                        client.cancel()
                    }, close: {
                        client.cancel()
                        try? await stream.recv().stop(errorCode: 0)
                        try? await stream.send().reset(errorCode: 0)
                    })
            } catch {
                if !Task.isCancelled {
                    let failure = error as NSError
                    self.log(id, "ERROR domain=\(failure.domain) code=\(failure.code)")
                    self.onFailure?(error)
                }
            }
            client.cancel()
            self.queue.async { self.clients.removeValue(forKey: id); self.tasks.removeValue(forKey: id) }
        }
    }

    // Cap metadata traces per stream; never record request or response bytes.
    private func log(_ id: UUID, _ event: String) {
        FileHandle.standardError.write(Data("[web-access:loopback] uptime=\(Int(ProcessInfo.processInfo.systemUptime)) service=\(serviceId) stream=\(id) \(event)\n".utf8))
    }

    private func receive(_ client: NWConnection) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            client.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: data ?? Data()) }
            }
        }
    }

    private func send(_ client: NWConnection, _ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            client.send(content: data, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
    }

    func stop() async {
        await withCheckedContinuation { continuation in
            queue.async {
                self.stopped = true
                self.listener.cancel()
                self.clients.values.forEach { $0.cancel() }
                self.tasks.values.forEach { $0.cancel() }
                self.connection = nil
                continuation.resume()
            }
        }
    }
}
