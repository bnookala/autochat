import Darwin
import Foundation
import Testing
@testable import AutoChatCore

@Suite("Agents: daemon client on the agents stream", .serialized)
struct AgentsClientTests {
    @Test func subscribesAcknowledgesAndIntervenes() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let server = MockDaemonServer(path: paths.sockPath)
        try server.start()
        defer { server.stop() }

        let snapshots = Box<[AgentsSnapshot]>([])
        let client = DaemonClient(socketPath: paths.sockPath, stream: .agents, callbackQueue: DispatchQueue(label: "test"))
        client.setAgentsHandlers(onAgents: { s in snapshots.mutate { $0.append(s) } })
        client.start()
        defer { client.stop() }

        #expect(await eventually { snapshots.value.count == 1 })
        #expect(client.currentState == .connected)
        #expect(server.agentSubscriberCount == 1)
        #expect(server.subscriberCount == 0, "an agents subscription isn't a lounge subscription")
        let first = try #require(snapshots.value.first)
        #expect(first.agents.map(\.name) == ["copilot-x", "claude-web"])
        #expect(first.threads.first?.title == "auth token refresh")
        #expect(first.messages.first?.kind == .question)
        #expect(!first.ack)

        // Not acknowledged yet: the daemon refuses, and nothing is posted.
        let refused = try await client.send(.agentsSay(text: "hello agents", thread: nil, to: []))
        #expect(!refused.ok)
        #expect(refused.error == AgentsRules.ackRequired)

        let ack = try await client.send(.agentsAck)
        #expect(ack.ok)
        #expect(await eventually { snapshots.value.last?.ack == true })

        let said = try await client.send(.agentsSay(text: "keep the API stable", thread: "t1", to: []))
        #expect(said.ok)
        #expect(await eventually { snapshots.value.last?.messages.last?.kind == .human })
        let human = try #require(snapshots.value.last?.messages.last)
        #expect(human.text == "keep the API stable")
        #expect(human.thread == "t1")
        #expect(human.intervention)
        #expect(server.commandNames == ["agents.say", "agents.ack", "agents.say"])

        // Lounge commands mean nothing on this connection.
        let lounge = try await client.send(.joinNow)
        #expect(!lounge.ok)
    }

    @Test func aDaemonWithoutAgentRoomsIsIncompatible() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let server = MockDaemonServer(path: paths.sockPath)
        server.ignoresStream = true
        try server.start()
        defer { server.stop() }
        let agents = Box(0)
        let client = DaemonClient(socketPath: paths.sockPath, stream: .agents, callbackQueue: DispatchQueue(label: "test"))
        client.setAgentsHandlers(onAgents: { _ in agents.mutate { $0 += 1 } })
        client.start()
        defer { client.stop() }
        #expect(await eventually {
            if case .incompatible = client.currentState { return true }
            return false
        })
        #expect(agents.value == 0)
    }

    @Test func aLoungeClientIgnoresAgentsSnapshots() async throws {
        let paths = try makeTestHome()
        defer { removeTestHome(paths) }
        let server = MockDaemonServer(path: paths.sockPath)
        try server.start()
        defer { server.stop() }
        let lounge = Box(0)
        let client = DaemonClient(socketPath: paths.sockPath, callbackQueue: DispatchQueue(label: "test"))
        client.setHandlers(onSnapshot: { _ in lounge.mutate { $0 += 1 } })
        client.start()
        defer { client.stop() }
        #expect(await eventually { lounge.value == 1 })
        #expect(client.stream == .lounge)
        #expect(server.subscriberCount == 1)
        #expect(server.agentSubscriberCount == 0)
    }
}
