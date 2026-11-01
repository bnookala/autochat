import Foundation

// The attention queue (issue #37, docs/protocol.md "Attention queue"): what your agents need
// from you. Presence (being in the room) is separate: an item stays until it's handled or
// dismissed, in a room or not. Decoded as leniently as the rest of the snapshot.

public enum AttentionKind: Sendable, Equatable, Hashable {
    /// Waiting for an approval or an answer: urgent.
    case blocked
    /// It hit an error.
    case failed
    /// Its run is over: a result to review.
    case finished
    /// A kind from a newer daemon, shown like `finished`.
    case unknown(String)

    public init(raw: String?) {
        switch raw {
        case "blocked": self = .blocked
        case "failed": self = .failed
        case "finished", nil: self = .finished
        case let other?: self = .unknown(other)
        }
    }

    /// Queue order: blocked, failed, then the rest.
    public var rank: Int {
        switch self {
        case .blocked: 0
        case .failed: 1
        case .finished, .unknown: 2
        }
    }

    public var isUrgent: Bool { self == .blocked }
}

/// One agent that's blocked on you, failed, or finished.
public struct AttentionItem: Sendable, Equatable, Identifiable, Decodable {
    /// Opaque, unique per daemon process: the `item` of `jumpTo` and `dismissAttention`.
    public var id: String
    public var harness: AgentHarness
    public var sid: String?
    public var cwd: String?
    public var kind: AttentionKind
    public var title: String
    public var summary: String?
    public var at: Date?

    public init(id: String, harness: AgentHarness = .copilot, sid: String? = nil, cwd: String? = nil, kind: AttentionKind, title: String, summary: String? = nil, at: Date? = nil) {
        self.id = id
        self.harness = harness
        self.sid = sid
        self.cwd = cwd
        self.kind = kind
        self.title = title
        self.summary = summary
        self.at = at
    }

    enum CodingKeys: String, CodingKey { case id, harness, sid, cwd, kind, title, summary, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Without an id there's nothing to jump to or dismiss: the list skips it.
        guard let id = c.lenient(String.self, .id) ?? c.lenientInt(.id).map(String.init), !id.isEmpty else {
            throw DecodingError.keyNotFound(CodingKeys.id, .init(codingPath: c.codingPath, debugDescription: "attention item without id"))
        }
        self.id = id
        // Hook messages from before harness adapters are Copilot's.
        harness = AgentHarness(raw: c.lenient(String.self, .harness) ?? "copilot")
        sid = c.lenient(String.self, .sid)
        cwd = c.lenient(String.self, .cwd)
        kind = AttentionKind(raw: c.lenient(String.self, .kind))
        title = c.lenient(String.self, .title) ?? ""
        summary = c.lenient(String.self, .summary)
        at = c.lenientDouble(.at).map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}

/// Pure presentation rules for the queue: shared by the status item, the panel and the chat.
public enum AttentionRules {
    /// Rows a panel shows before "and N more".
    public static let panelRows = 4
    /// Rows the countdown panel shows under the countdown.
    public static let countdownRows = 3

    /// Urgent first, oldest first within a kind (the daemon's order; sorted again to be safe).
    public static func sorted(_ items: [AttentionItem]) -> [AttentionItem] {
        items.enumerated().sorted { a, b in
            if a.element.kind.rank != b.element.kind.rank { return a.element.kind.rank < b.element.kind.rank }
            let ta = a.element.at ?? .distantPast
            let tb = b.element.at ?? .distantPast
            return ta != tb ? ta < tb : a.offset < b.offset
        }.map(\.element)
    }

    /// The menu bar badge: agents blocked on you.
    public static func urgentCount(_ items: [AttentionItem]?) -> Int {
        (items ?? []).filter(\.kind.isUrgent).count
    }

    /// `1 blocked · 2 finished`
    public static func counts(_ items: [AttentionItem]) -> String {
        let order: [(String, (AttentionKind) -> Bool)] = [
            ("blocked", { $0 == .blocked }), ("failed", { $0 == .failed }), ("finished", { $0.rank == 2 })
        ]
        return order.compactMap { name, matches in
            let n = items.filter { matches($0.kind) }.count
            return n > 0 ? "\(n) \(name)" : nil
        }.joined(separator: " · ")
    }

    /// The harness as people call it.
    public static func harnessName(_ h: AgentHarness) -> String {
        switch h {
        case .copilot: "Copilot"
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .opencode: "opencode"
        case .gemini: "Gemini"
        case .pi: "pi"
        case .generic: h.label
        }
    }

    public static func title(_ item: AttentionItem) -> String {
        let t = PlainText.clean(item.title).trimmingCharacters(in: .whitespaces)
        if !t.isEmpty { return t }
        let name = harnessName(item.harness)
        switch item.kind {
        case .blocked: return "\(name) needs you"
        case .failed: return "\(name) ran into a problem"
        case .finished, .unknown: return "\(name) finished"
        }
    }

    public static func summary(_ item: AttentionItem) -> String? {
        item.summary.map { PlainText.clean($0).trimmingCharacters(in: .whitespaces) }.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Where it works: the last component of its directory.
    public static func place(_ item: AttentionItem) -> String? {
        guard let cwd = item.cwd.map({ PlainText.clean($0) }), !cwd.isEmpty else { return nil }
        let last = cwd.split(separator: "/").last.map(String.init) ?? cwd
        return last == "~" ? cwd : last
    }

    /// The attention panel's headline: who is blocked on you.
    public static func headline(_ items: [AttentionItem]) -> String {
        let blocked = items.filter(\.kind.isUrgent)
        switch blocked.count {
        case 0: return items.count == 1 ? "An agent needs your attention" : "\(items.count) agents need your attention"
        case 1: return "\(harnessName(blocked[0].harness)) needs you"
        default: return "\(blocked.count) agents need you"
        }
    }

    /// Under the headline: everything else in the queue, or what blocked means.
    public static func subheadline(_ items: [AttentionItem]) -> String {
        let others = items.filter { !$0.kind.isUrgent }
        if others.isEmpty { return "Waiting for an approval or an answer" }
        return "Also " + counts(others)
    }

    /// The chat strip: the queue without the question the request card already shows.
    public static func stripItems(_ snapshot: Snapshot?) -> [AttentionItem] {
        let items = sorted(snapshot?.attention ?? [])
        guard let request = snapshot?.request, !request.resolved, let sid = request.sid else { return items }
        return items.filter { !($0.kind.isUrgent && $0.sid == sid) }
    }

    /// The countdown panel lists the queue when it holds more than the run that just ended:
    /// with several agents, that's where you pick which one to go to.
    public static func countdownList(_ items: [AttentionItem]?) -> [AttentionItem] {
        let all = sorted(items ?? [])
        return all.count >= 2 ? all : []
    }

    /// VoiceOver and tooltips.
    public static func accessibilityLabel(_ item: AttentionItem) -> String {
        var bits = [title(item), harnessName(item.harness)]
        if let place = place(item) { bits.append("in \(place)") }
        if let summary = summary(item) { bits.append(summary) }
        return bits.joined(separator: ", ")
    }

    /// The status item's tooltip line for the badge.
    public static func badgeTooltip(_ count: Int) -> String {
        count == 1 ? "An agent needs you" : "\(count) agents need you"
    }

    /// Badge text: up to 9, then `9+`.
    public static func badgeText(_ count: Int) -> String {
        count > 9 ? "9+" : "\(count)"
    }
}
