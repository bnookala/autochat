import Foundation
import AutoChatCore
import SwiftUI
import Testing
@testable import AutoChatApp

/// Records commands and answers them from a script.
@MainActor
final class FakeAgentsDaemon {
    var sent: [Command] = []
    var replies: [String: Reply] = [:]

    func send(_ command: Command) async throws -> Reply {
        sent.append(command)
        return replies[command.name] ?? Reply(id: sent.count, ok: true)
    }
}

/// Holds a reply until the test opens it.
@MainActor
final class ReplyGate {
    private var waiting: CheckedContinuation<Void, Never>?
    var isWaiting: Bool { waiting != nil }

    func wait() async {
        await withCheckedContinuation { waiting = $0 }
    }

    func open() {
        waiting?.resume()
        waiting = nil
    }
}

@Suite("App model: Agents tab")
@MainActor
struct AgentsTabTests {
    @Test func theTabShowsOnceTheLoungeSnapshotReportsAgents() {
        let model = connectedModel()
        model.apply(Fixtures.lounge())
        #expect(!model.showsAgentsTab)
        model.selectTab(.agents)
        #expect(model.effectiveTab == .lounge, "no agent room yet")
        model.apply(Fixtures.agentsLounge())
        #expect(model.showsAgentsTab)
        #expect(model.effectiveTab == .agents)
        // The daemon restarted (no agents since): back to the lounge, keeping the choice.
        model.apply(Fixtures.lounge())
        #expect(model.effectiveTab == .lounge)
        model.apply(Fixtures.agentsLounge())
        #expect(model.effectiveTab == .agents)
        model.connectionChanged(.disconnected(nil))
        #expect(!model.showsAgentsTab)
        #expect(model.effectiveTab == .lounge)
    }

    @Test func openChatGoesToTheLoungeWhenAutopilotNeedsIt() {
        let model = connectedModel()
        model.apply(Fixtures.agentsLounge())
        model.selectTab(.agents)
        model.selectTabForOpening()
        #expect(model.chatTab == .agents)
        var request = Fixtures.request(now: Date())
        request.agents = LoungeAgents(present: 1, openThreads: 0)
        model.apply(request)
        model.selectTabForOpening()
        #expect(model.chatTab == .lounge)
    }

    @Test func theAgentsTabInFrontStillLetsLoungePanelsDescend() {
        let model = connectedModel()
        var countdown = Fixtures.countdown(now: Date(), remaining: 20)
        countdown.agents = LoungeAgents(present: 2, openThreads: 1)
        model.apply(countdown)
        model.chatWindow = ChatWindowState(isVisible: true, isKey: true, appIsActive: true)
        #expect(model.panelKind == nil, "the lounge is in front")
        model.selectTab(.agents)
        #expect(model.panelKind == .countdown)
    }
}

@Suite("App model: intervening")
@MainActor
struct AgentsInterventionTests {
    private func model(ack: Bool = false) -> (AgentsModel, FakeAgentsDaemon) {
        let daemon = FakeAgentsDaemon()
        let model = AgentsModel(send: { try await daemon.send($0) })
        model.apply(Fixtures.agents(now: Date(), ack: ack))
        return (model, daemon)
    }

    @Test func theInputStaysHiddenUntilTheSheetIsConfirmed() async {
        let (model, daemon) = model()
        #expect(!model.gate.inputVisible)
        // Typing alone can't send anything.
        model.draft = "hello"
        await model.submit()
        #expect(daemon.sent.isEmpty)

        model.intervene()
        #expect(model.gate.sheetShown)
        #expect(!model.gate.inputVisible)
        model.cancelAck()
        #expect(!model.gate.sheetShown)
        #expect(daemon.sent.isEmpty, "cancel sends nothing")

        model.intervene()
        await model.confirmAck()
        #expect(daemon.sent == [.agentsAck])
        #expect(model.gate.inputVisible)
        #expect(!model.gate.sheetShown)

        await model.submit()
        #expect(daemon.sent.last == .agentsSay(text: "hello", thread: nil, to: []))
        #expect(model.draft.isEmpty)
    }

    @Test func confirmingOnlyWorksFromTheSheet() async {
        let (model, daemon) = model()
        await model.confirmAck()
        #expect(daemon.sent.isEmpty)
        #expect(!model.gate.inputVisible)
    }

