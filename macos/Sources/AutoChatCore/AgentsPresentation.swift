import Foundation

/// The chat window's tabs. Agents appears once the daemon reports an agent room.
public enum ChatTab: String, Sendable, Equatable, CaseIterable {
    case lounge
    case agents
}

/// What the agents view shows, and where an intervention goes.
public enum AgentStream: Sendable, Equatable, Hashable {
    /// Everything outside threads.
    case main
    case thread(String)

    public var threadID: String? {
        if case let .thread(id) = self { return id }
        return nil
    }
}

/// Intervening is an explicit mode behind a one-time acknowledgement (issue #25): the input
/// stays hidden until the human has confirmed the warning sheet, which sends `agents.ack`. The
/// daemon persists the acknowledgement (`ack` in every `agents` snapshot), and refuses
/// `agents.say` with `ack-required` until then, which brings the sheet back.
public struct InterventionGate: Sendable, Equatable {
    /// `ack` from the latest `agents` snapshot.
    public private(set) var daemonAck: Bool
    /// `agents.ack` succeeded on this connection (the snapshot may lag behind).
    public private(set) var confirmedAck = false
    /// The daemon said `ack-required`: only a confirmed sheet clears this.
    public private(set) var needsAck = false
    /// The human chose Intervene… (the input is visible once acknowledged).
    public private(set) var intervening = false
    public private(set) var sheetShown = false

    public init(daemonAck: Bool = false) {
        self.daemonAck = daemonAck
    }

    public var acknowledged: Bool { !needsAck && (daemonAck || confirmedAck) }
    public var inputVisible: Bool { intervening && acknowledged }

    public mutating func update(daemonAck: Bool) {
        self.daemonAck = daemonAck
    }

    /// The Intervene… button: the warning sheet first, unless it was already acknowledged.
    public mutating func requestIntervene() {
        if acknowledged {
            intervening = true
            sheetShown = false
        } else {
            sheetShown = true
        }
    }

    /// The daemon accepted `agents.ack`.
    public mutating func ackConfirmed() {
        confirmedAck = true
        needsAck = false
        sheetShown = false
        intervening = true
    }

    /// Cancel (or Esc) on the sheet.
    public mutating func dismissSheet() {
        sheetShown = false
    }

    /// `agents.say` came back with `ack-required`: hide the input and ask again.
    public mutating func ackRequired() {
        confirmedAck = false
        needsAck = true
        intervening = false
        sheetShown = true
    }

    public mutating func stopIntervening() {
        intervening = false
    }
}

/// Who sent a message, split for display: an agent's title, or its `human/name` (human
/// dimmed outside the local tier), or a human intervention.
public struct AgentSenderLabel: Sendable, Equatable {
    public var owner: String?
    public var name: String
    /// The agent's name when `name` is its title (hover text).
    public var handle: String?
    public var isHuman: Bool
    public var isYou: Bool

    public init(owner: String? = nil, name: String, handle: String? = nil, isHuman: Bool = false, isYou: Bool = false) {
        self.owner = owner
        self.name = name
        self.handle = handle
        self.isHuman = isHuman
        self.isYou = isYou
    }
}

/// A card's label (issue #66): its title, with its name (the handle for `to` and @mentions)
/// beside it. From a daemon without titles, the name alone, as before.
public struct AgentCardLabel: Sendable, Equatable {
    public var title: String
    /// The name, when the title isn't it.
    public var handle: String?
    /// The human, outside the local tier: shown as `human/` before the name.
    public var owner: String?

    public init(title: String, handle: String? = nil, owner: String? = nil) {
        self.title = title
        self.handle = handle
        self.owner = owner
    }
}

/// One row of the board: a card (indented under its parent), the disclosure for a card's
/// child sessions, or the one row the idle sessions collapse into.
public enum AgentBoardRow: Sendable, Equatable, Identifiable {
    case card(AgentCard, depth: Int)
    /// "2 child sessions" under the card with id `parent`.
    case children(parent: String, count: Int, depth: Int, expanded: Bool)
    /// "3 idle sessions": agents that haven't set a status or posted (issue #67).
    case idle(count: Int, expanded: Bool)

