import Foundation

// Models for the local agent room's human stream (issue #21): `subscribe` with
// `"stream":"agents"` → `agents` snapshots. Decoded as leniently as the lounge snapshot:
// unknown fields are ignored, unknown kinds and states are kept as `.unknown`, unknown
// harnesses become generic, missing optional fields are nil, and a bad element in a list is
// skipped instead of failing the whole snapshot.

/// The harness an agent runs in. The CLI's fallback (`agent`) and unknown names are generic.
public enum AgentHarness: Sendable, Equatable, Hashable {
    case copilot, claude, codex, opencode, gemini, pi
    /// Unknown harness, with its raw name if it had a useful one.
    case generic(String?)

    public init(raw: String?) {
        let name = raw?.trimmingCharacters(in: .whitespaces).lowercased()
        switch name {
        case "copilot": self = .copilot
        case "claude": self = .claude
        case "codex": self = .codex
        case "opencode": self = .opencode
        case "gemini": self = .gemini
        case "pi": self = .pi
        case nil, "", "agent", "generic": self = .generic(nil)
        case let other?: self = .generic(other)
        }
    }

    /// Badge text.
    public var label: String {
        switch self {
        case .copilot: "copilot"
        case .claude: "claude"
        case .codex: "codex"
        case .opencode: "opencode"
        case .gemini: "gemini"
        case .pi: "pi"
        case let .generic(name):
            name.map { String(PlainText.clean($0).prefix(16)) }.flatMap { $0.isEmpty ? nil : $0 } ?? "generic"
        }
    }
}

/// What an agent says it's doing (`status({state})`).
public enum AgentState: Sendable, Equatable, Hashable {
    case exploring, editing, testing, blocked, done, idle
    case unknown(String)

    /// nil when the card has no state.
    public init?(raw: String?) {
        guard let raw, !raw.isEmpty else { return nil }
        switch raw.lowercased() {
        case "exploring": self = .exploring
        case "editing": self = .editing
        case "testing": self = .testing
        case "blocked": self = .blocked
        case "done": self = .done
        case "idle": self = .idle
        default: self = .unknown(raw)
        }
    }

    public var label: String {
        switch self {
        case .exploring: "exploring"
        case .editing: "editing"
        case .testing: "testing"
        case .blocked: "blocked"
        case .done: "done"
        case .idle: "idle"
        case let .unknown(raw): String(PlainText.clean(raw).prefix(16))
        }
    }
}

/// Where an agent is (issue #54): connected, dropped and inside its resume window, or gone.
public enum AgentPresence: Sendable, Equatable, Hashable {
    case here, away, left

    /// nil for anything else: then the card's `present` decides.
    public init?(raw: String?) {
        switch raw?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "here": self = .here
        case "away": self = .away
        case "left": self = .left
        default: return nil
        }
    }

    /// Board order: here, then reconnecting, then gone.
    public var rank: Int {
        switch self {
        case .here: 0
        case .away: 1
        case .left: 2
        }
    }
}

/// `focus` on a card: what overlap is computed from.
public struct AgentFocus: Sendable, Equatable, Decodable {
    public var issue: Int?
    public var components: [String]
    public var paths: [String]

    public init(issue: Int? = nil, components: [String] = [], paths: [String] = []) {
        self.issue = issue
        self.components = components
        self.paths = paths
    }

    enum CodingKeys: String, CodingKey { case issue, components, paths }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        issue = c.lenientInt(.issue)
        components = c.lenient(LossyList<String>.self, .components)?.items ?? []
        paths = c.lenient(LossyList<String>.self, .paths)?.items ?? []
    }

    public var isEmpty: Bool { issue == nil && components.isEmpty && paths.isEmpty }
}

