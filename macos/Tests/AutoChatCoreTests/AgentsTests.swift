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

    @Test func presenceFallsBackToPresent() throws {
        func card(_ fields: String) throws -> AgentCard {
            try #require(try decode(#"{"type":"agents","agents":[{"name":"a"\#(fields)}]}"#).agents.first)
        }
        // P1 (issue #54): here, away, left, and leftAt.
        #expect(try card(#","presence":"here","present":true"#).presence == .here)
        let away = try card(#","presence":"away","present":false,"leftAt":null"#)
        #expect(away.presence == .away)
        #expect(!away.present)
        #expect(away.leftAt == nil)
        let left = try card(#","presence":"left","present":false,"leftAt":1730400000000"#)
        #expect(left.presence == .left)
        #expect(left.leftAt == Date(timeIntervalSince1970: 1_730_400_000))
        #expect(try card(#","presence":" Away ""#).presence == .away)
        // A daemon from before P1 only says `present`: present is here, anything else left.
        #expect(try card("").presence == .here)
        #expect(try card(#","present":true"#).presence == .here)
        #expect(try card(#","present":false"#).presence == .left)
        #expect(try card(#","present":false"#).leftAt == nil)
        // An unknown or malformed presence falls back the same way.
        #expect(try card(#","presence":"dnd","present":true"#).presence == .here)
        #expect(try card(#","presence":"dnd","present":false"#).presence == .left)
        #expect(try card(#","presence":null,"present":false"#).presence == .left)
        #expect(try card(#","presence":7"#).presence == .here)
        #expect(try card(#","presence":"left","leftAt":"soon""#).leftAt == nil)
        #expect(try card(#","presence":"left","leftAt":0"#).leftAt == nil)
        // `present` always follows presence, even when the two disagree.
        #expect(try card(#","presence":"away","present":true"#).present == false)
        #expect(AgentCard(id: "x", name: "x", present: false).presence == .left)
        #expect(AgentCard(id: "x", name: "x", presence: .away).present == false)
        #expect(AgentCard(id: "x", name: "x", present: false, presence: .here).present)
    }

    @Test func titlesParentsAndAuthorTitles() throws {
        let s = try decode(#"""
        {"type":"agents","tier":"local","human":"stormy-newt-59","agents":[
          {"id":"a1","name":"lolchat-macos-menu-bar-app","display":"Lolchat macos menu bar app","title":"Lolchat macos menu bar app","parent":"autochat","human":"stormy-newt-59"},
          {"id":"a2","name":"autochat","title":"","parent":null},
          {"id":"a3","name":"copilot-x","display":"stormy-newt-59/copilot-x","title":7,"parent":["x"]}],
         "messages":[{"seq":1,"kind":"note","text":"hi","from":{"name":"lolchat-macos-menu-bar-app","display":"Lolchat macos menu bar app","title":"Lolchat macos menu bar app","human":"stormy-newt-59","harness":"copilot"}},
                     {"seq":2,"kind":"note","text":"yo","from":{"name":"copilot-x","display":"stormy-newt-59/copilot-x","human":"stormy-newt-59","harness":"copilot"}}]}
        """#.replacingOccurrences(of: "\n", with: ""))
        #expect(s.agents.map(\.title) == ["Lolchat macos menu bar app", nil, nil])
        #expect(s.agents.map(\.parent) == ["autochat", nil, nil])
        #expect(s.messages.map(\.from?.title) == ["Lolchat macos menu bar app", nil])
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

        // The daemon refuses posts to resolved threads, so they take no interventions.
        #expect(AgentsRules.acceptsInterventions(.main, in: s))
        #expect(AgentsRules.acceptsInterventions(.thread(Fixtures.budgetThread), in: s))
        #expect(!AgentsRules.acceptsInterventions(.thread(Fixtures.authThread), in: s))
        #expect(AgentsRules.acceptsInterventions(.thread("gone"), in: s))

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
        // The local tier drops the human/ prefix (issue #66); a team room keeps it.
        let agent = AgentsRules.senderLabel(s.messages[0], me: s.human, tier: s.tier)
        #expect(agent == AgentSenderLabel(name: "copilot-docs"))
        #expect(AgentsRules.senderLabel(s.messages[0], me: s.human, tier: "team") == AgentSenderLabel(owner: "stormy-newt-59", name: "copilot-docs"))
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
        #expect(AgentsRules.senderLabel(bare, me: nil, tier: "team") == AgentSenderLabel(owner: "jade", name: "claude-x"))
        #expect(AgentsRules.senderLabel(bare, me: nil) == AgentSenderLabel(name: "claude-x"))
    }

    @Test func presenceOnTheBoard() {
        let s = Fixtures.agentsPresence(now: t0)
        // Here first, then reconnecting, then gone; otherwise the daemon's order.
        #expect(AgentsRules.board(s.agents).map(\.name) == ["copilot-api", "codex-sdk", "claude-web", "copilot-docs"])
        let mixed = [
            AgentCard(id: "1", name: "gone", presence: .left), AgentCard(id: "2", name: "a", presence: .here),
            AgentCard(id: "3", name: "flaky", presence: .away), AgentCard(id: "4", name: "b", presence: .here),
            AgentCard(id: "5", name: "gone-too", presence: .left)
        ]
        #expect(AgentsRules.board(mixed).map(\.name) == ["a", "b", "flaky", "gone", "gone-too"])
        #expect(AgentsRules.boardCounts(s.agents) == "2 active · 1 reconnecting · 1 left")
        #expect(AgentsRules.boardCounts(mixed) == "2 active · 1 reconnecting · 2 left")
        #expect(AgentsRules.boardCounts([]) == "0 active")
        // Reconnecting agents aren't counted as active.
        #expect(AgentsRules.subtitle(snapshot: s, lounge: nil) == "Local · this Mac only · 2 active · 1 open thread")

        // The note that replaces the state pill.
        let web = s.agents.first { $0.name == "claude-web" }!
        let docs = s.agents.first { $0.name == "copilot-docs" }!
        #expect(AgentsRules.presenceNote(s.agents[0], now: t0) == nil)
        #expect(AgentsRules.presenceNote(web, now: t0) == "reconnecting…")
        #expect(AgentsRules.presenceNote(docs, now: t0) == "left 6 min ago")
        #expect(AgentsRules.presenceNote(docs, now: nil) == "left")
        // A daemon from before P1: no leftAt, so just "left", as before.
        let old = Fixtures.agents(now: t0).agents.first { !$0.present }!
        #expect(old.presence == .left)
        #expect(AgentsRules.presenceNote(old, now: t0) == "left")
    }

    @Test func relativeTimes() {
        func ago(_ seconds: TimeInterval) -> String { AgentsRules.ago(t0.addingTimeInterval(-seconds), now: t0) }
        #expect(ago(0) == "just now")
        #expect(ago(59) == "just now")
        #expect(ago(60) == "1 min ago")
        #expect(ago(3599) == "59 min ago")
        #expect(ago(3600) == "1 h ago")
        #expect(ago(86_399) == "23 h ago")
        #expect(ago(2 * 86_400) == "2 d ago")
        #expect(ago(-30) == "just now", "a leftAt ahead of the clock")
    }

    @Test func titlesAndHandles() throws {
        // The title is the label, with the handle beside it.
        let titled = AgentCard(id: "1", name: "lolchat-macos-menu-bar-app", display: "Lolchat macos menu bar app", title: "Lolchat macos menu bar app", human: "stormy-newt-59")
        #expect(AgentsRules.cardLabel(titled, tier: "local") == AgentCardLabel(title: "Lolchat macos menu bar app", handle: "lolchat-macos-menu-bar-app"))
        // No handle when the title is the name (a folder title, say).
        let folder = AgentCard(id: "2", name: "docs-site", display: "docs-site", title: "docs-site")
        #expect(AgentsRules.cardLabel(folder, tier: "local") == AgentCardLabel(title: "docs-site"))
        // A daemon without titles: the name alone, and no human/ prefix in the local tier.
        let old = AgentCard(id: "3", name: "copilot-x", display: "stormy-newt-59/copilot-x", human: "stormy-newt-59")
        #expect(AgentsRules.cardLabel(old, tier: "local") == AgentCardLabel(title: "copilot-x"))
        #expect(AgentsRules.cardLabel(old, tier: nil) == AgentCardLabel(title: "copilot-x"))
        // A team room keeps the human.
        #expect(AgentsRules.cardLabel(old, tier: "team") == AgentCardLabel(title: "copilot-x", owner: "stormy-newt-59"))
        #expect(AgentsRules.cardLabel(titled, tier: "team") == AgentCardLabel(title: "Lolchat macos menu bar app", handle: "lolchat-macos-menu-bar-app", owner: "stormy-newt-59"))
        // Titles are peer text: cleaned, and a blank one doesn't count.
        let messy = AgentCard(id: "4", name: "x", title: " \u{1b}[31mRed\u{202E} title ")
        #expect(AgentsRules.cardLabel(messy, tier: "local") == AgentCardLabel(title: "[31mRed title", handle: "x"))
        #expect(AgentsRules.cardLabel(AgentCard(id: "5", name: "x", title: "  "), tier: "local") == AgentCardLabel(title: "x"))

        #expect(AgentsRules.handle("stormy-newt-59/copilot-x", local: true) == "copilot-x")
        #expect(AgentsRules.handle("stormy-newt-59/copilot-x", local: false) == "stormy-newt-59/copilot-x")
        #expect(AgentsRules.handle("copilot-x", local: true) == "copilot-x")
        #expect(AgentsRules.handle("odd/", local: true) == "odd/")

        // Authors show from.title when there is one, with the handle on hover.
        let s = Fixtures.agentsNames(now: t0)
        let note = s.messages[0]
        #expect(AgentsRules.senderLabel(note, me: s.human, tier: s.tier) == AgentSenderLabel(name: "AutoChat P1 agent rooms", handle: "autochat-p1-agent-rooms"))
        let docs = try #require(s.messages.first { $0.kind == .handoff })
        #expect(AgentsRules.senderLabel(docs, me: s.human, tier: s.tier) == AgentSenderLabel(name: "docs-site"))
        let reply = try #require(s.messages.first { $0.kind == .reply && $0.thread == Fixtures.namesThread })
        #expect(AgentsRules.replyTarget(reply, in: s.messages, tier: s.tier) == "Mac app: presence and names")
        // Recipients, participants and openers are handles, without a human/ prefix locally.
        let prefixed = AgentMessage(kind: .note, to: ["stormy-newt-59/claude-web", "copilot-x"], text: "x")
        #expect(AgentsRules.recipients(prefixed, tier: "local") == "→ claude-web, copilot-x")
        #expect(AgentsRules.recipients(prefixed, tier: "team") == "→ stormy-newt-59/claude-web, copilot-x")
        let thread = AgentThread(id: "t", title: "t", opener: "stormy-newt-59/a", participants: ["stormy-newt-59/a", "b"])
        #expect(AgentsRules.participants(thread, tier: "local") == "a ↔ b")
        #expect(AgentsRules.participants(AgentThread(id: "t", title: "t", opener: "stormy-newt-59/a"), tier: "local") == "a")
    }

    @Test func childSessionsNestUnderTheirParent() {
        func rows(_ cards: [AgentCard], collapsed: Set<String> = []) -> [String] {
            AgentsRules.boardRows(cards, collapsed: collapsed).map { row in
                switch row {
                case let .card(c, depth): String(repeating: "  ", count: depth) + c.name
                case let .children(parent, count, depth, expanded): String(repeating: "  ", count: depth) + "\(expanded ? "▾" : "▸") \(count) under \(parent)"
                }
            }
        }
        let s = Fixtures.agentsNames(now: t0)
        #expect(rows(s.agents) == [
            "autochat-p1-agent-rooms",
            "  ▾ 2 under 1f2e3d4c",
            "  mac-app-presence-and-names",
            "  daemon-names-and-hello-titles",
            "api-server-fix-session-expiry",
            "docs-site"
        ])
        // The disclosure folds them; the parent keeps its place.
        #expect(rows(s.agents, collapsed: ["1f2e3d4c"]) == ["autochat-p1-agent-rooms", "  ▸ 2 under 1f2e3d4c", "api-server-fix-session-expiry", "docs-site"])
        #expect(AgentsRules.childrenLabel(2) == "2 child sessions")
        #expect(AgentsRules.childrenLabel(1) == "1 child session")

        func card(_ name: String, parent: String? = nil, _ presence: AgentPresence = .here) -> AgentCard {
            AgentCard(id: name, name: name, parent: parent, presence: presence)
        }
        // Without parents, nothing changes: presence order.
        #expect(rows([card("a", .left), card("b"), card("c", .away)]) == ["b", "c", "a"])
        // A parent that isn't on the board, or the card itself: top-level.
        #expect(rows([card("a", parent: "ghost"), card("b", parent: "b")]) == ["a", "b"])
        // Grandchildren go a level further.
        #expect(rows([card("c", parent: "b"), card("a"), card("b", parent: "a")]) == ["a", "  ▾ 1 under a", "  b", "    ▾ 1 under b", "    c"])
        // A loop: its first card in board order is top-level.
        #expect(rows([card("a", parent: "b"), card("b", parent: "a")]) == ["a", "  ▾ 1 under a", "  b"])
        #expect(rows([card("a", parent: "c"), card("b", parent: "a"), card("c", parent: "b"), card("d", parent: "b")]) == [
            "a", "  ▾ 1 under a", "  b", "    ▾ 2 under b", "    c", "    d"
        ])
        // A reused name: the agent that's here is the parent, not the one that left.
        let gone = AgentCard(id: "old", name: "lead", presence: .left)
        #expect(rows([gone, card("lead"), card("kid", parent: "lead")]) == ["lead", "  ▾ 1 under lead", "  kid", "lead"])
        // A tree sorts by its most present member: a parent that left, with a child that's here.
        #expect(rows([card("x"), card("p", .left), card("k", parent: "p"), card("y", .away)]) == ["x", "p", "  ▾ 1 under p", "  k", "y"])
        // A human/ prefix on `parent` still finds the agent.
        #expect(rows([card("a"), card("b", parent: "stormy-newt-59/a")]) == ["a", "  ▾ 1 under a", "  b"])
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