    public var id: String {
        switch self {
        case let .card(card, _): "card:\(card.id)"
        case let .children(parent, _, _, _): "children:\(parent)"
        case .idle: "idle"
        }
    }
}

/// Pure view-model rules for the Agents tab. Every string returned here that contains peer
/// text is already cleaned with `PlainText`; callers still render it verbatim.
public enum AgentsRules {
    public static let maxSayLength = 2000
    public static let ackRequired = "ack-required"
    public static let warning = "Agents read your messages as input. You can steer them, or confuse them."

    // MARK: Tabs

    /// The Agents tab exists once the lounge snapshot reports `agents` (non-null: an agent has
    /// connected since the daemon started).
    public static func showsTab(connected: Bool, lounge: Snapshot?) -> Bool {
        connected && lounge?.agents != nil
    }

    public static func effectiveTab(_ selected: ChatTab, showsAgents: Bool) -> ChatTab {
        showsAgents ? selected : .lounge
    }

    /// Where Open Chat lands: the lounge whenever something is happening there (autopilot, a
    /// Copilot question, the countdown or its closeout), otherwise wherever the user was.
    public static func tabOnOpen(current: ChatTab, lounge: Snapshot?) -> ChatTab {
        guard let s = lounge else { return current }
        if s.phase.isInRoom || s.phase.isCloseout || s.countdown != nil { return .lounge }
        if let r = s.request, !r.resolved { return .lounge }
        return current
    }

    // MARK: Streams

    /// The selection, or the main stream once its thread is gone.
    public static func resolve(_ stream: AgentStream, in snapshot: AgentsSnapshot?) -> AgentStream {
        guard let id = stream.threadID else { return .main }
        return snapshot?.thread(id) != nil ? stream : .main
    }

    /// Main: everything outside threads, plus decisions (every agent gets those in its inbox,
    /// including a thread's outcome). A thread: its own messages.
    public static func messages(in stream: AgentStream, of snapshot: AgentsSnapshot?) -> [AgentMessage] {
        guard let snapshot else { return [] }
        switch stream {
        case .main: return snapshot.messages.filter { $0.thread == nil || $0.kind == .decision }
        case let .thread(id): return snapshot.messages.filter { $0.thread == id }
        }
    }

    /// A resolved thread is closed: the daemon refuses posts to it (`thread <id> is resolved`).
    public static func acceptsInterventions(_ stream: AgentStream, in snapshot: AgentsSnapshot?) -> Bool {
        guard let thread = snapshot?.thread(stream.threadID) else { return true }
        return !thread.isResolved
    }

    public static func inputPlaceholder(_ stream: AgentStream, in snapshot: AgentsSnapshot?) -> String {
        if let thread = snapshot?.thread(stream.threadID) {
            return "Message the agents in “\(PlainText.clean(thread.title))”"
        }
        return "Message the agents in the main stream"
    }

    /// What `agents.say` sends for a draft, or nil if there's nothing to send.
    public static func sayText(_ draft: String) -> String? {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return String(text.prefix(maxSayLength))
    }

    // MARK: Copy

    /// The menu bar line: "Agents: 2 active · 1 thread" (open threads, from the lounge snapshot).
    public static func menuLine(_ a: LoungeAgents) -> String {
        "Agents: \(a.present) active · \(count(a.openThreads, "thread"))"
    }

    public static func tierLabel(_ tier: String?) -> String {
        switch tier?.lowercased() {
        case "local", nil, "": "Local"
        case let other?: PlainText.clean(other).capitalized
        }
    }

    public static func isLocal(_ tier: String?) -> Bool {
        tierLabel(tier) == "Local"
    }

    /// Window subtitle on the Agents tab: live counts from the agents snapshot when there is
    /// one, else the lounge summary.
    public static func subtitle(snapshot: AgentsSnapshot?, lounge: LoungeAgents?) -> String {
        var bits = [tierLabel(snapshot?.tier)]
        if isLocal(snapshot?.tier) { bits.append("this Mac only") }
        let active = snapshot.map { $0.agents.filter { $0.present && $0.active }.count } ?? lounge?.present ?? 0
        let open = snapshot.map { $0.threads.filter { $0.status == .open }.count } ?? lounge?.openThreads ?? 0
        bits.append("\(active) active")
        bits.append(count(open, "open thread"))
        return bits.joined(separator: " · ")
    }