/// One agent on the board. Replaced, never appended.
public struct AgentCard: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    /// The handle for `to` and @mentions.
    public var name: String
    /// `human/name`, or in P1's local tier the title.
    public var display: String?
    /// The label people read (issue #66): the session's title, `repo@branch`, or the folder.
    /// nil from a daemon without titles.
    public var title: String?
    /// The name of the agent this one is a child session of, if it said.
    public var parent: String?
    public var human: String?
    public var harness: AgentHarness
    public var repo: String?
    public var branch: String?
    public var worktree: String?
    public var state: AgentState?
    public var summary: String?
    public var focus: AgentFocus?
    /// here, away (reconnecting) or left. A daemon without `presence` only says `present`:
    /// then present is `here` and anything else is `left`, as before.
    public var presence: AgentPresence
    /// When it left, once `presence` is `left` (if the daemon says).
    public var leftAt: Date?
    /// It has set a status or posted (issue #67). Idle sessions collapse on the board. A
    /// daemon without `active` means every card is.
    public var active: Bool
    public var joinedAt: Date?
    public var updatedAt: Date?
    /// Names of the agents it overlaps with.
    public var overlaps: [String]

    /// Connected now (`presence == .here`): the protocol's `present`.
    public var present: Bool { presence == .here }

    public init(
        id: String, name: String, display: String? = nil, title: String? = nil, parent: String? = nil, human: String? = nil,
        harness: AgentHarness = .generic(nil), repo: String? = nil, branch: String? = nil, worktree: String? = nil,
        state: AgentState? = nil, summary: String? = nil, focus: AgentFocus? = nil, present: Bool = true,
        presence: AgentPresence? = nil, leftAt: Date? = nil, active: Bool = true, joinedAt: Date? = nil, updatedAt: Date? = nil, overlaps: [String] = []
    ) {
        self.id = id
        self.name = name
        self.display = display
        self.title = title
        self.parent = parent
        self.human = human
        self.harness = harness
        self.repo = repo
        self.branch = branch
        self.worktree = worktree
        self.state = state
        self.summary = summary
        self.focus = focus
        self.presence = presence ?? (present ? .here : .left)
        self.leftAt = leftAt
        self.active = active
        self.joinedAt = joinedAt
        self.updatedAt = updatedAt
        self.overlaps = overlaps
    }

    enum CodingKeys: String, CodingKey {
        case id, name, display, title, parent, human, harness, repo, branch, worktree, state, summary, focus, present, presence, leftAt, active, joinedAt, updatedAt, overlaps
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let display = c.nonEmpty(.display)
        let name = c.nonEmpty(.name) ?? display.map { AgentName.split(display: $0, human: nil).name }
        guard let name, !name.isEmpty else {
            throw DecodingError.keyNotFound(CodingKeys.name, .init(codingPath: c.codingPath, debugDescription: "card without a name"))
        }
        self.name = name
        self.display = display
        title = c.nonEmpty(.title)
        parent = c.nonEmpty(.parent)
        id = c.nonEmpty(.id) ?? name
        human = c.nonEmpty(.human)
        harness = AgentHarness(raw: c.lenient(String.self, .harness))
        repo = c.nonEmpty(.repo)
        branch = c.nonEmpty(.branch)
        worktree = c.nonEmpty(.worktree)
        state = AgentState(raw: c.lenient(String.self, .state))
        summary = c.nonEmpty(.summary)
        focus = c.lenient(AgentFocus.self, .focus)
        presence = AgentPresence(raw: c.lenient(String.self, .presence)) ?? ((c.lenient(Bool.self, .present) ?? true) ? .here : .left)
        leftAt = c.lenientDate(.leftAt)
        active = c.lenient(Bool.self, .active) ?? true
        joinedAt = c.lenientDate(.joinedAt)
        updatedAt = c.lenientDate(.updatedAt)
        overlaps = c.lenient(LossyList<String>.self, .overlaps)?.items.filter { !$0.isEmpty } ?? []
    }
}

public enum AgentThreadStatus: Sendable, Equatable, Hashable {
    case open, resolved
    case unknown(String)

    public init(raw: String?) {
        switch raw?.lowercased() {
        case "open", nil, "": self = .open
        case "resolved": self = .resolved
        case let other?: self = .unknown(other)
        }
    }
}