    @Test func aFailedAcknowledgementKeepsTheSheet() async {
        let (model, daemon) = model()
        daemon.replies["agents.ack"] = Reply(id: 1, ok: false, error: "config not writable")
        model.intervene()
        await model.confirmAck()
        #expect(model.gate.sheetShown)
        #expect(!model.gate.inputVisible)
        #expect(model.ackError == "config not writable")
    }

    @Test func anAcknowledgedRoomSkipsTheSheet() async {
        let (model, daemon) = model(ack: true)
        model.intervene()
        #expect(!model.gate.sheetShown)
        #expect(model.gate.inputVisible)
        #expect(daemon.sent.isEmpty, "no second agents.ack")
        model.stopIntervening()
        #expect(!model.gate.inputVisible)
    }

    @Test func ackRequiredShowsTheSheetAgainAndKeepsTheDraft() async {
        let (model, daemon) = model(ack: true)
        model.intervene()
        daemon.replies["agents.say"] = Reply(id: 1, ok: false, error: "ack-required")
        model.draft = "please keep the API stable"
        await model.submit()
        #expect(model.gate.sheetShown)
        #expect(!model.gate.inputVisible)
        #expect(model.draft == "please keep the API stable")
        #expect(model.lastError == nil)
        // A snapshot that still says ack doesn't bring the input back by itself.
        model.apply(Fixtures.agents(now: Date(), ack: true))
        #expect(!model.gate.inputVisible)

        daemon.replies["agents.say"] = nil
        await model.confirmAck()
        #expect(model.gate.inputVisible)
        await model.submit()
        #expect(daemon.sent.map(\.name) == ["agents.say", "agents.ack", "agents.say"])
        #expect(model.draft.isEmpty)
    }

    @Test func otherRefusalsShowAnError() async {
        let (model, daemon) = model(ack: true)
        model.intervene()
        daemon.replies["agents.say"] = Reply(id: 1, ok: false, error: "rate limited")
        model.draft = "hi"
        await model.submit()
        #expect(model.lastError == "rate limited")
        #expect(model.gate.inputVisible)
        #expect(model.draft == "hi")
    }

    @Test func interventionsGoToTheSelectedStream() async {
        let (model, daemon) = model(ack: true)
        model.intervene()
        model.select(.thread(Fixtures.budgetThread))
        #expect(model.stream == .thread(Fixtures.budgetThread))
        #expect(model.messages.count == 2)
        #expect(model.selectedThread?.title == "retry budget defaults")
        model.draft = "  three is fine  "
        await model.submit()
        #expect(daemon.sent.last == .agentsSay(text: "three is fine", thread: Fixtures.budgetThread, to: []))
        model.select(.main)
        model.draft = "thanks all"
        await model.submit()
        #expect(daemon.sent.last == .agentsSay(text: "thanks all", thread: nil, to: []))
    }

    @Test func aResolvedThreadTakesNoInterventions() async {
        let (model, daemon) = model(ack: true)
        model.intervene()
        model.select(.thread(Fixtures.authThread))
        #expect(model.streamIsClosed)
        model.draft = "too late"
        await model.submit()
        #expect(daemon.sent.isEmpty)
        #expect(model.draft == "too late")
        model.select(.main)
        #expect(!model.streamIsClosed)
        await model.submit()
        #expect(daemon.sent == [.agentsSay(text: "too late", thread: nil, to: [])])
    }

    @Test func aVanishedThreadFallsBackToTheMainStream() {
        let (model, _) = model()
        model.select(.thread(Fixtures.authThread))
        #expect(model.stream == .thread(Fixtures.authThread))
        var next = Fixtures.agents(now: Date())
        next.threads.removeAll { $0.id == Fixtures.authThread }
        model.apply(next)
        #expect(model.stream == .main)
        #expect(model.selection == .main)
        model.select(.thread("never-existed"))
        #expect(model.selection == .main)
    }

    @Test func theDraftIsCapped() {
        let (model, _) = model()
        model.draft = String(repeating: "x", count: 2500)
        #expect(model.draft.count == AgentsRules.maxSayLength)
    }
}

