import Foundation
import SwiftUI
import CryptoKit
import Security
import Network
import IrohLib
import DeskLinkCore
#if os(iOS)
import UIKit
#endif

let fallbackRelayURL = "https://usw1-1.relay.n0.iroh.link./"

struct SavedHost: Codable {
    let hostId: String
    let ticket: String

    // Only an explicitly approved fallback may replace relay hints in saved invitations.
    func connectionAddress(relayURL: String? = nil) throws -> EndpointAddr {
        let address = try EndpointTicket.fromString(str: ticket).endpointAddr()
        guard address.id().description == hostId else { throw LinkError.invalid("工作台身份与邀请不一致") }
        return EndpointAddr(id: address.id(), relayUrl: relayURL, addresses: address.directAddresses())
    }
}

struct BrowserContext: Identifiable {
    let id = UUID()
    let url: URL
    let certificate: Data
    let policy: LoopbackPolicy
    let hostId: String?

    init(url: URL, certificate: Data, policy: LoopbackPolicy, hostId: String? = nil) {
        self.url = url
        self.certificate = certificate
        self.policy = policy
        self.hostId = hostId
    }
}

@MainActor
final class ClientModel: ObservableObject {
    // The FFI logger installs a process-wide subscriber and must be initialized only once.
    private static let transportLogging: Void = setLogLevel(level: .info)
    @Published var invitation = ""
    @Published var label = "我的设备"
    @Published var status = "尚未连接"
    @Published var busy = false
    @Published var saved: SavedHost?
    @Published var browser: BrowserContext?
    @Published var pageError: String?
    private var endpoint: Endpoint?
    private var connection: Connection?
    private var listeners = [Loopback]()
    private var operation: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var generation = UUID()
    private var backgroundUntil: Date?
    private var backgroundTimer: Task<Void, Never>?
    #if os(iOS)
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid
    #endif

    init(savedHost: SavedHost?) {
        _ = Self.transportLogging
        saved = savedHost
    }

    convenience init() {
        self.init(savedHost: nil)
        do {
            if let data = try Keychain.read("workspace") { saved = try JSONDecoder().decode(SavedHost.self, from: data) }
        } catch { status = "读取配对失败：\(error.localizedDescription)" }
    }

