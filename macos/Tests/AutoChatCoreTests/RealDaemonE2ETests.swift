import Darwin
import Foundation
import Testing
@testable import AutoChatCore

/// Opt-in end-to-end check against a real `autochat daemon` (not the mock):
///
///     AUTOCHAT_HOME=$E2E autochat host        # a private room, so nobody else is in it
///     AUTOCHAT_HOME=$E2E COPILOT_HOME=$E2E/copilot AUTOCHAT_NO_NOTIFY=1 AUTOCHAT_NO_FOCUS=1 autochat daemon &
///     AUTOCHAT_E2E_HOME=$E2E swift test --filter RealDaemon
///
/// The daemon joins its room at start and stays there; it leaves it only while the lounge is off.
@Suite("Real autochat daemon (opt-in)", .serialized, .enabled(if: ProcessInfo.processInfo.environment["AUTOCHAT_E2E_HOME"] != nil))
struct RealDaemonE2ETests {
    let paths = AutochatPaths(home: ProcessInfo.processInfo.environment["AUTOCHAT_E2E_HOME"] ?? "")

    /// Sends a one-shot line (like `autochat hook` does) and returns the reply line.
    private func oneShot(_ object: [String: Any]) throws -> [String: Any]? {
        let fd = try UnixSocket.connect(path: paths.sockPath)
        defer { close(fd) }
        UnixSocket.setTimeouts(fd, seconds: 2)
        var line = try JSONSerialization.data(withJSONObject: object)
        line.append(0x0A)
        try UnixSocket.writeAll(fd, line)
        var buf = [UInt8](repeating: 0, count: 65536)
        let n = read(fd, &buf, buf.count)
        guard n > 0 else { return nil }
        return try JSONSerialization.jsonObject(with: Data(buf[0..<n])) as? [String: Any]
    }

    private func hook(_ kind: String, sid: String, extra: [String: Any] = [:]) throws {
        var msg: [String: Any] = [
            "type": "hook", "event": "e2e", "kind": kind, "mode": "autopilot", "sessionId": sid,
            "cwd": "/Users/e2e/code/api-server", "ts": Int(Date().timeIntervalSince1970 * 1000), "origin": [:] as [String: Any]
        ]
        msg.merge(extra) { $1 }
        _ = try oneShot(msg)
    }

    @Test func alwaysInTheLoungeWithTheAttentionQueue() async throws {
        let ping = await DaemonClient.ping(socketPath: paths.sockPath, timeout: 1)
        #expect(ping?.isDaemon == true)

        let snapshots = Box<[Snapshot]>([])
        let client = DaemonClient(socketPath: paths.sockPath, callbackQueue: DispatchQueue(label: "e2e"))
        client.setHandlers(onSnapshot: { s in snapshots.mutate { $0.append(s) } })
        client.start()
        defer { client.stop() }
        #expect(await eventually(timeout: 5) { snapshots.value.count >= 1 })
        let first = try #require(snapshots.value.first)
        #expect(first.version == 1)
        #expect(first.me?.handle?.isEmpty == false)
        #expect(first.room?.display?.isEmpty == false)
        if first.loungeOn == false { #expect(try await client.send(.lounge(true)).ok) }

        // In the room with no agent running at all.
        #expect(await eventually(timeout: 10) { snapshots.value.last.map { $0.phase == .room && $0.loungeOn == true } == true })
        #expect(snapshots.value.last?.members.contains { $0.isYou } == true)
        #expect(snapshots.value.last?.sessions.isEmpty == true)

        // say → reply → the message comes back in a snapshot, flagged as ours.
        let said = try await client.send(.say("hello from the swift e2e test"))
        #expect(said.ok, "say failed: \(said.error ?? "")")
        #expect(await eventually(timeout: 5) {
            snapshots.value.last?.messages.contains { $0.isSelf && $0.text == "hello from the swift e2e test" && $0.kind == .chat } == true
        })

        // A session works on its own, then completes: its result is in the attention queue (one
        // agent: no badge, no panel), and the room doesn't change.
        let sid = "e2e-\(UUID().uuidString.prefix(8))"
        try hook("activity", sid: sid)
        #expect(await eventually(timeout: 10) { snapshots.value.last?.sessions.contains { $0.sid == sid } == true })
        try hook("complete", sid: sid, extra: ["summary": "Refactored the API client. **Tests** pass."])
        #expect(await eventually(timeout: 10) { snapshots.value.last?.attention?.contains { $0.sid == sid } == true })
        let done = try #require(snapshots.value.last)
        let finished = try #require(done.attention?.first { $0.sid == sid })
        #expect(finished.kind == .finished)
        #expect(finished.harness == .copilot)
        #expect(finished.summary?.contains("Refactored") == true)
        #expect(AttentionRules.urgentCount(done.attention) == 0)
        #expect(done.phase == .room)
        #expect(try await client.send(.dismissAttention(finished.id)).ok)
        #expect(await eventually(timeout: 5) { snapshots.value.last?.attention?.isEmpty == true })

        // Two agents at once: one blocked on you; Jump to keeps it until it carries on.
        let other = "e2e-\(UUID().uuidString.prefix(8))"
        try hook("activity", sid: sid)
        try hook("activity", sid: other)
        try hook("request", sid: other, extra: ["request": ["title": "Permission needed", "message": "Run the tests?"]])
        #expect(await eventually(timeout: 10) { AttentionRules.urgentCount(snapshots.value.last?.attention) == 1 })
        let blocked = try #require(snapshots.value.last?.attention?.first { $0.kind == .blocked })
        #expect(blocked.sid == other)
        #expect(try await client.send(.jumpTo(blocked.id)).ok)
        #expect(try await client.send(.jumpTo("no-such-item")).error == "unknown item")
        try hook("activity", sid: other)
        #expect(await eventually(timeout: 5) { snapshots.value.last?.attention?.isEmpty == true })
        try hook("complete", sid: sid)
        try hook("end", sid: other)
        #expect(await eventually(timeout: 10) { snapshots.value.last?.attention?.count == 2 })
        #expect(snapshots.value.last?.phase == .room)
        for item in snapshots.value.last?.attention ?? [] { #expect(try await client.send(.dismissAttention(item.id)).ok) }
        #expect(await eventually(timeout: 5) { snapshots.value.last?.attention?.isEmpty == true })
        #expect(try await client.send(.dismissRequest).ok)
        #expect(try await client.send(.jumpToCopilot).ok)

        // Join the Lounge off: out of the room at once, and nothing to say there.
        #expect(try await client.send(.lounge(false)).ok)
        #expect(await eventually(timeout: 5) { snapshots.value.last.map { $0.phase == .lounge && $0.loungeOn == false && $0.members.isEmpty } == true })
        #expect(try await client.send(.say("anyone?")).error == "not in a room")
        // …and on again: back in the room.
        #expect(try await client.send(.lounge(true)).ok)
        #expect(await eventually(timeout: 10) { snapshots.value.last.map { $0.phase == .room && $0.loungeOn == true } == true })
    }
}