@Suite("App model: presence")
@MainActor
struct AgentsPresenceModelTests {
    @Test func leftTimesTickOnTheDaemonClock() {
        let daemon = FakeAgentsDaemon()
        let model = AgentsModel(send: { try await daemon.send($0) })
        let daemonNow = Date(timeIntervalSince1970: 1_730_400_000)
        let local = Date(timeIntervalSince1970: 1_730_400_042)
        model.apply(Fixtures.agentsPresence(now: daemonNow), receivedAt: local)
        #expect(model.daemonNow(at: local) == daemonNow)
        // Between snapshots the daemon's clock moves on with ours, skew and all.
        #expect(model.daemonNow(at: local.addingTimeInterval(90)) == daemonNow.addingTimeInterval(90))
        let docs = model.snapshot!.agents.first { $0.presence == .left }!
        #expect(AgentsRules.presenceNote(docs, now: model.daemonNow(at: local)) == "left 6 min ago")
        #expect(AgentsRules.presenceNote(docs, now: model.daemonNow(at: local.addingTimeInterval(120))) == "left 8 min ago")
        // Without the daemon's `now`, the local clock.
        var bare = Fixtures.agentsPresence(now: daemonNow)
        bare.now = nil
        model.apply(bare, receivedAt: local)
        #expect(model.daemonNow(at: local.addingTimeInterval(5)) == local.addingTimeInterval(5))
    }

    @Test func aFixtureStaysAtItsNow() {
        let now = Date(timeIntervalSince1970: 1_730_400_000)
        let model = AgentsModel(fixture: Fixtures.agentsPresence(now: now))
        #expect(model.daemonNow(at: Date()) == now)
        #expect(AgentsModel(fixture: nil).daemonNow() == nil)
    }

    @Test func cardsDimOnceTheAgentIsNotHere() {
        #expect(AgentCardView.opacity(.here) == 1)
        #expect(AgentCardView.opacity(.away) < 1)
        #expect(AgentCardView.opacity(.left) < AgentCardView.opacity(.away))
        #expect([AgentPresence.here, .away, .left].map(PresenceDot.label) == ["here", "reconnecting", "left"])
    }
}

@Suite("App model: names and child sessions")
@MainActor
struct AgentsNamesModelTests {
    @Test func theDisclosureFoldsChildSessions() {
        let model = AgentsModel(send: { _ in Reply(id: 1, ok: true) })
        model.apply(Fixtures.agentsNames(now: Date()))
        func names() -> [String] {
            model.boardRows.compactMap { if case let .card(c, _) = $0 { c.name } else { nil } }
        }
        #expect(names() == ["autochat-p1-agent-rooms", "mac-app-presence-and-names", "daemon-names-and-hello-titles", "api-server-fix-session-expiry", "docs-site"])
        let lead = model.snapshot!.agents.first { $0.name == "autochat-p1-agent-rooms" }!
        model.toggleChildren(of: lead.id)
        #expect(names() == ["autochat-p1-agent-rooms", "api-server-fix-session-expiry", "docs-site"])
        #expect(model.boardRows.contains(.children(parent: lead.id, count: 2, depth: 1, expanded: false)))
        // Folding survives new snapshots.
        model.apply(Fixtures.agentsNames(now: Date()))
        #expect(names().count == 3)
        model.toggleChildren(of: lead.id)
        #expect(names().count == 5)
    }

    @Test func indentationIsCapped() {
        #expect(AgentsSidebarLayout.indent(0) == 0)
        #expect(AgentsSidebarLayout.indent(1) > 0)
        #expect(AgentsSidebarLayout.indent(9) == AgentsSidebarLayout.indent(3))
    }

    @Test func theIdleRowOpensOnClick() {
        let model = AgentsModel(send: { _ in Reply(id: 1, ok: true) })
        model.apply(Fixtures.agentsIdle(now: Date()))
        func names() -> [String] {
            model.boardRows.compactMap { if case let .card(c, _) = $0 { c.name } else { nil } }
        }
        #expect(model.boardRows.last == .idle(count: 3, expanded: false))
        #expect(!names().contains("what-can-you-do"))
        model.toggleIdle()
        #expect(model.idleExpanded)
        #expect(names().suffix(3) == ["what-can-you-do", "scratch", "gemini"])
        // An idle session that starts working moves up with the active agents.
        var next = Fixtures.agentsIdle(now: Date())
        next.agents[next.agents.firstIndex { $0.name == "scratch" }!].active = true
        model.apply(next)
        #expect(model.boardRows.contains(.idle(count: 2, expanded: true)))
        #expect(names().firstIndex(of: "scratch")! < names().firstIndex(of: "docs-site")!)
        model.toggleIdle()
        #expect(names().count == 6)
        #expect(AgentsModel(fixture: Fixtures.agentsIdle(now: Date()), idleExpanded: true).boardRows.contains(.idle(count: 3, expanded: true)))
    }
}