    /// "2 active · 1 reconnecting · 1 left" for the board header. It counts the agents that
    /// have done something: idle sessions have their own row.
    public static func boardCounts(_ cards: [AgentCard]) -> String {
        let busy = cards.filter(\.active)
        let here = busy.filter { $0.presence == .here }.count
        let away = busy.filter { $0.presence == .away }.count
        let gone = busy.filter { $0.presence == .left }.count
        var bits = ["\(here) active"]
        if away > 0 { bits.append("\(away) reconnecting") }
        if gone > 0 { bits.append("\(gone) left") }
        return bits.joined(separator: " · ")
    }

    // MARK: Presence

    /// Here first, then reconnecting, then gone; otherwise in the daemon's order.
    public static func board(_ cards: [AgentCard]) -> [AgentCard] {
        cards.enumerated()
            .sorted { ($0.element.presence.rank, $0.offset) < ($1.element.presence.rank, $1.offset) }
            .map(\.element)
    }

    /// What a card says instead of its state once the agent isn't here: "reconnecting…" while the
    /// daemon holds its place (`away`), and "left 4 min ago" once it's gone (just "left" when the
    /// daemon doesn't say when). `now` is the daemon's clock.
    public static func presenceNote(_ card: AgentCard, now: Date?) -> String? {
        switch card.presence {
        case .here: return nil
        case .away: return "reconnecting…"
        case .left:
            guard let leftAt = card.leftAt, let now else { return "left" }
            return "left \(ago(leftAt, now: now))"
        }
    }

