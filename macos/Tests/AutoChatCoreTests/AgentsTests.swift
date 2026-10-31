import Foundation
import Testing
@testable import AutoChatCore

private let t0 = Date(timeIntervalSince1970: 1_730_400_000)

@Suite("Agents: decoding")
struct AgentsDecodingTests {
    private func decode(_ json: String) throws -> AgentsSnapshot {
        guard case let .agents(s) = Inbound.parse(Data(json.utf8)) else {
            throw CommandError.rejected("not an agents line")
        }
        return s
    }

    private func lounge(_ json: String) throws -> Snapshot {
        guard case let .state(s) = Inbound.parse(Data(json.utf8)) else {
            throw CommandError.rejected("not a state line")
        }
        return s
    }

    @Test func decodesTheIssueObjectsAndToleratesTheRest() throws {
        let s = try decode(Fixtures.agentsExampleJSON.replacingOccurrences(of: "\n", with: ""))
        #expect(s.version == 1)
        #expect(s.now == Date(timeIntervalSince1970: 1_730_400_005))
        #expect(s.tier == "local")
        #expect(s.human == "stormy-newt-59")
        #expect(!s.ack)

        // Cards: unknown fields ignored, a bad element skipped, a card without a name skipped.
        #expect(s.agents.map(\.name) == ["copilot-x", "claude-web", "aider-cli"])
        let x = s.agents[0]
        #expect(x.id == "a1b2c3d4")
        #expect(x.display == "stormy-newt-59/copilot-x")
        #expect(x.human == "stormy-newt-59")
        #expect(x.harness == .copilot)
        #expect(x.repo == "owner/repo")
        #expect(x.branch == "feat-x")
        #expect(x.worktree == "x")
        #expect(x.state == .editing)
        #expect(x.summary == "Refactoring the room")
        #expect(x.focus == AgentFocus(issue: 17, components: ["room"], paths: ["src/room.js"]))
        #expect(x.present)
        #expect(x.joinedAt == Date(timeIntervalSince1970: 1_730_400_000))
        #expect(x.overlaps == ["claude-web"])
        // Missing optionals are nil; unknown values are kept.
        let web = s.agents[1]
        #expect(web.harness == .claude)
        #expect(web.branch == nil)
        #expect(web.state == .unknown("daydreaming"))
        #expect(web.state?.label == "daydreaming")
        #expect(web.summary == nil)
        #expect(web.focus == nil)
        #expect(!web.present)
        #expect(web.overlaps.isEmpty)
        #expect(web.joinedAt == nil)
        // A name from `display`, and an unknown harness that stays generic.
        let aider = s.agents[2]
        #expect(aider.id == "aider-cli")
        #expect(aider.human == nil)
        #expect(aider.harness == .generic("aider"))
        #expect(aider.harness.label == "aider")
        #expect(aider.present)

        // Threads: unknown status kept, numeric strings accepted, a thread without an id skipped.
        #expect(s.threads.map(\.id) == ["auth-refresh-3f", "t2"])
        let auth = s.threads[0]
        #expect(auth.title == "auth token refresh")
        #expect(auth.opener == "copilot-x")
        #expect(auth.participants == ["copilot-x", "claude-web"])
        #expect(auth.status == .resolved)
        #expect(auth.isResolved)
        #expect(auth.outcome == "Keep retries in the client.")
        #expect(auth.messageCount == 6)
        #expect(auth.lastAt == Date(timeIntervalSince1970: 1_730_400_004))
        #expect(s.threads[1].title == "t2")
        #expect(s.threads[1].status == .unknown("archived"))
        #expect(s.threads[1].messageCount == 3)
        #expect(s.threads[1].participants == ["a", "b"])

        // Messages: unknown kinds kept, garbage skipped, text untouched.
        #expect(s.messages.map(\.seq) == [42, 43, 44, 45, 46, 47])
        let q = s.messages[0]
        #expect(q.kind == .question)
        #expect(q.messageID == "9f2c")
        #expect(q.from?.name == "copilot-x")
        #expect(q.from?.harness == .copilot)
        #expect(q.thread == "auth-refresh-3f")
        #expect(q.to == ["claude-web"])
        #expect(q.replyTo == nil)
        #expect(q.text == "**Are** you on [src/room.js](https://evil.example)?")
        #expect(!q.intervention)
        #expect(s.messages[1].kind == .sys)
        #expect(s.messages[1].from == nil)
        #expect(s.messages[1].thread == nil)
        let human = s.messages[2]
        #expect(human.kind == .human)
        #expect(human.intervention)
        #expect(human.from?.name == nil)
        #expect(human.from?.harness == nil)
        #expect(human.from?.human == "stormy-newt-59")
        #expect(human.text == "line one\nline two")
        #expect(s.messages[3].kind == .unknown("telepathy"))
        #expect(s.messages[3].ts == Date(timeIntervalSince1970: 1_730_400_003))
        #expect(s.messages[4].kind == .overlap)
        #expect(s.messages[4].ts == nil)
        #expect(s.messages[5].kind == .decision)
        #expect(s.messages[5].replyTo == 42)
        #expect(Set(s.messages.map(\.id)).count == s.messages.count)
    }