@Suite("App model: connect agents")
@MainActor
struct AgentsConnectModelTests {
    private func json(_ text: String) -> JSONValue? {
        try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private let plans = #"""
    {"plans":[{"id":"copilot","name":"Copilot CLI","action":"add","where":"~/.copilot/mcp-config.json","detail":"Adds the autochat MCP server."},
              {"id":"claude","name":"Claude Code","action":"ok","where":"claude mcp (user scope)"},
              {"id":"gemini","name":"Gemini CLI","action":"manual","detail":"settings.json isn't plain JSON"},
              {"id":"opencode","name":"opencode","action":"absent"},
              {"id":"codex","name":"Codex","action":"update","where":"~/.codex/config.toml"},
              {"id":"pi","name":"pi","action":"absent"}]}
    """#

    @Test func theSheetLoadsThePlanAndConnectsTheCheckedTools() async {
        let daemon = FakeAgentsDaemon()
        daemon.replies["agents.setupPlan"] = Reply(id: 1, ok: true, result: json(plans))
        daemon.replies["agents.setup"] = Reply(id: 2, ok: true, result: json(#"{"applied":["copilot"],"failed":[{"id":"codex","error":"read-only"}]}"#))
        let model = AgentsModel(send: { try await daemon.send($0) })
        model.apply(Fixtures.agentsEmpty(now: Date()))
        #expect(!model.setup.isShown)

        await model.openSetup()
        #expect(daemon.sent == [.agentsSetupPlan])
        #expect(model.setup.phase == .ready)
        #expect(model.setup.plans.map(\.id) == ["copilot", "claude", "gemini", "opencode", "codex", "pi"])
        #expect(model.setup.selection == ["copilot", "codex"], "add and update start checked")
        model.toggleSetup("gemini")
        model.toggleSetup("claude")
        #expect(model.setup.selection == ["copilot", "codex"])

        await model.connectAgents()
        #expect(daemon.sent.last == .agentsSetup(harnesses: ["copilot", "codex"]))
        #expect(model.setup.phase == .done)
        #expect(model.setup.result == AgentSetupResult(applied: ["copilot"], failed: [.init(id: "codex", error: "read-only")]))
        #expect(AgentsRules.setupSummary(model.setup) == "Connected Copilot CLI. Codex didn't connect.")
        model.closeSetup()
        #expect(!model.setup.isShown)
    }

    @Test func uncheckedToolsStayOut() async {
        let daemon = FakeAgentsDaemon()
        daemon.replies["agents.setupPlan"] = Reply(id: 1, ok: true, result: json(plans))
        daemon.replies["agents.setup"] = Reply(id: 2, ok: true, result: json(#"{"applied":["copilot"],"failed":[]}"#))
        let model = AgentsModel(send: { try await daemon.send($0) })
        await model.openSetup()
        model.toggleSetup("codex")
        await model.connectAgents()
        #expect(daemon.sent.last == .agentsSetup(harnesses: ["copilot"]))
        // Nothing checked: Connect does nothing.
        model.closeSetup()
        await model.openSetup()
        model.toggleSetup("copilot")
        model.toggleSetup("codex")
        let before = daemon.sent.count
        await model.connectAgents()
        #expect(daemon.sent.count == before)
        #expect(model.setup.phase == .ready)
    }

    @Test func aDaemonWithoutThePlanShowsTheCommandInstead() async {
        let daemon = FakeAgentsDaemon()
        daemon.replies["agents.setupPlan"] = Reply(id: 1, ok: false, error: "unknown command")
        let model = AgentsModel(send: { try await daemon.send($0) })
        await model.openSetup()
        #expect(model.setup.phase == .failed)
        #expect(model.setup.error == "unknown command")
        #expect(AgentsSetupSheet.command == "autochat setup --agents")
        // Try Again asks once more.
        daemon.replies["agents.setupPlan"] = Reply(id: 2, ok: true, result: json(plans))
        await model.openSetup()
        #expect(model.setup.phase == .ready)
        // An empty or missing plan is a failure too.
        daemon.replies["agents.setupPlan"] = Reply(id: 3, ok: true, result: json(#"{"plans":[]}"#))
        model.closeSetup()
        await model.openSetup()
        #expect(model.setup.phase == .failed)
    }

    @Test func aFailedConnectKeepsThePlan() async {
        let daemon = FakeAgentsDaemon()
        daemon.replies["agents.setupPlan"] = Reply(id: 1, ok: true, result: json(plans))
        daemon.replies["agents.setup"] = Reply(id: 2, ok: false, error: "rate limited")
        let model = AgentsModel(send: { try await daemon.send($0) })
        await model.openSetup()
        await model.connectAgents()
        #expect(model.setup.phase == .ready)
        #expect(model.setup.error == "rate limited")
        #expect(model.setup.selection == ["copilot", "codex"])
        // A transport failure too, and an answer without a result is "nothing changed".
        let gone = AgentsModel(send: { command in
            if command == .agentsSetupPlan { return Reply(id: 1, ok: true, result: try JSONDecoder().decode(JSONValue.self, from: Data(#"{"plans":[{"id":"copilot","action":"add"}]}"#.utf8))) }
            throw CommandError.disconnected
        })
        await gone.openSetup()
        await gone.connectAgents()
        #expect(gone.setup.error == CommandError.disconnected.localizedDescription)
        daemon.replies["agents.setup"] = Reply(id: 3, ok: true)
        await model.connectAgents()
        #expect(model.setup.phase == .done)
        #expect(AgentsRules.setupSummary(model.setup) == "Nothing changed.")
    }

    @Test func aClosedSheetIgnoresALateAnswer() async {
        let gate = ReplyGate()
        let model = AgentsModel(send: { _ in
            await gate.wait()
            return Reply(id: 1, ok: true, result: try JSONDecoder().decode(JSONValue.self, from: Data(#"{"plans":[{"id":"copilot","action":"add"}]}"#.utf8)))
        })
        let opening = Task { await model.openSetup() }
        while !gate.isWaiting { await Task.yield() }
        #expect(model.setup.phase == .loading)
        // Cancel while the daemon is still thinking: its answer must not reopen the sheet.
        model.closeSetup()
        gate.open()
        await opening.value
        #expect(!model.setup.isShown)
    }

    @Test func fixturesNeverSend() async {
        let model = AgentsModel(fixture: Fixtures.agentsEmpty(now: Date()))
        await model.openSetup()
        #expect(!model.setup.isShown)
    }

    @Test func theTabShowsOnAFreshInstall() {
        let model = connectedModel()
        model.apply(Fixtures.connectLounge(now: Date()))
        #expect(model.showsAgentsTab, "agents is non-null before anyone connects")
        model.selectTab(.agents)
        #expect(model.effectiveTab == .agents)
        model.apply(Fixtures.lounge())
        #expect(!model.showsAgentsTab, "a daemon without an agent room")
    }
}

@Suite("Agents: plain-text rendering")
@MainActor
struct AgentsPlainTextTests {
    @Test func namesAndSendersAreLiteralAndLinkFree() {
        let tricky = "**bold**/[x](https://evil.example)"
        let name = AgentText.name(owner: "stormy-newt-59", name: tricky)
        #expect(String(name.characters) == "stormy-newt-59/" + tricky)
        #expect(name.runs.allSatisfy { $0.link == nil })
        let human = AgentText.sender(AgentSenderLabel(name: "[me](https://x.example)", isHuman: true, isYou: true))
        #expect(String(human.characters) == "[me](https://x.example) (you)")
        #expect(human.runs.allSatisfy { $0.link == nil })
        let agent = AgentText.sender(AgentSenderLabel(owner: nil, name: "codex-*x*"))
        #expect(String(agent.characters) == "codex-*x*")
        // Titles are peer text too; the handle beside one is plain.
        #expect(AgentText.handle(AgentCardLabel(title: "[Mac app](https://evil.example) **now**", handle: "mac-app")) == "mac-app")
        #expect(AgentText.handle(AgentCardLabel(title: "Mac app", handle: "mac-app", owner: "jade")) == "jade/mac-app")
        #expect(AgentText.handle(AgentCardLabel(title: "copilot-x", owner: "jade")) == nil)
        let bare = AgentText.name(owner: "jade", name: "copilot-x")
        #expect(String(bare.characters) == "jade/copilot-x")
    }

    @Test func messageRowsHaveStableUniqueIDs() {
        let s = Fixtures.agents(now: Date())
        var messages = s.messages
        messages.append(messages[3])
        let rows = AgentMessageRowID.rows(messages)
        #expect(Set(rows.map(\.id)).count == rows.count)
        let trimmed = AgentMessageRowID.rows(Array(messages.dropFirst(2)))
        #expect(Array(rows.dropFirst(2)).map(\.id) == trimmed.map(\.id))
    }

    @Test func emphasis() {
        #expect(AgentMessageRow.emphasis(.decision) != nil)
        #expect(AgentMessageRow.emphasis(.human) != nil)
        #expect(AgentMessageRow.emphasis(.note) == nil)
        #expect(AgentMessageRow.emphasis(.unknown("x")) == nil)
    }
}