    /// "just now", "4 min ago", "2 h ago", "3 d ago".
    public static func ago(_ date: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: return "just now"
        case ..<3600: return "\(Int(seconds / 60)) min ago"
        case ..<86_400: return "\(Int(seconds / 3600)) h ago"
        default: return "\(Int(seconds / 86_400)) d ago"
        }
    }

    // MARK: Names and children (issue #66)

    /// A name as shown: in the local tier there's no `human/` prefix, since it's always the
    /// same person (names can't contain "/", so only a display can).
    public static func handle(_ name: String, local: Bool) -> String {
        guard local, let slash = name.lastIndex(of: "/") else { return name }
        let rest = String(name[name.index(after: slash)...])
        return rest.isEmpty ? name : rest
    }

    /// The card's title with its name beside it, or the name alone (with `human/` outside the
    /// local tier) from a daemon without titles.
    public static func cardLabel(_ card: AgentCard, tier: String?) -> AgentCardLabel {
        let local = isLocal(tier)
        let parts = AgentName.split(display: card.display, human: card.human, name: card.name)
        let name = PlainText.clean(handle(parts.name, local: local))
        let owner = local ? nil : parts.human.map { PlainText.clean($0) }.flatMap(\.nilIfEmpty)
        if let title = card.title.map({ PlainText.clean($0).trimmingCharacters(in: .whitespaces) }), !title.isEmpty {
            return AgentCardLabel(title: title, handle: title == name ? nil : name, owner: owner)
        }
        return AgentCardLabel(title: name, owner: owner)
    }

    /// The board as rows: agents that are here first (see `board`), each followed by its child
    /// sessions (cards whose `parent` names it), one level in, behind a disclosure. A card whose
    /// parent isn't on the board is top-level, and so is the first card of a parent loop.
    /// `collapsed` holds the ids of cards whose children are hidden. Idle sessions (issue #67)
    /// come last, collapsed into one row that `idleExpanded` opens; a tree with an active card
    /// in it stays up with the active ones.
    public static func boardRows(_ cards: [AgentCard], collapsed: Set<String> = [], idleExpanded: Bool = false) -> [AgentBoardRow] {
        let ordered = board(cards)
        // By name, the first in board order: a name can be reused once its agent has left.
        var byName: [String: AgentCard] = [:]
        for c in ordered where byName[c.name] == nil { byName[c.name] = c }
        var parentOf: [String: String] = [:]
        for c in ordered {
            guard let name = c.parent.map({ handle($0, local: true) }), let p = byName[name], p.id != c.id else { continue }
            parentOf[c.id] = p.id
        }
        // Break loops: a card whose parents lead back to it becomes top-level.
        for c in ordered {
            var seen: Set<String> = [c.id]
            var next = parentOf[c.id]
            while let p = next {
                if p == c.id {
                    parentOf[c.id] = nil
                    break
                }
                guard seen.insert(p).inserted else { break }
                next = parentOf[p]
            }
        }
        var children: [String: [AgentCard]] = [:]
        var roots: [AgentCard] = []
        for c in ordered {
            if let p = parentOf[c.id] { children[p, default: []].append(c) } else { roots.append(c) }
        }
        // A tree goes where its most present member would.
        func rank(_ c: AgentCard) -> Int {
            (children[c.id] ?? []).reduce(c.presence.rank) { min($0, rank($1)) }
        }
        let sortedRoots = roots.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
        var rows: [AgentBoardRow] = []
        func add(_ c: AgentCard, depth: Int) {
            rows.append(.card(c, depth: depth))
            guard let kids = children[c.id], !kids.isEmpty else { return }
            let expanded = !collapsed.contains(c.id)
            rows.append(.children(parent: c.id, count: kids.count, depth: depth + 1, expanded: expanded))
            if expanded { for k in kids { add(k, depth: depth + 1) } }
        }
        func isActive(_ c: AgentCard) -> Bool { c.active || (children[c.id] ?? []).contains { isActive($0) } }
        func size(_ c: AgentCard) -> Int { (children[c.id] ?? []).reduce(1) { $0 + size($1) } }
        let idle = sortedRoots.filter { !isActive($0) }
        for r in sortedRoots where isActive(r) { add(r, depth: 0) }
        if !idle.isEmpty {
            rows.append(.idle(count: idle.reduce(0) { $0 + size($1) }, expanded: idleExpanded))
            if idleExpanded { for r in idle { add(r, depth: 0) } }
        }
        return rows
    }

    /// "2 child sessions"
    public static func childrenLabel(_ count: Int) -> String {
        AgentsRules.count(count, "child session")
    }

    /// "3 idle sessions"
    public static func idleLabel(_ count: Int) -> String {
        AgentsRules.count(count, "idle session")
    }

    /// "overlaps with claude-web", or with several.
    public static func overlapText(_ names: [String]) -> String? {
        let clean = names.map { PlainText.clean($0) }.filter { !$0.isEmpty }
        switch clean.count {
        case 0: return nil
        case 1: return "overlaps with \(clean[0])"
        case 2: return "overlaps with \(clean[0]) and \(clean[1])"
        default: return "overlaps with \(clean[0]), \(clean[1]) and \(clean.count - 2) more"
        }
    }

    /// `owner/repo@branch`, falling back to the worktree name outside a known repo.
    public static func location(_ card: AgentCard) -> String? {
        let repo = card.repo.map { PlainText.clean($0) }
        let branch = card.branch.map { PlainText.clean($0) }
        switch (repo, branch) {
        case let (repo?, branch?): return "\(repo)@\(branch)"
        case let (repo?, nil): return repo
        case let (nil, branch?): return card.worktree.map { "\(PlainText.clean($0))@\(branch)" } ?? "@\(branch)"
        case (nil, nil): return card.worktree.map { PlainText.clean($0) }
        }
    }

    /// Hover text with the focus an overlap is computed from.
    public static func focusHelp(_ card: AgentCard) -> String? {
        guard let f = card.focus, !f.isEmpty else { return nil }
        var lines: [String] = []
        if let issue = f.issue { lines.append("Issue #\(issue)") }
        if !f.components.isEmpty { lines.append("Components: " + f.components.prefix(10).map { PlainText.clean($0) }.joined(separator: ", ")) }
        if !f.paths.isEmpty {
            let shown = f.paths.prefix(8).map { PlainText.clean($0) }
            lines.append("Paths: " + shown.joined(separator: ", ") + (f.paths.count > shown.count ? " and \(f.paths.count - shown.count) more" : ""))
        }
        return lines.joined(separator: "\n")
    }

    public static func participants(_ thread: AgentThread, tier: String? = nil) -> String {
        let local = isLocal(tier)
        var names = thread.participants.map { PlainText.clean(handle($0, local: local)) }
        if names.isEmpty, let opener = thread.opener { names = [PlainText.clean(handle(opener, local: local))] }
        return names.count == 2 ? "\(names[0]) ↔ \(names[1])" : names.joined(separator: ", ")
    }

    public static func statusLabel(_ status: AgentThreadStatus) -> String {
        switch status {
        case .open: "open"
        case .resolved: "resolved"
        case let .unknown(raw): String(PlainText.clean(raw).prefix(16))
        }
    }

    /// "resolved · 6 messages"
    public static func threadMeta(_ thread: AgentThread) -> String {
        var bits = [statusLabel(thread.status)]
        if let n = thread.messageCount { bits.append(count(n, "message")) }
        return bits.joined(separator: " · ")
    }

    /// Badge text for a message kind; notes have none.
    public static func kindLabel(_ kind: AgentMessageKind) -> String? {
        switch kind {
        case .note: nil
        case .question: "question"
        case .reply: "reply"
        case .proposal: "proposal"
        case .decision: "decision"
        case .handoff: "handoff"
        case .human: "human"
        case .sys: "sys"
        case .overlap: "overlap"
        case let .unknown(raw):
            String(PlainText.clean(raw).lowercased().prefix(16)).nilIfEmpty
        }
    }

    /// An agent's title when it has one (its name on hover), else its name, with `human/`
    /// only outside the local tier. Or a human intervention.
    public static func senderLabel(_ m: AgentMessage, me: String?, tier: String? = nil) -> AgentSenderLabel? {
        guard let f = m.from else { return nil }
        if m.kind == .human || (f.name == nil && f.harness == nil && f.human != nil) {
            let handle = f.human ?? f.display.map(stripHumanSuffix) ?? "someone"
            return AgentSenderLabel(name: PlainText.clean(handle), isHuman: true, isYou: me != nil && handle == me)
        }
        let local = isLocal(tier)
        let parts = AgentName.split(display: f.display, human: f.human, name: f.name)
        let name = PlainText.clean(handle(parts.name, local: local))
        if let title = f.title.map({ PlainText.clean($0).trimmingCharacters(in: .whitespaces) }), !title.isEmpty {
            return AgentSenderLabel(name: title, handle: name.isEmpty || name == title ? nil : name)
        }
        let owner = local ? nil : parts.human.map { PlainText.clean($0) }
        return AgentSenderLabel(owner: owner, name: name.isEmpty ? "agent" : name)
    }

    /// "→ claude-web"
    public static func recipients(_ m: AgentMessage, tier: String? = nil) -> String? {
        let local = isLocal(tier)
        let names = m.to.map { PlainText.clean(handle($0, local: local)) }.filter { !$0.isEmpty }
        return names.isEmpty ? nil : "→ " + names.joined(separator: ", ")
    }

    /// The sender of the message this one replies to, if it's still in the window.
    public static func replyTarget(_ m: AgentMessage, in all: [AgentMessage], tier: String? = nil) -> String? {
        guard let seq = m.replyTo, let target = all.first(where: { $0.seq == seq }) else { return nil }
        return senderLabel(target, me: nil, tier: tier)?.name
    }

    /// Message text for display: plain, newlines kept.
    public static func body(_ m: AgentMessage) -> String {
        PlainText.clean(m.text, keepNewlines: true).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func count(_ n: Int, _ noun: String) -> String {
        "\(n) \(noun)\(n == 1 ? "" : "s")"
    }

    private static func stripHumanSuffix(_ display: String) -> String {
        display.hasSuffix(" (human)") ? String(display.dropLast(8)) : display
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
