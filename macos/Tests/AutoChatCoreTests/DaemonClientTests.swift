import Darwin
import Foundation
import Testing
@testable import AutoChatCore

@Suite("DaemonClient against an in-process mock socket server", .serialized)
struct DaemonClientTests {
    @Test func subscribeSnapshotSayReplySnapshot() async throws {
        let paths = try makeTestHome(minSockPathBytes: 120)
        defer { removeTestHome(paths) }
        #expect(paths.sockPath.utf8.count > 103, "test home should exercise the long-path connectat route")
        let server = MockDaemonServer(path: paths.sockPath)
        try server.start()
        defer { server.stop() }

        let snapshots = Box<[Snapshot]>([])
        let states = Box<[DaemonClient.State]>([])
        let client = DaemonClient(socketPath: paths.sockPath, callbackQueue: DispatchQueue(label: "test"))
        client.setHandlers(onSnapshot: { s in snapshots.mutate { $0.append(s) } }, onState: { s in states.mutate { $0.append(s) } })
        client.start()
        defer { client.stop() }

        #expect(await eventually { snapshots.value.count == 1 })
        #expect(snapshots.value.first?.phase == .room)
        #expect(snapshots.value.first?.messages.isEmpty == true)
        #expect(client.currentState == .connected)

        let reply = try await client.send(.say("lol same"))
        #expect(reply.ok)
        #expect(await eventually { snapshots.value.last?.messages.last?.text == "lol same" })
        #expect(snapshots.value.last?.messages.last?.isSelf == true)
        #expect(server.commandNames == ["say"])

        // Join the Lounge off: out of the room, where there's no one to talk to.
        let off = try await client.send(.lounge(false))
        #expect(off.ok)
        #expect(await eventually { snapshots.value.last?.loungeOn == false })
        #expect(snapshots.value.last?.phase == .lounge)
        let refused = try await client.send(.say("anyone?"))
        #expect(!refused.ok)
        #expect(refused.error == "not in a room")
        #expect(server.receivedCommands.last?["on"] == nil)
        #expect(server.receivedCommands.dropLast().last?["on"] as? Bool == false)

        let ids = server.receivedCommands.compactMap { $0["id"] as? Int }
        #expect(ids.count == 3 && Set(ids).count == 3)
        #expect(states.value.contains(.connected))
    }

    @Test func pingReportsDaemon() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        #expect(await DaemonClient.ping(socketPath: paths.sockPath) == nil)
        let server = MockDaemonServer(path: paths.sockPath)
        try server.start()
        defer { server.stop() }
        #expect(await DaemonClient.ping(socketPath: paths.sockPath) == PingReply(phase: .room, isDaemon: true))
    }

    @Test func commandTimesOutWhenUnanswered() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let server = MockDaemonServer(path: paths.sockPath)
        server.silent = true
        try server.start()
        defer { server.stop() }
        let client = DaemonClient(socketPath: paths.sockPath, callbackQueue: DispatchQueue(label: "test"))
        client.start()
        defer { client.stop() }
        #expect(await eventually { client.currentState == .connected })
        await #expect(throws: CommandError.timedOut) {
            _ = try await client.send(.lounge(true), timeout: 0.3)
        }
    }

    @Test func sendWhileDisconnectedFailsFast() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let client = DaemonClient(socketPath: paths.sockPath, callbackQueue: DispatchQueue(label: "test"))
        client.start()
        defer { client.stop() }
        await #expect(throws: CommandError.notConnected) {
            _ = try await client.send(.lounge(true))
        }
    }

    @Test func reconnectsAfterTheDaemonRestarts() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let snapshots = Box(0)
        let client = DaemonClient(socketPath: paths.sockPath, callbackQueue: DispatchQueue(label: "test"), backoff: .init(initial: 0.05, maximum: 0.2))
        client.setHandlers(onSnapshot: { _ in snapshots.mutate { $0 += 1 } })
        client.start()
        defer { client.stop() }

        let first = MockDaemonServer(path: paths.sockPath)
        try first.start()
        #expect(await eventually { snapshots.value == 1 })
        first.stop()
        #expect(await eventually { client.currentState != .connected })

        let second = MockDaemonServer(path: paths.sockPath)
        try second.start()
        defer { second.stop() }
        #expect(await eventually { snapshots.value == 2 })
        #expect(client.currentState == .connected)
    }

    @Test func pendingCommandsFailOnDisconnect() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let server = MockDaemonServer(path: paths.sockPath)
        server.silent = true
        try server.start()
        let client = DaemonClient(socketPath: paths.sockPath, callbackQueue: DispatchQueue(label: "test"))
        client.start()
        defer { client.stop() }
        #expect(await eventually { client.currentState == .connected })
        let pending = Task { try await client.send(.dismissRequest, timeout: 5) }
        #expect(await eventually { server.commandNames == ["dismissRequest"] })
        server.stop()
        await #expect(throws: CommandError.disconnected) { _ = try await pending.value }
    }

    @Test func flagsAServerThatDoesNotSubscribe() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let server = MockDaemonServer(path: paths.sockPath)
        server.oneShotOnly = true
        try server.start()
        defer { server.stop() }
        let client = DaemonClient(socketPath: paths.sockPath, callbackQueue: DispatchQueue(label: "test"))
        client.start()
        defer { client.stop() }
        #expect(await eventually {
            if case .incompatible = client.currentState { return true }
            return false
        })
        #expect(await DaemonClient.ping(socketPath: paths.sockPath) == PingReply(phase: .room, isDaemon: false))
    }

    @Test func backoffGrowsAndCaps() {
        let b = DaemonClient.Backoff(initial: 0.25, maximum: 5)
        #expect(b.delay(attempt: 0) == 0.25)
        #expect(b.delay(attempt: 1) == 0.5)
        #expect(b.delay(attempt: 3) == 2)
        #expect(b.delay(attempt: 10) == 5)
        let r = DaemonSupervisor.Restart(initial: 1, maximum: 30)
        #expect([1, 2, 3, 4, 5, 6, 7].map { r.delay(failures: $0) } == [1, 2, 4, 8, 16, 30, 30])
    }
}
