import Darwin
import Foundation
import Testing
@testable import AutoChatCore

/// The Node mock daemon (macos/dev/mock-daemon.mjs) driven through the real spawn/attach logic.
enum NodeMock {
    static let script = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("dev/mock-daemon.mjs").path

    static let searchPath = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"

    static let node: String? = searchPath.split(separator: ":")
        .map { "\($0)/node" }
        .first { FileManager.default.isExecutableFile(atPath: $0) }

    static var available: Bool { node != nil }

    static func binary() -> AutochatBinary {
        AutochatBinary(path: script, searchPath: searchPath)
    }

    static func environment(_ paths: AutochatPaths, scenario: String = "room") -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["AUTOCHAT_HOME"] = paths.home
        env["AUTOCHAT_MOCK_SCENARIO"] = scenario
        env["PATH"] = searchPath
        return env
    }
}

@Suite("Daemon lifecycle with the Node mock daemon", .serialized, .enabled(if: NodeMock.available, "node not found on PATH"))
@MainActor
struct DaemonLifecycleTests {
    @Test func spawnsSubscribesSaysAndShutsDownCleanly() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let sock = paths.sockPath
        let supervisor = DaemonSupervisor(
            socketPath: sock,
            spawnEnvironment: NodeMock.environment(paths),
            locate: { NodeMock.binary() }
        )
        supervisor.start()
        #expect(await eventually { await MainActor.run { supervisor.spawnedPID != nil } })
        let pid = try #require(supervisor.spawnedPID)
        #expect(supervisor.status == .spawned(pid: pid))

        let snapshots = Box<[Snapshot]>([])
        let client = DaemonClient(socketPath: sock, callbackQueue: DispatchQueue(label: "test"), backoff: .init(initial: 0.05, maximum: 0.3))
        client.setHandlers(onSnapshot: { s in snapshots.mutate { $0.append(s) } })
        client.start()
        defer { client.stop() }

        #expect(await eventually(timeout: 10) { snapshots.value.last?.phase == .room })
        let first = try #require(snapshots.value.last)
        #expect(first.members.count == 4)
        #expect(first.members.first?.isYou == true)
        #expect(first.room?.host == "jade-lynx-0c")
        #expect(first.now != nil)
        #expect(first.me?.handle == "stormy-newt-59")
        #expect(first.messages.contains { $0.kind == .sys })

        let reply = try await client.send(.say("ping"))
        #expect(reply.ok)
        #expect(await eventually { snapshots.value.last?.messages.contains { $0.isSelf && $0.text == "ping" } == true })
        #expect(await eventually { snapshots.value.last?.messages.last?.text == "pong" })
        let ids = snapshots.value.last?.messages.compactMap(\.mid) ?? []
        #expect(!ids.isEmpty && Set(ids).count == ids.count)

        let unknown = try await client.send(.returnNow)
        #expect(!unknown.ok)
        #expect(unknown.error == "no countdown running")

        let exited = await supervisor.shutdown(timeout: 3)
        #expect(exited)
        #expect(supervisor.status == .stopped)
        #expect(kill(pid, 0) != 0, "the spawned daemon should be gone")
        #expect(!FileManager.default.fileExists(atPath: sock), "a clean shutdown removes the socket")
    }

    @Test func attachesToARunningDaemonAndNeverSignalsIt() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let other = Process()
        other.executableURL = URL(fileURLWithPath: NodeMock.node!)
        other.arguments = [NodeMock.script, "daemon", "--quiet"]
        other.environment = NodeMock.environment(paths, scenario: "lounge")
        try other.run()
        defer { if other.isRunning { other.terminate() } }
        #expect(await eventually(timeout: 10) { await DaemonClient.ping(socketPath: paths.sockPath) != nil })

        let supervisor = DaemonSupervisor(socketPath: paths.sockPath, locate: { Issue.record("should not locate"); return nil })
        supervisor.start()
        #expect(await eventually { await MainActor.run { supervisor.status == .attached } })
        #expect(supervisor.spawnedPID == nil)
        #expect(await supervisor.shutdown(timeout: 1))
        #expect(other.isRunning, "quitting must not stop a daemon the app didn't spawn")
        #expect(await DaemonClient.ping(socketPath: paths.sockPath)?.isDaemon == true)
    }

    @Test func restartsACrashedDaemonWithBackoff() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let statuses = Box<[DaemonSupervisor.Status]>([])
        let supervisor = DaemonSupervisor(
            socketPath: paths.sockPath,
            restart: .init(initial: 0.2, maximum: 1),
            spawnEnvironment: NodeMock.environment(paths),
            locate: { NodeMock.binary() }
        )
        supervisor.onStatus = { s in statuses.mutate { $0.append(s) } }
        supervisor.start()
        #expect(await eventually(timeout: 10) { await DaemonClient.ping(socketPath: paths.sockPath) != nil })
        let firstPID = try #require(supervisor.spawnedPID)

        kill(firstPID, SIGKILL)
        #expect(await eventually { statuses.value.contains { if case .restarting = $0 { return true } else { return false } } })
        // SIGKILL leaves a stale socket file behind; the mock (like the core) reclaims it.
        #expect(await eventually(timeout: 10) { await MainActor.run { (supervisor.spawnedPID ?? firstPID) != firstPID } })
        #expect(await eventually(timeout: 10) { await DaemonClient.ping(socketPath: paths.sockPath) != nil })
        #expect(await supervisor.shutdown(timeout: 3))
    }

    @Test func reportsAMissingCLI() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let supervisor = DaemonSupervisor(socketPath: paths.sockPath, locate: { nil })
        supervisor.start()
        #expect(await eventually { await MainActor.run { supervisor.status == .cliMissing } })
        #expect(await supervisor.shutdown())
    }
}

@Suite("Locating the autochat CLI")
struct LocatorTests {
    @Test func overrideWinsAndPathIncludesItsDirectory() {
        let found = DaemonLocator.locate(override: NodeMock.script, environment: ["PATH": "/usr/bin:/bin", "HOME": "/nonexistent"], shellTimeout: 3)
        #expect(found?.path == NodeMock.script)
        let dir = (NodeMock.script as NSString).deletingLastPathComponent
        #expect(found?.searchPath.split(separator: ":").first.map(String.init) == dir)
        #expect(found?.searchPath.contains("/usr/bin") == true)
    }

    @Test func envOverride() {
        let found = DaemonLocator.locate(override: nil, environment: ["AUTOCHAT_BIN": NodeMock.script, "PATH": "/usr/bin", "HOME": "/nonexistent"], shellTimeout: 3)
        #expect(found?.path == NodeMock.script)
    }

    @Test func legacyEnvOverride() {
        let found = DaemonLocator.locate(override: nil, environment: ["LOLCHAT_BIN": NodeMock.script, "PATH": "/usr/bin", "HOME": "/nonexistent"], shellTimeout: 3)
        #expect(found?.path == NodeMock.script)
    }

    @Test func mergedPathDedupes() {
        let p = DaemonLocator.mergedPath(binary: "/a/bin/autochat", shellPath: "/a/bin:/b", basePath: "/usr/bin:/b")
        #expect(p == "/a/bin:/b:/opt/homebrew/bin:/usr/local/bin:/usr/bin")
    }
}