    @Test func missingAndNullFieldsAreNil() throws {
        let empty = try decode(#"{"type":"agents"}"#)
        #expect(empty.version == nil)
        #expect(empty.tier == nil)
        #expect(empty.human == nil)
        #expect(!empty.ack)
        #expect(empty.agents.isEmpty && empty.threads.isEmpty && empty.messages.isEmpty)
        let nulls = try decode(#"{"type":"agents","v":1,"tier":null,"human":null,"ack":null,"agents":null,"threads":null,"messages":null}"#)
        #expect(nulls.tier == nil)
        #expect(!nulls.ack)
        #expect(nulls.agents.isEmpty)
        let minimal = try decode(#"{"type":"agents","messages":[{"text":"hi"}],"agents":[{"name":"a"}]}"#)
        #expect(minimal.messages.first?.kind == .note)
        #expect(minimal.messages.first?.from == nil)
        #expect(minimal.messages.first?.to == [])
        #expect(minimal.agents.first?.harness == .generic(nil))
        #expect(minimal.agents.first?.harness.label == "generic")
        #expect(minimal.agents.first?.state == nil)
        #expect(minimal.agents.first?.present == true)
    }

    @Test func harnessesStatesAndKinds() {
        let names = ["copilot", "Claude", "codex", "opencode", "gemini", "pi", "agent", "", "x-agent"]
        #expect(names.map { AgentHarness(raw: $0) } == [.copilot, .claude, .codex, .opencode, .gemini, .pi, .generic(nil), .generic(nil), .generic("x-agent")])
        #expect(AgentState(raw: nil) == nil)
        #expect(AgentState(raw: "") == nil)
        #expect(["exploring", "editing", "testing", "blocked", "done", "idle"].compactMap { AgentState(raw: $0)?.label } == ["exploring", "editing", "testing", "blocked", "done", "idle"])
        let kinds = ["note", "question", "reply", "proposal", "decision", "handoff", "human", "sys", "overlap"]
        #expect(kinds.map { AgentMessageKind(raw: $0) } == [.note, .question, .reply, .proposal, .decision, .handoff, .human, .sys, .overlap])
        #expect(AgentMessageKind(raw: nil) == .note)
        #expect(AgentMessageKind(raw: "status") == .unknown("status"))
        #expect(AgentThreadStatus(raw: nil) == .open)
    }

    @Test func loungeSnapshotCarriesTheRoomSummary() throws {
        #expect(try lounge(#"{"type":"state","v":1,"phase":"lounge"}"#).agents == nil)
        #expect(try lounge(#"{"type":"state","v":1,"phase":"lounge","agents":null}"#).agents == nil)
        #expect(try lounge(#"{"type":"state","v":1,"phase":"lounge","agents":7}"#).agents == nil)
        #expect(try lounge(#"{"type":"state","v":1,"phase":"lounge","agents":{"present":2,"openThreads":1,"x":true}}"#).agents == LoungeAgents(present: 2, openThreads: 1))
        #expect(try lounge(#"{"type":"state","v":1,"phase":"lounge","agents":{}}"#).agents == LoungeAgents(present: 0, openThreads: 0))
        #expect(try lounge(#"{"type":"state","v":1,"phase":"lounge","agents":{"present":"3","openThreads":-1}}"#).agents == LoungeAgents(present: 3, openThreads: 0))
    }

    @Test func encodesTheHumanCommands() throws {
        let ack = Command.agentsAck.encodedLine(id: 1)
        #expect(String(decoding: ack, as: UTF8.self) == "{\"cmd\":\"agents.ack\",\"id\":1,\"type\":\"cmd\"}\n")
        let main = Command.agentsSay(text: "keep the API \"stable\"", thread: nil, to: []).encodedLine(id: 2)
        #expect(String(decoding: main, as: UTF8.self) == "{\"cmd\":\"agents.say\",\"id\":2,\"text\":\"keep the API \\\"stable\\\"\",\"thread\":null,\"to\":[],\"type\":\"cmd\"}\n")
        let thread = try JSONSerialization.jsonObject(with: Command.agentsSay(text: "hi", thread: "t1", to: ["claude-web"]).encodedLine(id: 3)) as? [String: Any]
        #expect(thread?["cmd"] as? String == "agents.say")
        #expect(thread?["thread"] as? String == "t1")
        #expect(thread?["to"] as? [String] == ["claude-web"])
        #expect(Command.agentsSay(text: "", thread: nil, to: []).name == "agents.say")
        // The lounge subscription is unchanged; the agents one asks for the stream.
        let lounge = try JSONSerialization.jsonObject(with: Wire.subscribe(.lounge)) as? [String: Any]
        #expect(lounge?["stream"] == nil)
        let agents = try JSONSerialization.jsonObject(with: Wire.subscribe(.agents)) as? [String: Any]
        #expect(agents?["stream"] as? String == "agents")
        #expect(agents?["type"] as? String == "subscribe")
    }
}

@Suite("Agents: view-model rules")
struct AgentsRulesTests {
    @Test func theTabAppearsOnceTheDaemonReportsAnAgentRoom() {
        #expect(!AgentsRules.showsTab(connected: true, lounge: Fixtures.lounge()))
        #expect(!AgentsRules.showsTab(connected: true, lounge: nil))
        #expect(AgentsRules.showsTab(connected: true, lounge: Fixtures.agentsLounge()))
        // Zero agents left is still a room (the card list just went empty).
        #expect(AgentsRules.showsTab(connected: true, lounge: Fixtures.agentsLounge(present: 0, openThreads: 0)))
        #expect(!AgentsRules.showsTab(connected: false, lounge: Fixtures.agentsLounge()))
        #expect(AgentsRules.effectiveTab(.agents, showsAgents: true) == .agents)
        #expect(AgentsRules.effectiveTab(.agents, showsAgents: false) == .lounge)
        #expect(AgentsRules.effectiveTab(.lounge, showsAgents: true) == .lounge)
    }

    @Test func openChatPrefersTheLoungeWhenSomethingHappensThere() {
        #expect(AgentsRules.tabOnOpen(current: .agents, lounge: Fixtures.agentsLounge()) == .agents)
        #expect(AgentsRules.tabOnOpen(current: .lounge, lounge: Fixtures.agentsLounge()) == .lounge)
        #expect(AgentsRules.tabOnOpen(current: .agents, lounge: Fixtures.room(now: t0)) == .lounge)
        #expect(AgentsRules.tabOnOpen(current: .agents, lounge: Fixtures.countdown(now: t0)) == .lounge)
        #expect(AgentsRules.tabOnOpen(current: .agents, lounge: Fixtures.reality(now: t0)) == .lounge)
        #expect(AgentsRules.tabOnOpen(current: .agents, lounge: nil) == .agents)
    }

    @Test func streamSelection() {
        let s = Fixtures.agents(now: t0)
        #expect(AgentsRules.resolve(.main, in: s) == .main)
        #expect(AgentsRules.resolve(.thread(Fixtures.authThread), in: s) == .thread(Fixtures.authThread))
        #expect(AgentsRules.resolve(.thread("gone"), in: s) == .main)
        #expect(AgentsRules.resolve(.thread(Fixtures.authThread), in: nil) == .main)

        // Main: everything outside threads, plus decisions (a thread's outcome included).
        let main = AgentsRules.messages(in: .main, of: s)
        #expect(main.allSatisfy { $0.thread == nil || $0.kind == .decision })
        #expect(main.contains { $0.kind == .decision && $0.thread == Fixtures.authThread })
        #expect(!main.contains { $0.kind == .question })
        #expect(main.map(\.kind).contains(.overlap))
        #expect(main.map(\.kind).contains(.human))
        // A thread: only its own messages, in order.
        let auth = AgentsRules.messages(in: .thread(Fixtures.authThread), of: s)
        #expect(auth.map(\.kind) == [.question, .reply, .proposal, .reply, .decision])
        #expect(auth.allSatisfy { $0.thread == Fixtures.authThread })
        #expect(AgentsRules.messages(in: .thread(Fixtures.budgetThread), of: s).count == 2)
        #expect(AgentsRules.messages(in: .main, of: nil).isEmpty)

        #expect(AgentsRules.inputPlaceholder(.main, in: s) == "Message the agents in the main stream")
        #expect(AgentsRules.inputPlaceholder(.thread(Fixtures.budgetThread), in: s) == "Message the agents in “retry budget defaults”")
    }

    @Test func copy() {
        #expect(AgentsRules.menuLine(LoungeAgents(present: 2, openThreads: 1)) == "Agents: 2 active · 1 thread")
        #expect(AgentsRules.menuLine(LoungeAgents(present: 0, openThreads: 0)) == "Agents: 0 active · 0 threads")
        let s = Fixtures.agents(now: t0)
        #expect(AgentsRules.subtitle(snapshot: s, lounge: nil) == "Local · this Mac only · 2 active · 1 open thread")
        #expect(AgentsRules.subtitle(snapshot: nil, lounge: LoungeAgents(present: 3, openThreads: 2)) == "Local · this Mac only · 3 active · 2 open threads")
        var team = s
        team.tier = "team"
        #expect(AgentsRules.subtitle(snapshot: team, lounge: nil) == "Team · 2 active · 1 open thread")
        #expect(AgentsRules.boardCounts(s.agents) == "2 active · 1 left")
        #expect(AgentsRules.overlapText([]) == nil)
        #expect(AgentsRules.overlapText(["claude-web"]) == "overlaps with claude-web")
        #expect(AgentsRules.overlapText(["a", "b"]) == "overlaps with a and b")
        #expect(AgentsRules.overlapText(["a", "b", "c", "d"]) == "overlaps with a, b and 2 more")
        #expect(AgentsRules.location(s.agents[0]) == "bnookala/api-server@feat/retry-helper")
        #expect(AgentsRules.location(AgentCard(id: "x", name: "x", worktree: "wt")) == "wt")
        #expect(AgentsRules.location(AgentCard(id: "x", name: "x")) == nil)
        #expect(AgentsRules.participants(s.threads[0]) == "copilot-api ↔ claude-web")
        #expect(AgentsRules.threadMeta(s.threads[0]) == "resolved · 5 messages")
        #expect(AgentsRules.focusHelp(s.agents[0])?.contains("Issue #42") == true)
        let labels = [AgentMessageKind.note, .question, .reply, .proposal, .decision, .handoff, .human, .sys, .overlap, .unknown("Status\u{1b}")].map(AgentsRules.kindLabel)
        #expect(labels == [nil, "question", "reply", "proposal", "decision", "handoff", "human", "sys", "overlap", "status"])
    }

    @Test func senders() throws {
        let s = Fixtures.agents(now: t0)
        let agent = AgentsRules.senderLabel(s.messages[0], me: s.human)
        #expect(agent == AgentSenderLabel(owner: "stormy-newt-59", name: "copilot-docs"))
        #expect(AgentsRules.senderLabel(s.messages[1], me: s.human) == nil, "overlap lines have no sender")
        let human = try #require(s.messages.first { $0.kind == .human })
        #expect(AgentsRules.senderLabel(human, me: s.human) == AgentSenderLabel(name: "stormy-newt-59", isHuman: true, isYou: true))
        #expect(AgentsRules.senderLabel(human, me: "someone-else")?.isYou == false)
        let reply = s.messages.last!
        #expect(AgentsRules.replyTarget(reply, in: s.messages) == "stormy-newt-59")
        #expect(AgentsRules.recipients(s.messages[3]) == "→ claude-web")
        #expect(AgentsRules.recipients(reply) == nil)
        // A display-only sender still splits into human and name.
        let bare = AgentMessage(kind: .note, from: AgentSender(display: "jade/claude-x"), text: "x")
        #expect(AgentsRules.senderLabel(bare, me: nil) == AgentSenderLabel(owner: "jade", name: "claude-x"))
    }

    @Test func peerTextStaysPlain() {
        let m = AgentMessage(kind: .note, text: "**bold** [link](https://evil.example) <b>x</b>\u{1b}[31m red\u{202E}rtl\n\nsecond line\u{7}")
        let body = AgentsRules.body(m)
        #expect(body == "**bold** [link](https://evil.example) <b>x</b>[31m redrtl\n\nsecond line")
        #expect(AgentsRules.overlapText(["a\u{1b}[2Jb"]) == "overlaps with a[2Jb")
        #expect(AgentsRules.sayText("  hi  \n") == "hi")
        #expect(AgentsRules.sayText(" \n ") == nil)
        #expect(AgentsRules.sayText(String(repeating: "x", count: 2500))?.count == AgentsRules.maxSayLength)
    }
}

@Suite("Agents: intervention gate")
struct InterventionGateTests {
    @Test func interveningNeedsTheAcknowledgementFirst() {
        var g = InterventionGate()
        #expect(!g.acknowledged && !g.inputVisible && !g.sheetShown)
        g.requestIntervene()
        #expect(g.sheetShown, "Intervene… opens the warning")
        #expect(!g.inputVisible)
        g.dismissSheet()
        #expect(!g.sheetShown && !g.inputVisible, "cancel leaves you watching")
        g.requestIntervene()
        g.ackConfirmed()
        #expect(g.acknowledged && g.inputVisible && !g.sheetShown)
        g.stopIntervening()
        #expect(!g.inputVisible)
        g.requestIntervene()
        #expect(g.inputVisible && !g.sheetShown, "the sheet is one-time")
    }

    @Test func aDaemonAcknowledgementSkipsTheSheet() {
        var g = InterventionGate(daemonAck: true)
        #expect(g.acknowledged && !g.inputVisible)
        g.requestIntervene()
        #expect(g.inputVisible && !g.sheetShown)
    }

    @Test func ackRequiredBringsTheSheetBack() {
        var g = InterventionGate(daemonAck: true)
        g.requestIntervene()
        g.ackRequired()
        #expect(g.sheetShown && !g.inputVisible && !g.acknowledged)
        // A stale snapshot that still says `ack: true` doesn't reopen the input.
        g.update(daemonAck: true)
        #expect(!g.acknowledged)
        g.dismissSheet()
        g.requestIntervene()
        #expect(g.sheetShown, "only a confirmed sheet clears ack-required")
        g.ackConfirmed()
        #expect(g.inputVisible)
    }

    @Test func aRevokedDaemonAcknowledgementHidesTheInput() {
        var g = InterventionGate(daemonAck: true)
        g.requestIntervene()
        g.update(daemonAck: false)
        #expect(!g.inputVisible)
    }
}

@Suite("Agents: panel rules")
struct AgentsPanelTests {
    @Test func theAgentsTabDoesNotHideLoungeEvents() {
        let key = ChatWindowState(isVisible: true, isKey: true, appIsActive: true)
        let c = Countdown(endsAt: t0.addingTimeInterval(20), total: 30)
        let onLounge = PanelInputs(connected: true, phase: .room, countdown: c, chat: key, chatShowsLounge: true, now: t0)
        #expect(PanelRules.decide(onLounge) == nil)
        let onAgents = PanelInputs(connected: true, phase: .room, countdown: c, chat: key, chatShowsLounge: false, now: t0)
        #expect(PanelRules.decide(onAgents) == .countdown)
        // Nothing about agents ever descends a panel.
        let quiet = PanelInputs(connected: true, phase: .lounge, chat: .closed, chatShowsLounge: false, now: t0)
        #expect(PanelRules.decide(quiet) == nil)
    }
}