    // Transient inactivity includes system prompts; only actual backgrounding starts the bounded grace period.
    func sceneChanged(_ phase: ScenePhase, now: Date = Date()) async {
        switch phase {
        case .background:
            await enterBackground(now)
        case .active:
            await resumeForeground(now)
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    private func enterBackground(_ now: Date) async {
        guard backgroundUntil == nil else { return }
        guard browser != nil else {
            if busy { await disconnect(message: "连接准备已取消，请返回前台后重新连接") }
            return
        }
        backgroundUntil = now.addingTimeInterval(20)
        let id = generation
        FileHandle.standardError.write(Data("[web-access:client:INFO] operation=\(id) background-grace=20\n".utf8))
        #if os(iOS)
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "WorkDesk.AppSwitch") { [weak self] in
            Task { @MainActor in await self?.pauseBackgroundSession(id) }
        }
        #endif
        backgroundTimer = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(20)) } catch { return }
            await self?.pauseBackgroundSession(id)
        }
    }

    private func pauseBackgroundSession(_ id: UUID) async {
        guard generation == id, backgroundUntil != nil else { return }
        endBackgroundTask()
        await closeSession(message: "后台连接已暂停，返回前台后自动重连")
    }

    private func resumeForeground(_ now: Date) async {
        guard let deadline = backgroundUntil else { return }
        cancelBackgroundGrace()
        if now >= deadline || connection?.closeReason() != nil {
            await closeSession(message: "正在恢复工作台连接")
        }
        // A new grant obtains a fresh device session; never retry or replay a pending business request.
        if browser == nil, saved != nil { begin(pair: false) }
    }

    private func cancelBackgroundGrace() {
        backgroundUntil = nil
        backgroundTimer?.cancel()
        backgroundTimer = nil
        endBackgroundTask()
    }

    private func endBackgroundTask() {
        #if os(iOS)
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
        #endif
    }

    private func identity() throws -> Data {
        if let data = try Keychain.read("identity"), data.count == 32 { return data }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw LinkError.invalid("无法创建设备身份")
        }
        let data = Data(bytes)
        try Keychain.write("identity", data)
        return data
    }

    private func check(_ id: UUID) throws {
        guard generation == id, !Task.isCancelled else { throw CancellationError() }
    }

    // Record only connection stages and public identifiers; never serialize tickets or protocol frames.
    private func progress(_ message: String, _ id: UUID) {
        status = message
        FileHandle.standardError.write(Data("[web-access:client:INFO] operation=\(id) stage=\(message)\n".utf8))
    }

    // Only one explicit user operation owns the endpoint and all local receivers.
    func begin(pair: Bool) {
        guard !busy, browser == nil else { return }
        pageError = nil
        busy = true
        let id = UUID()
        generation = id
        progress(pair ? "正在准备配对" : "正在准备连接", id)
        operation = Task {
            do {
                if pair { try await self.pair(id) } else { try await self.connect(id) }
                try check(id)
                busy = false
                timer?.cancel()
                if browser != nil { monitor(id) } else { await disconnect(message: "配对完成，可以连接工作台") }
            } catch {
                if generation == id {
                    let failure = error as NSError
                    FileHandle.standardError.write(Data("[web-access:client:ERROR] operation=\(id) stage=\(status) domain=\(failure.domain) code=\(failure.code)\n".utf8))
                    await disconnect(message: "连接失败：\(error.localizedDescription)")
                }
            }
        }
        timer = Task {
            do { try await Task.sleep(for: .seconds(pair ? 125 : 30)) } catch { return }
            if generation == id {
                FileHandle.standardError.write(Data("[web-access:client:ERROR] operation=\(id) timeout stage=\(status)\n".utf8))
                await disconnect(message: "连接超时（\(status)），请检查网络并重试")
            }
        }
    }

    // End the direct-only endpoint before fallback so no pending dial can outlive its user operation.
    private func dial(_ host: SavedHost, _ id: UUID) async throws -> Connection {
        let address = try host.connectionAddress()
        progress("正在尝试 P2P 直连", id)
        let direct = try await Endpoint.bind(options: EndpointOptions(secretKey: identity(), alpns: [wireALPN],
            relayMode: RelayMode.disabled()))
        do { try check(id) } catch { try await direct.close(); throw error }
        endpoint = direct
        let deadline = Task {
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
            guard !Task.isCancelled, generation == id else { return }
            do { try await direct.close() }
            catch {
                FileHandle.standardError.write(Data("[web-access:client:ERROR] operation=\(id) host=\(host.hostId) direct-timeout-close=\(error)\n".utf8))
            }
        }
        do {
            let peer = try await direct.connect(addr: address, alpn: wireALPN)
            deadline.cancel()
            return peer
        } catch {
            deadline.cancel()
            try check(id)
            FileHandle.standardError.write(Data("[web-access:client:INFO] operation=\(id) host=\(host.hostId) direct-failed=\(error) fallback=us-west\n".utf8))
            try await direct.close()
        }
        try check(id)
        progress("直连未成功，正在连接美国加密中继", id)
        let fallback = try await Endpoint.bind(options: EndpointOptions(secretKey: identity(), alpns: [wireALPN],
            relayMode: RelayMode.customFromUrls(urls: [fallbackRelayURL])))
        do { try check(id) } catch { try await fallback.close(); throw error }
        endpoint = fallback
        return try await fallback.connect(addr: host.connectionAddress(relayURL: fallbackRelayURL), alpn: wireALPN)
    }

    private func open(_ host: SavedHost, _ id: UUID) async throws -> (BiStream, [String: Any]) {
        let network = NWPathMonitor()
        network.pathUpdateHandler = { path in
            FileHandle.standardError.write(Data("[web-access:client:INFO] operation=\(id) network=\(path.status) cellular=\(path.usesInterfaceType(.cellular)) wifi=\(path.usesInterfaceType(.wifi)) reason=\(path.unsatisfiedReason)\n".utf8))
        }
        network.start(queue: DispatchQueue(label: "web-access.connection-diagnostics"))
        defer { network.cancel() }
        let peer = try await dial(host, id)
        do { try check(id) } catch { try peer.close(errorCode: 0, reason: Data()); throw error }
        connection = peer
        guard peer.remoteId().description == host.hostId else { throw LinkError.invalid("工作台身份验证失败") }
        progress("正在打开身份验证通道", id)
        let stream = try await peer.openBi()
        try await writeFrame(stream.send(), ["type": "hello", "version": 1])
        progress("正在等待工作台身份验证", id)
        let challenge = try await readFrame(stream.recv())
        try check(id)
        guard challenge["type"] as? String == "challenge", challenge["hostId"] as? String == host.hostId,
              let nonce = challenge["nonce"] as? String, Data(hex: nonce)?.count == 32 else {
            throw LinkError.invalid("工作台握手验证失败")
        }
        return (stream, challenge)
    }

    private func pair(_ id: UUID) async throws {
        guard invitation.utf8.count <= 16384 else { throw LinkError.invalid("邀请内容过长") }
        let invite = try JSONDecoder().decode(Invitation.self, from: Data(invitation.utf8))
        try invite.validate()
        guard !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, label.count <= 64 else {
            throw LinkError.invalid("设备名称须为 1–64 个字符")
        }
        let host = SavedHost(hostId: invite.hostId, ticket: invite.ticket)
        status = "正在验证工作台身份"
        let (stream, challenge) = try await open(host, id)
        try check(id)
        guard let currentEndpoint = endpoint else { throw CancellationError() }
        let proof = try invite.proof(deviceId: currentEndpoint.id().description, nonce: challenge["nonce"] as! String)
        try await writeFrame(stream.send(), ["type": "pair", "pairId": invite.pairId, "label": label, "proof": proof])
        let pending = try await readFrame(stream.recv())
        guard pending["type"] as? String == "pending", let fingerprint = pending["fingerprint"] as? String else {
            throw LinkError.invalid("配对请求被拒绝")
        }
        try check(id)
        status = "请在 Mac 工作台确认设备指纹：\(fingerprint)"
        let reply = try await readFrame(stream.recv())
        try check(id)
        guard reply["type"] as? String == "paired" else { throw LinkError.invalid("工作台未批准配对") }
        if let previous = saved, previous.hostId != host.hostId {
            await StaticResources.clear(StaticResources.store(hostId: previous.hostId))
        }
        try Keychain.write("workspace", JSONEncoder().encode(host))
        saved = host
        invitation = ""
    }

    private func connect(_ id: UUID) async throws {
        guard let saved else { throw LinkError.invalid("请先配对工作台") }
        status = "正在连接工作台"
        let (stream, challenge) = try await open(saved, id)
        guard let services = challenge["services"] as? [String] else { throw LinkError.invalid("工作台未提供服务列表") }
        try ServiceList.validate(services)
        progress("正在启动工作台本地接收器", id)
        var origins = [String: String]()
        for service in services {
            try check(id)
            let receiver = try Loopback(serviceId: service, hostId: saved.hostId)
            listeners.append(receiver)
            try await receiver.start()
            try check(id)
            origins[service] = receiver.origin
        }
        try await writeFrame(stream.send(), ["type": "connect", "origins": origins])
        progress("正在等待工作台服务授权", id)
        let ready = try await readFrame(stream.recv())
        try check(id)
        guard ready["type"] as? String == "ready", ready["services"] as? [String] == services,
              let pem = ready["certificate"] as? String, let hash = ready["certificateHash"] as? String else {
            throw LinkError.invalid("工作台服务确认失败")
        }
        let base64 = pem.replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "").components(separatedBy: .whitespacesAndNewlines).joined()
        guard let certificate = Data(base64Encoded: base64), Data(SHA256.hash(data: certificate)).hex == hash,
              try CertificateValidity.interval(certificate).contains(Date()) else {
            throw LinkError.invalid("工作台证书无效或已过期")
        }
        try check(id)
        guard let peer = connection else { throw CancellationError() }
        for receiver in listeners {
            try check(id)
            await receiver.attach(peer)
            try check(id)
        }
        browser = BrowserContext(url: URL(string: origins["workspace"]!)!, certificate: certificate,
            policy: LoopbackPolicy(origins: Set(origins.values)), hostId: saved.hostId)
        progress("已连接，正在判断网络路径", id)
    }

    private func monitor(_ id: UUID) {
        timer = Task {
            var seconds = 0
            while generation == id, let peer = connection, !Task.isCancelled {
                let selected = peer.paths().first(where: { $0.isSelected })
                status = selected?.isRelay == true ? "已连接 · 加密中继" : selected?.isIp == true ? "已连接 · P2P 直连" : "已连接 · 路径协商中"
                // Bound transport diagnostics so a stalled asset can be distinguished from a closed app without logging Web data.
                if seconds <= 60, seconds % 5 == 0 {
                    let stats = peer.stats()
                    FileHandle.standardError.write(Data(("[web-access:client:INFO] operation=\(id) seconds=\(seconds) " +
                        "relay=\(selected?.isRelay == true) tx=\(stats.udpTxBytes) rx=\(stats.udpRxBytes) " +
                        "lost=\(stats.lostPackets) rtt=\(selected?.rttMs ?? 0) cwnd=\(selected?.stats.cwnd ?? 0) " +
                        "mtu=\(selected?.stats.currentMtu ?? 0)\n").utf8))
                }
                seconds += 1
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
        operation = Task {
            guard let peer = connection else { return }
            _ = await peer.closed()
            if generation == id { await closeSession(message: "连接已关闭，请手动重新连接") }
        }
    }

    func disconnect(message: String = "已断开；本次工作台访问会话已清除") async {
        cancelBackgroundGrace()
        await closeSession(message: message)
    }

    private func closeSession(message: String) async {
        FileHandle.standardError.write(Data("[web-access:client:INFO] operation=\(generation) disconnect browser=\(browser != nil) busy=\(busy)\n".utf8))
        generation = UUID()
        operation?.cancel()
        timer?.cancel()
        let cacheHost = browser?.hostId
        browser = nil
        pageError = nil
        busy = true
        status = message
        let previous = endpoint
        endpoint = nil
        connection = nil
        let receivers = listeners
        listeners = []
        for receiver in receivers { await receiver.stop() }
        do { try await previous?.close() }
        catch { status = "\(message)；关闭网络失败：\(error.localizedDescription)" }
        if let cacheHost { await StaticResources.prepare(StaticResources.store(hostId: cacheHost)) }
        busy = false
    }
}