/// An advertised thread: anyone can read it, only participants are pinged.
public struct AgentThread: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var title: String
    public var opener: String?
    public var participants: [String]
    public var status: AgentThreadStatus
    public var outcome: String?
    /// The thread's message count (`messages` in the protocol).
    public var messageCount: Int?
    public var openedAt: Date?
    public var lastAt: Date?

    public init(
        id: String, title: String, opener: String? = nil, participants: [String] = [], status: AgentThreadStatus = .open,
        outcome: String? = nil, messageCount: Int? = nil, openedAt: Date? = nil, lastAt: Date? = nil
    ) {
        self.id = id
        self.title = title
        self.opener = opener
        self.participants = participants
        self.status = status
        self.outcome = outcome
        self.messageCount = messageCount
        self.openedAt = openedAt
        self.lastAt = lastAt
    }

    enum CodingKeys: String, CodingKey { case id, title, opener, participants, status, outcome, messages, openedAt, lastAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.nonEmpty(.id) else {
            throw DecodingError.keyNotFound(CodingKeys.id, .init(codingPath: c.codingPath, debugDescription: "thread without an id"))
        }
        self.id = id
        title = c.nonEmpty(.title) ?? id
        opener = c.nonEmpty(.opener)
        participants = c.lenient(LossyList<String>.self, .participants)?.items.filter { !$0.isEmpty } ?? []
        status = AgentThreadStatus(raw: c.lenient(String.self, .status))
        outcome = c.nonEmpty(.outcome)
        messageCount = c.lenientInt(.messages)
        openedAt = c.lenientDate(.openedAt)
        lastAt = c.lenientDate(.lastAt)
    }

    public var isResolved: Bool { status == .resolved }
}

public enum AgentMessageKind: Sendable, Equatable, Hashable {
    case note, question, reply, proposal, decision, handoff, human, sys, overlap
    case unknown(String)

    public init(raw: String?) {
        switch raw?.lowercased() {
        case "note", nil, "": self = .note
        case "question": self = .question
        case "reply": self = .reply
        case "proposal": self = .proposal
        case "decision": self = .decision
        case "handoff": self = .handoff
        case "human": self = .human
        case "sys": self = .sys
        case "overlap": self = .overlap
        case let other?: self = .unknown(other)
        }
    }
}

/// `from` on a message: an agent, or a human intervention (`name: null`, `harness: null`).
public struct AgentSender: Sendable, Equatable, Decodable {
    public var name: String?
    public var display: String?
    /// The author's title (issue #66), shown instead of its name when there is one.
    public var title: String?
    public var human: String?
    public var harness: AgentHarness?
    public var repo: String?

    public init(name: String? = nil, display: String? = nil, title: String? = nil, human: String? = nil, harness: AgentHarness? = nil, repo: String? = nil) {
        self.name = name
        self.display = display
        self.title = title
        self.human = human
        self.harness = harness
        self.repo = repo
    }

    enum CodingKeys: String, CodingKey { case name, display, title, human, harness, repo }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.nonEmpty(.name)
        display = c.nonEmpty(.display)
        title = c.nonEmpty(.title)
        human = c.nonEmpty(.human)
        harness = c.nonEmpty(.harness).map { AgentHarness(raw: $0) }
        repo = c.nonEmpty(.repo)
    }
}

public struct AgentMessage: Sendable, Equatable, Decodable, Identifiable {
    /// Increasing per daemon; the list identity.
    public var seq: Int?
    /// The protocol's `id`.
    public var messageID: String?
    public var ts: Date?
    public var kind: AgentMessageKind
    /// nil for `sys` and `overlap` lines.
    public var from: AgentSender?
    /// nil: the main stream.
    public var thread: String?
    public var to: [String]
    public var replyTo: Int?
    public var text: String
    /// A human intervention.
    public var intervention: Bool

    public init(
        seq: Int? = nil, messageID: String? = nil, ts: Date? = nil, kind: AgentMessageKind = .note, from: AgentSender? = nil,
        thread: String? = nil, to: [String] = [], replyTo: Int? = nil, text: String, intervention: Bool? = nil
    ) {
        self.seq = seq
        self.messageID = messageID
        self.ts = ts
        self.kind = kind
        self.from = from
        self.thread = thread
        self.to = to
        self.replyTo = replyTo
        self.text = text
        self.intervention = intervention ?? (kind == .human)
    }

