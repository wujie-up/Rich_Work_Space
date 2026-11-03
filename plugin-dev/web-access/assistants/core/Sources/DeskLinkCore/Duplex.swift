// Closing both transports must unblock a sibling read before the task group waits for it.
public func runDuplex(upload: @escaping @Sendable () async throws -> Void,
                      download: @escaping @Sendable () async throws -> Void,
                      close: @escaping @Sendable () async -> Void) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask(operation: upload)
        group.addTask(operation: download)
        do { while try await group.next() != nil {} }
        catch {
            group.cancelAll()
            await close()
            throw error
        }
    }
}
