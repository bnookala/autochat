import Darwin
import Foundation
import Testing
@testable import AutoChatCore

/// `--scenario agents` of macos/dev/mock-daemon.mjs, through the real client.
@Suite("Agents: the Node mock's agents scenario", .serialized, .enabled(if: NodeMock.available, "node not found on PATH"))
struct AgentsNodeMockTests {
    @Test func playsTheRoomAndGatesInterventions() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let mock = Process()
        mock.executableURL = URL(fileURLWithPath: NodeMock.node!)
        mock.arguments = [NodeMock.script, "daemon", "--quiet"]
        var env = NodeMock.environment(paths, scenario: "agents")
        env["AUTOCHAT_MOCK_SPEED"] = "25"
        mock.environment = env
        try mock.run()
        defer {
            if mock.isRunning {
                mock.terminate()
                mock.waitUntilExit()
            }
        }
        #expect(await eventually(timeout: 10) { await DaemonClient.ping(socketPath: paths.sockPath) != nil })

        // The lounge snapshot reports the room once agents connect.
        let lounge = Box<[Snapshot]>([])
        let loungeClient = DaemonClient(socketPath: paths.sockPath, callbackQueue: DispatchQueue(label: "lounge"))
        loungeClient.setHandlers(onSnapshot: { s in lounge.mutate { $0.append(s) } })
        loungeClient.start()
        defer { loungeClient.stop() }
        #expect(await eventually(timeout: 10) { lounge.value.last?.agents != nil })
        #expect(lounge.value.last?.phase == .lounge)

        let snapshots = Box<[AgentsSnapshot]>([])
        let client = DaemonClient(socketPath: paths.sockPath, stream: .agents, callbackQueue: DispatchQueue(label: "agents"))
        client.setAgentsHandlers(onAgents: { s in snapshots.mutate { $0.append(s) } })
        client.start()
        defer { client.stop() }

        // The whole script: three agents over two harnesses (one left), an overlap, a resolved
        // thread with its decision, notes and sys lines, and a second thread that stays open.
        #expect(await eventually(timeout: 15) {
            guard let s = snapshots.value.last else { return false }
            return s.threads.count == 2 && s.messages.contains { $0.kind == .sys && $0.text.hasSuffix("left") }
        })
        let s = try #require(snapshots.value.last)
        #expect(s.tier == "local")
        #expect(s.human == "stormy-newt-59")
        #expect(s.agents.count == 3)
        #expect(Set(s.agents.map(\.harness)) == [.copilot, .claude])
        #expect(s.agents.filter { !$0.present }.map(\.name) == ["copilot-docs"])
        #expect(s.agents.first { $0.name == "copilot-api" }?.overlaps == ["claude-web"])
        #expect(s.messages.filter { $0.kind == .overlap }.count == 1)
        let resolved = try #require(s.threads.first { $0.isResolved })
        #expect(resolved.title == "auth token refresh")
        #expect(resolved.outcome?.isEmpty == false)
        #expect(s.messages.contains { $0.kind == .decision && $0.thread == resolved.id && $0.text == resolved.outcome })
        #expect(s.threads.contains { $0.status == .open })
        #expect(s.messages.contains { $0.kind == .handoff && $0.thread == nil })
        #expect(s.messages.contains { $0.kind == .note && $0.text.contains("**No API impact**") })
        #expect(AgentsRules.messages(in: .thread(resolved.id), of: s).map(\.kind) == [.question, .reply, .proposal, .reply, .decision])
        #expect(lounge.value.last?.agents == LoungeAgents(present: 2, openThreads: 1))

        // ack-required until acknowledged, then the intervention lands (and gets a reply).
        let refused = try await client.send(.agentsSay(text: "hello agents", thread: nil, to: []))
        #expect(refused.error == "ack-required")
        #expect(try await client.send(.agentsAck).ok)
        #expect(await eventually { snapshots.value.last?.ack == true })
        let said = try await client.send(.agentsSay(text: "keep the public API stable", thread: resolved.id, to: []))
        #expect(said.ok, "say failed: \(said.error ?? "")")
        #expect(await eventually {
            snapshots.value.last?.messages.contains { $0.kind == .human && $0.intervention && $0.thread == resolved.id && $0.text == "keep the public API stable" } == true
        })
        #expect(await eventually(timeout: 5) {
            snapshots.value.last.map { s in s.messages.last?.kind == .reply && s.messages.last?.replyTo == s.messages.first { $0.kind == .human }?.seq } ?? false
        })
        let unknownThread = try await client.send(.agentsSay(text: "x", thread: "nope", to: []))
        #expect(!unknownThread.ok)
        let empty = try await client.send(.agentsSay(text: "  ", thread: nil, to: []))
        #expect(empty.error == "empty message")
    }
}