    enum CodingKeys: String, CodingKey { case seq, id, ts, kind, from, thread, to, replyTo, text, intervention }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = c.lenientInt(.seq)
        messageID = c.nonEmpty(.id) ?? c.lenientInt(.id).map(String.init)
        ts = c.lenientDate(.ts)
        kind = AgentMessageKind(raw: c.lenient(String.self, .kind))
        from = c.lenient(AgentSender.self, .from)
        thread = c.nonEmpty(.thread)
        to = c.lenient(LossyList<String>.self, .to)?.items.filter { !$0.isEmpty } ?? []
        replyTo = c.lenientInt(.replyTo)
        text = c.lenient(String.self, .text) ?? ""
        intervention = c.lenient(Bool.self, .intervention) ?? (kind == .human)
    }

    /// Stable list identity: `seq`, else the message id, else a content key.
    public var id: String {
        if let seq { return "s\(seq)" }
        if let messageID { return "m\(messageID)" }
        let ms = Int(((ts?.timeIntervalSince1970 ?? 0) * 1000).rounded())
        return "k\(ms)|\(kind)|\(from?.display ?? "")|\(text.hashValue)"
    }
}

/// One `{"type":"agents"}` line: the whole room, replaced on every change.
public struct AgentsSnapshot: Sendable, Equatable, Decodable {
    public var version: Int?
    public var now: Date?
    /// `local` in P0.
    public var tier: String?
    /// The local identity's handle: whose interventions are "you".
    public var human: String?
    /// The one-time intervention acknowledgement (`agentsInterventionAck` in config).
    public var ack: Bool
    public var agents: [AgentCard]
    public var threads: [AgentThread]
    /// The last 300 messages across the main stream and all threads, oldest first.
    public var messages: [AgentMessage]

    public init(
        version: Int? = 1, now: Date? = nil, tier: String? = "local", human: String? = nil, ack: Bool = false,
        agents: [AgentCard] = [], threads: [AgentThread] = [], messages: [AgentMessage] = []
    ) {
        self.version = version
        self.now = now
        self.tier = tier
        self.human = human
        self.ack = ack
        self.agents = agents
        self.threads = threads
        self.messages = messages
    }

    enum CodingKeys: String, CodingKey { case v, now, tier, human, ack, agents, threads, messages }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.lenientInt(.v)
        now = c.lenientDate(.now)
        tier = c.nonEmpty(.tier)
        human = c.nonEmpty(.human)
        ack = c.lenient(Bool.self, .ack) ?? false
        agents = c.lenient(LossyList<AgentCard>.self, .agents)?.items ?? []
        threads = c.lenient(LossyList<AgentThread>.self, .threads)?.items ?? []
        messages = c.lenient(LossyList<AgentMessage>.self, .messages)?.items ?? []
    }

    public func thread(_ id: String?) -> AgentThread? {
        guard let id else { return nil }
        return threads.first { $0.id == id }
    }
}

/// `agents` in the lounge `state` snapshot. The field is null until an agent has connected
/// since the daemon started, so `Snapshot.agents != nil` means "this daemon hosts a room".
public struct LoungeAgents: Sendable, Equatable, Decodable {
    public var present: Int
    public var openThreads: Int

    public init(present: Int = 0, openThreads: Int = 0) {
        self.present = present
        self.openThreads = openThreads
    }

    enum CodingKeys: String, CodingKey { case present, openThreads }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        present = max(0, c.lenientInt(.present) ?? 0)
        openThreads = max(0, c.lenientInt(.openThreads) ?? 0)
    }
}

/// `human/name` split into its parts, so the human can be dimmed.
public enum AgentName {
    public static func split(display: String?, human: String?, name: String? = nil) -> (human: String?, name: String) {
        if let name, !name.isEmpty {
            let owner = human ?? display.flatMap { d -> String? in
                guard let slash = d.lastIndex(of: "/") else { return nil }
                let h = String(d[..<slash])
                return h.isEmpty ? nil : h
            }
            return (owner, name)
        }
        guard let display, !display.isEmpty else { return (human, "") }
        if let slash = display.lastIndex(of: "/") {
            let h = String(display[..<slash])
            return (h.isEmpty ? human : h, String(display[display.index(after: slash)...]))
        }
        return (human, display)
    }
}

extension KeyedDecodingContainer {
    /// A string that's present and non-empty, else nil.
    func nonEmpty(_ key: Key) -> String? {
        guard let s = lenient(String.self, key), !s.isEmpty else { return nil }
        return s
    }

    /// Milliseconds since the epoch (number or numeric string). `0` means unset.
    func lenientDate(_ key: Key) -> Date? {
        guard let ms = lenientDouble(key), ms > 0 else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }
}
