import Darwin
import Foundation
import Testing
@testable import LolChatCore

/// Opt-in end-to-end check against a real `lolchat daemon` (not the mock):
///
///     LOLCHAT_HOME=$E2E COPILOT_HOME=$E2E/copilot LOLCHAT_NO_NOTIFY=1 LOLCHAT_NO_FOCUS=1 \
///       LOLCHAT_COUNTDOWN_MS=6000 lolchat daemon &
///     LOLCHAT_E2E_HOME=$E2E swift test --filter RealDaemon
///
/// Use a private room (`LOLCHAT_HOME=$E2E lolchat host`) so nobody else is in it.
@Suite("Real lolchat daemon (opt-in)", .serialized, .enabled(if: ProcessInfo.processInfo.environment["LOLCHAT_E2E_HOME"] != nil))
struct RealDaemonE2ETests {
    let paths = LolchatPaths(home: ProcessInfo.processInfo.environment["LOLCHAT_E2E_HOME"] ?? "")

    /// Sends a one-shot line (like `lolchat hook` does) and returns the reply line.
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

    @Test func subscribeChatCountdownAndCloseout() async throws {
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

        // A hook puts a session on autopilot → the daemon enters the room.
        let sid = "e2e-\(UUID().uuidString.prefix(8))"
        try hook("activity", sid: sid)
        #expect(await eventually(timeout: 10) { snapshots.value.last?.phase == .room })
        #expect(snapshots.value.last?.members.contains { $0.isYou } == true)
        #expect(snapshots.value.last?.sessions.contains { $0.sid == sid } == true)

        // say → reply → the message comes back in a snapshot, flagged as ours.
        let said = try await client.send(.say("hello from the swift e2e test"))
        #expect(said.ok, "say failed: \(said.error ?? "")")
        #expect(await eventually(timeout: 5) {
            snapshots.value.last?.messages.contains { $0.isSelf && $0.text == "hello from the swift e2e test" && $0.kind == .chat } == true
        })

        let noCountdown = try await client.send(.returnNow)
        #expect(!noCountdown.ok)
        #expect(noCountdown.error?.isEmpty == false)

        // The session completes → a non-blocking countdown; chatting still works.
        try hook("complete", sid: sid, extra: ["summary": "Refactored the API client. **Tests** pass."])
        #expect(await eventually(timeout: 10) { snapshots.value.last?.countdown != nil })
        let counting = try #require(snapshots.value.last)
        #expect(counting.phase == .room)
        let countdown = try #require(counting.countdown)
        #expect(countdown.reason == "complete")
        #expect(countdown.endsAt > (counting.now ?? Date()))
        let during = try await client.send(.say("still typing during the countdown"))
        #expect(during.ok, "say during countdown failed: \(during.error ?? "")")

        // The daemon re-publishes once per second while counting down.
        let before = snapshots.value.count
        try await Task.sleep(for: .milliseconds(2300))
        #expect(snapshots.value.count >= before + 2)

        // Return now → reality banner with Copilot's summary, then back to the lounge.
        let back = try await client.send(.returnNow)
        #expect(back.ok, "returnNow failed: \(back.error ?? "")")
        #expect(await eventually(timeout: 5) { snapshots.value.last?.phase == .reality || snapshots.value.last?.phase == .spectating })
        if let last = snapshots.value.last, last.phase == .reality {
            #expect(last.countdown == nil)
            #expect(last.banner?.kind == .reality)
            #expect(last.banner?.reason == "complete")
            #expect(last.banner?.summary?.contains("Refactored") == true)
        }
        #expect(await eventually(timeout: 12) { snapshots.value.last?.phase == .lounge })

        // Manual join, then leave with the banner.
        let join = try await client.send(.joinNow)
        #expect(join.ok)
        #expect(await eventually(timeout: 10) { snapshots.value.last?.phase == .room })
        #expect(try await client.send(.dismissRequest).ok)
        #expect(try await client.send(.jumpToCopilot).ok)
        let leave = try await client.send(.leaveRoom)
        #expect(leave.ok, "leaveRoom failed: \(leave.error ?? "")")
        #expect(await eventually(timeout: 5) { snapshots.value.last?.phase == .left })
        #expect(snapshots.value.last?.banner?.kind == .left)
    }
}
