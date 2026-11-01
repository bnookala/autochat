import AppKit
import AutoChatCore
import SwiftUI

// The Agents tab (issue #25): the board, advertised threads, the selected stream, and the
// intervention input behind a one-time acknowledgement. Peer text (names, summaries, titles,
// outcomes, messages) is always rendered with `Text(verbatim:)` or a plain `AttributedString`
// built by `AgentText`: never markdown, never links.

struct AgentsView: View {
    @Bindable var agents: AgentsModel

    static let sidebarWidth: CGFloat = 340

    var body: some View {
        if let snapshot = agents.snapshot {
            HStack(spacing: 0) {
                AgentsSidebar(agents: agents, snapshot: snapshot)
                    .frame(width: Self.sidebarWidth)
                Divider()
                StreamPane(agents: agents, snapshot: snapshot)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            AgentsPlaceholder(connection: agents.connection)
        }
    }
}

// MARK: - Plain text helpers

enum AgentText {
    static let time: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    static func time(_ date: Date?) -> String {
        date.map { time.string(from: $0) } ?? ""
    }

    /// `human/name` with the human part dimmed, as a plain `AttributedString`
    /// (`AttributedString(String)` never parses markdown, and no `.link` is ever added).
    static func name(owner: String?, name: String, font: Font = .body, nameColor: Color = .primary) -> AttributedString {
        var out = AttributedString()
        if let owner, !owner.isEmpty {
            var o = AttributedString(owner + "/")
            o.font = font
            o.foregroundColor = .secondary
            out += o
        }
        var n = AttributedString(name)
        n.font = font.weight(.semibold)
        n.foregroundColor = nameColor
        out += n
        return out
    }

    /// The sender of a message: an agent's title or name, or a human's handle.
    static func sender(_ label: AgentSenderLabel, font: Font = .callout) -> AttributedString {
        guard label.isHuman else { return name(owner: label.owner, name: label.name, font: font) }
        var out = name(owner: nil, name: label.name, font: font, nameColor: Theme.intervene)
        var tag = AttributedString(label.isYou ? " (you)" : " (human)")
        tag.font = font
        tag.foregroundColor = .secondary
        out += tag
        return out
    }

    /// A card's title with its handle smaller beside it (issue #66), or the name alone (with
    /// `human/` dimmed outside the local tier).
    static func handle(_ label: AgentCardLabel) -> String? {
        label.handle.map { (label.owner.map { $0 + "/" } ?? "") + $0 }
    }
}

// MARK: - Sidebar: board and streams

enum AgentsSidebarLayout {
    /// Child sessions sit one step in, up to a few levels.
    static func indent(_ depth: Int) -> CGFloat {
        CGFloat(min(max(depth, 0), 3)) * 16
    }
}

private struct AgentsSidebar: View {
    let agents: AgentsModel
    let snapshot: AgentsSnapshot

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                TierBanner(tier: snapshot.tier)
                    .padding(.bottom, 6)
                SidebarHeader(title: "Agents", detail: AgentsRules.boardCounts(snapshot.agents))
                if snapshot.agents.isEmpty {
                    Text("No agents right now. They appear here when a harness with autochat's MCP server starts.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 4)
                }
                // Ticks so "left 4 min ago" stays true between snapshots.
                TimelineView(.periodic(from: .now, by: 20)) { context in
                    let now = agents.daemonNow(at: context.date)
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(agents.boardRows) { row in
                            switch row {
                            case let .card(card, depth):
                                AgentCardView(card: card, now: now, tier: snapshot.tier)
                                    .padding(.leading, AgentsSidebarLayout.indent(depth))
                            case let .children(parent, count, depth, expanded):
                                BoardDisclosure(title: AgentsRules.childrenLabel(count), expanded: expanded) {
                                    agents.toggleChildren(of: parent)
                                }
                                .padding(.leading, AgentsSidebarLayout.indent(depth))
                            case let .idle(count, expanded):
                                IdleSessionsRow(count: count, expanded: expanded) { agents.toggleIdle() }
                            }
                        }
                    }
                }
                SidebarHeader(title: "Streams", detail: nil)
                    .padding(.top, 10)
                MainStreamRow(
                    count: AgentsRules.messages(in: .main, of: snapshot).count,
                    selected: agents.stream == .main
                ) { agents.select(.main) }
                ForEach(Self.threads(snapshot.threads)) { thread in
                    ThreadCardView(thread: thread, tier: snapshot.tier, selected: agents.stream == .thread(thread.id)) {
                        agents.select(.thread(thread.id))
                    }
                }
            }
            .padding(12)
        }
        .scrollIndicators(.automatic)
        .background(Theme.sidebarFill)
    }

    /// Open threads first, most recently active first.
    static func threads(_ threads: [AgentThread]) -> [AgentThread] {
        func last(_ t: AgentThread) -> Date { t.lastAt ?? t.openedAt ?? .distantPast }
        let open = threads.filter { !$0.isResolved }.sorted { last($0) > last($1) }
        let done = threads.filter(\.isResolved).sorted { last($0) > last($1) }
        return open + done
    }
}

private struct TierBanner: View {
    let tier: String?

    var body: some View {
        let local = AgentsRules.isLocal(tier)
        HStack(alignment: .center, spacing: 8) {
            Label {
                Text(verbatim: AgentsRules.tierLabel(tier))
            } icon: {
                Image(systemName: local ? "lock.fill" : "person.2.fill")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(Palette.green)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Palette.green.opacity(0.13)))
            Text(local ? "Agents on this Mac. Nothing leaves it." : "Shared agent room")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .help(local ? "The local agent room is hosted by autochat on this Mac's socket. It never touches the network." : "")
        .accessibilityElement(children: .combine)
    }
}

private struct SidebarHeader: View {
    let title: String
    let detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(0.6)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            if let detail {
                Text(verbatim: detail)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 4)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: Agent card

/// "▸ 3 idle sessions" (issue #67): the sessions that haven't set a status or posted, folded
/// into one row under the active agents. Clicking it shows them.
struct IdleSessionsRow: View {
    let count: Int
    let expanded: Bool
    let action: () -> Void

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous)
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .frame(width: 10)
                Image(systemName: "moon.zzz")
                    .font(.callout)
                Text(verbatim: AgentsRules.idleLabel(count))
                    .font(.callout.weight(.medium))
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(shape.fill(Theme.cardFill.opacity(0.55)))
            .overlay(shape.strokeBorder(Color.primary.opacity(0.16), style: StrokeStyle(lineWidth: 0.75, dash: [3, 2.5])))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .animation(.smooth(duration: 0.15), value: expanded)
        .help(expanded ? "Hide the idle sessions" : "Sessions that haven't set a status or posted yet. Other agents don't see them.")
        .accessibilityLabel(AgentsRules.idleLabel(count))
        .accessibilityValue(expanded ? "expanded" : "collapsed")
    }
}

/// A one-line disclosure on the board: "▸ 2 child sessions". Clicking it shows or hides them.
struct BoardDisclosure: View {
    let title: String
    let expanded: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .frame(width: 10)
                Text(verbatim: title)
                    .font(.caption.weight(.medium))
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.smooth(duration: 0.15), value: expanded)
        .help(expanded ? "Hide them" : "Show them")
        .accessibilityLabel(title)
        .accessibilityValue(expanded ? "expanded" : "collapsed")
    }
}

struct AgentCardView: View {
    let card: AgentCard
    /// The daemon's clock, for "left 4 min ago".
    var now: Date?
    var tier: String? = "local"

    var body: some View {
        let label = AgentsRules.cardLabel(card, tier: tier)
        VStack(alignment: .leading, spacing: 6) {
            header(label)
            if let location = AgentsRules.location(card) {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 9, weight: .semibold))
                    Text(verbatim: location)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let issue = card.focus?.issue {
                        Text(verbatim: "· #\(issue)")
                            .fixedSize()
                    }
                }
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                switch card.presence {
                case .here:
                    if let state = card.state { StatePill(state: state) }
                case .away:
                    Pill(text: AgentsRules.presenceNote(card, now: now) ?? "reconnecting…", symbol: "arrow.triangle.2.circlepath", tint: Palette.amber)
                case .left:
                    Pill(text: AgentsRules.presenceNote(card, now: now) ?? "left", symbol: "door.left.hand.open", tint: Palette.gray)
                }
                if let summary = card.summary.map({ PlainText.clean($0) }), !summary.isEmpty {
                    Text(verbatim: summary)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let overlap = AgentsRules.overlapText(card.overlaps) {
                Label {
                    Text(verbatim: overlap)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.overlap)
                .lineLimit(2)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous).fill(Theme.cardFill))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous).strokeBorder(Theme.cardStroke, lineWidth: 0.5))
        .opacity(Self.opacity(card.presence))
        .help(help(label))
        .accessibilityElement(children: .combine)
    }

    /// The title with its handle beside it when both fit on a line, else the handle on its own
    /// line under the title (a handle never breaks). From a daemon without titles, the name.
    @ViewBuilder
    private func header(_ label: AgentCardLabel) -> some View {
        if let handle = AgentText.handle(label) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    PresenceDot(presence: card.presence)
                    title(label).lineLimit(1)
                    handleText(handle)
                    Spacer(minLength: 4)
                    HarnessBadge(harness: card.harness)
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        PresenceDot(presence: card.presence)
                        title(label)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .layoutPriority(1)
                        Spacer(minLength: 4)
                        HarnessBadge(harness: card.harness)
                    }
                    handleText(handle)
                        .truncationMode(.middle)
                        .padding(.leading, PresenceDot.width + 6)
                }
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                PresenceDot(presence: card.presence)
                Text(AgentText.name(owner: label.owner, name: label.title, font: .body))
                    .lineLimit(1)
                    .truncationMode(.head)
                    .layoutPriority(1)
                Spacer(minLength: 4)
                HarnessBadge(harness: card.harness)
            }
        }
    }

    private func title(_ label: AgentCardLabel) -> some View {
        Text(verbatim: label.title)
            .font(.body.weight(.semibold))
    }

    private func handleText(_ handle: String) -> some View {
        Text(verbatim: handle)
            .font(.callout)
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }

    /// Dimmed once it isn't here; a little less while it may still come back.
    static func opacity(_ presence: AgentPresence) -> Double {
        switch presence {
        case .here: 1
        case .away: 0.7
        case .left: 0.55
        }
    }

    private func help(_ label: AgentCardLabel) -> String {
        var lines: [String] = []
        if let handle = label.handle { lines.append("Handle: \(handle)") }
        switch card.presence {
        case .here: break
        case .away: lines.append("Its connection dropped. autochat keeps its place for a few seconds in case it comes back.")
        case .left: if let leftAt = card.leftAt { lines.append("Left at \(AgentText.time(leftAt))") }
        }
        if let focus = AgentsRules.focusHelp(card) { lines.append(focus) }
        return lines.joined(separator: "\n")
    }
}

struct PresenceDot: View {
    let presence: AgentPresence
    static let width: CGFloat = 8

    var body: some View {
        Group {
            switch presence {
            case .here:
                Image(systemName: "circle.fill").foregroundStyle(Theme.active)
            case .away:
                Image(systemName: "circle.dotted").foregroundStyle(Palette.amber)
            case .left:
                Image(systemName: "circle").foregroundStyle(.secondary)
            }
        }
        .font(.system(size: 7, weight: .bold))
        .frame(width: Self.width)
        .accessibilityLabel(Self.label(presence))
    }

    static func label(_ presence: AgentPresence) -> String {
        switch presence {
        case .here: "here"
        case .away: "reconnecting"
        case .left: "left"
        }
    }
}

/// Small capsule with an SF Symbol and a label.
struct Pill: View {
    let text: String
    var symbol: String?
    var glyph: String?
    let tint: Color

    var body: some View {
        HStack(spacing: 3) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 8.5, weight: .bold))
            } else if let glyph {
                Text(verbatim: glyph)
                    .font(.system(size: 10, weight: .bold))
            }
            Text(verbatim: text)
                .font(.caption2.weight(.semibold))
        }
        .lineLimit(1)
        .fixedSize()
        .foregroundStyle(tint)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule(style: .continuous).fill(tint.opacity(0.14)))
    }
}

struct HarnessBadge: View {
    let harness: AgentHarness

    var body: some View {
        let style = Self.style(harness)
        Pill(text: harness.label, symbol: style.symbol, glyph: style.glyph, tint: style.tint)
            .help("Harness: \(harness.label)")
            .accessibilityLabel("harness \(harness.label)")
    }

    static func style(_ harness: AgentHarness) -> (symbol: String?, glyph: String?, tint: Color) {
        switch harness {
        case .copilot: ("airplane", nil, Palette.purple)
        case .claude: ("asterisk", nil, Palette.claude)
        case .codex: ("chevron.left.forwardslash.chevron.right", nil, Palette.teal)
        case .opencode: ("curlybraces", nil, Palette.indigo)
        case .gemini: ("sparkle", nil, Palette.blue)
        case .pi: (nil, "π", Palette.pink)
        case .generic: ("cpu", nil, Palette.gray)
        }
    }
}

struct StatePill: View {
    let state: AgentState

    var body: some View {
        let style = Self.style(state)
        Pill(text: state.label, symbol: style.symbol, tint: style.tint)
            .accessibilityLabel("state \(state.label)")
    }

    static func style(_ state: AgentState) -> (symbol: String?, tint: Color) {
        switch state {
        case .exploring: ("binoculars.fill", Palette.teal)
        case .editing: ("pencil", Palette.blue)
        case .testing: ("testtube.2", Palette.purple)
        case .blocked: ("hand.raised.fill", Palette.red)
        case .done: ("checkmark", Palette.green)
        case .idle: ("moon.zzz.fill", Palette.gray)
        case .unknown: (nil, Palette.gray)
        }
    }
}

// MARK: Streams

private struct MainStreamRow: View {
    let count: Int
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "number")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(selected ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
                Text("Main stream")
                    .font(.callout.weight(.semibold))
                Spacer(minLength: 4)
                Text(verbatim: "\(count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(SelectableCard(selected: selected))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Main stream, \(count) messages")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct ThreadCardView: View {
    let thread: AgentThread
    var tier: String? = "local"
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "bubble.left.and.text.bubble.right")
                        .font(.caption)
                        .foregroundStyle(selected ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
                    Text(verbatim: PlainText.clean(thread.title))
                        .font(.callout.weight(.semibold))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    ThreadStatusPill(status: thread.status)
                }
                Text(verbatim: AgentsRules.participants(thread, tier: tier))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(verbatim: meta)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                if thread.isResolved, let outcome = thread.outcome.map({ PlainText.clean($0) }), !outcome.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Palette.green)
                        Text(verbatim: outcome)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(SelectableCard(selected: selected))
        }
        .buttonStyle(.plain)
        .help(thread.outcome.map { "Outcome: \(PlainText.clean($0))" } ?? "")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var meta: String {
        var bits: [String] = []
        if let n = thread.messageCount { bits.append("\(n) message\(n == 1 ? "" : "s")") }
        if let at = thread.lastAt ?? thread.openedAt { bits.append(AgentText.time(at)) }
        return bits.joined(separator: " · ")
    }
}

struct ThreadStatusPill: View {
    let status: AgentThreadStatus

    var body: some View {
        switch status {
        case .open: Pill(text: "open", symbol: "circle.fill", tint: Palette.green)
        case .resolved: Pill(text: "resolved", symbol: "checkmark", tint: Palette.gray)
        case .unknown: Pill(text: AgentsRules.statusLabel(status), tint: Palette.gray)
        }
    }
}

private struct SelectableCard: ViewModifier {
    let selected: Bool

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous)
                    .fill(selected ? AnyShapeStyle(Color.accentColor.opacity(0.14)) : AnyShapeStyle(Theme.cardFill))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous)
                    .strokeBorder(selected ? Color.accentColor.opacity(0.75) : Theme.cardStroke, lineWidth: selected ? 1.5 : 0.5)
            )
            .contentShape(RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous))
    }
}

// MARK: - Stream pane

private struct StreamPane: View {
    @Bindable var agents: AgentsModel
    let snapshot: AgentsSnapshot

    var body: some View {
        let stream = agents.stream
        let messages = agents.messages
        VStack(spacing: 0) {
            StreamHeader(thread: snapshot.thread(stream.threadID), count: messages.count, tier: snapshot.tier)
            Divider()
            AgentMessageList(stream: stream, messages: messages, snapshot: snapshot) { agents.select(.thread($0)) }
            VStack(spacing: 0) {
                Divider()
                InterveneBar(agents: agents, snapshot: snapshot)
            }
            .background(.bar)
        }
    }
}

private struct StreamHeader: View {
    let thread: AgentThread?
    let count: Int
    var tier: String? = "local"

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let thread {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "bubble.left.and.text.bubble.right")
                        .foregroundStyle(.secondary)
                    Text(verbatim: PlainText.clean(thread.title))
                        .font(.title3.weight(.semibold))
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    ThreadStatusPill(status: thread.status)
                }
                Text(verbatim: details(thread))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if thread.isResolved, let outcome = thread.outcome.map({ PlainText.clean($0, keepNewlines: true) }), !outcome.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(Palette.green)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Outcome")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Palette.green)
                            Text(verbatim: outcome)
                                .font(.callout)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Palette.green.opacity(0.10)))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Palette.green.opacity(0.35), lineWidth: 0.5))
                    .padding(.top, 2)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "number")
                        .foregroundStyle(.secondary)
                    Text("Main stream")
                        .font(.title3.weight(.semibold))
                    Spacer(minLength: 8)
                    Text(verbatim: "\(count) message\(count == 1 ? "" : "s")")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Text("Notes, questions and handoffs outside threads, and every decision.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func details(_ t: AgentThread) -> String {
        var bits = [AgentsRules.participants(t, tier: tier)]
        if let opener = t.opener {
            bits.append("opened by \(PlainText.clean(AgentsRules.handle(opener, local: AgentsRules.isLocal(tier))))" + (t.openedAt.map { " at \(AgentText.time($0))" } ?? ""))
        }
        if let n = t.messageCount { bits.append("\(n) message\(n == 1 ? "" : "s")") }
        return bits.joined(separator: " · ")
    }
}

// MARK: Messages

struct AgentMessageRowID: Identifiable, Equatable {
    let id: String
    let message: AgentMessage

    /// Unique ids even if a daemon repeats one.
    static func rows(_ messages: [AgentMessage]) -> [AgentMessageRowID] {
        var seen: [String: Int] = [:]
        return messages.map { m in
            let n = seen[m.id, default: 0]
            seen[m.id] = n + 1
            return AgentMessageRowID(id: n == 0 ? m.id : "\(m.id)#\(n)", message: m)
        }
    }
}

private struct AgentMessageList: View {
    let stream: AgentStream
    let messages: [AgentMessage]
    let snapshot: AgentsSnapshot
    let onOpenThread: (String) -> Void
    @State private var pinned = true
    @State private var unseen = false

    var body: some View {
        let rows = AgentMessageRowID.rows(messages)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if rows.isEmpty {
                        Text(stream == .main ? "Nothing in the main stream yet." : "No messages in this thread yet.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 40)
                    }
                    ForEach(rows) { row in
                        AgentMessageRow(
                            message: row.message,
                            sender: AgentsRules.senderLabel(row.message, me: snapshot.human, tier: snapshot.tier),
                            replyTarget: AgentsRules.replyTarget(row.message, in: snapshot.messages, tier: snapshot.tier),
                            recipients: AgentsRules.recipients(row.message, tier: snapshot.tier),
                            threadTitle: stream == .main ? snapshot.thread(row.message.thread)?.title : nil,
                            onOpenThread: row.message.thread.map { id in { onOpenThread(id) } }
                        )
                        .id(row.id)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                        .onAppear { pinned = true; unseen = false }
                        .onDisappear { pinned = false }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .id(stream)
            .onChange(of: rows.last?.id) {
                let mine = rows.last.map { $0.message.kind == .human && AgentsRules.senderLabel($0.message, me: snapshot.human)?.isYou == true } ?? false
                if ScrollFollow.shouldFollow(pinnedToBottom: pinned, newestIsMine: mine) {
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                } else {
                    unseen = true
                }
            }
            .onChange(of: stream) { unseen = false }
            .overlay(alignment: .bottomTrailing) {
                if unseen && !pinned {
                    Button {
                        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    } label: {
                        Label("New messages", systemImage: "arrow.down")
                            .font(.callout.weight(.medium))
                    }
                    .buttonStyle(.action(prominent: true, size: .small))
                    .padding(12)
                }
            }
        }
    }
}

struct AgentMessageRow: View {
    let message: AgentMessage
    let sender: AgentSenderLabel?
    let replyTarget: String?
    /// "→ claude-web"
    var recipients: String?
    /// Set when a thread's decision shows in the main stream.
    let threadTitle: String?
    let onOpenThread: (() -> Void)?

    var body: some View {
        switch message.kind {
        case .sys: line(secondary: true)
        case .overlap: line(secondary: false)
        default: block
        }
    }

    private var time: some View {
        Text(verbatim: AgentText.time(message.ts))
            .font(.caption.monospacedDigit())
            .foregroundStyle(.tertiary)
            .frame(width: 36, alignment: .leading)
    }

    /// `sys` and `overlap`: one line with no sender.
    private func line(secondary: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            time
            KindBadge(kind: message.kind)
            Text(verbatim: AgentsRules.body(message))
                .font(.callout)
                .italic(secondary)
                .foregroundStyle(secondary ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.vertical, secondary ? 0 : 5)
        .padding(.horizontal, secondary ? 0 : 6)
        .background {
            if !secondary {
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.overlap.opacity(0.10))
            }
        }
        .padding(.horizontal, secondary ? 0 : -6)
        .accessibilityElement(children: .combine)
    }

    private var block: some View {
        let emphasis = Self.emphasis(message.kind)
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            time
            VStack(alignment: .leading, spacing: 3) {
                header
                Text(verbatim: AgentsRules.body(message))
                    .font(message.kind == .decision ? .body.weight(.medium) : .body)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, emphasis == nil ? 0 : 7)
        .padding(.horizontal, emphasis == nil ? 0 : 6)
        .background {
            if let emphasis {
                RoundedRectangle(cornerRadius: 9, style: .continuous).fill(emphasis.opacity(0.09))
                RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(emphasis.opacity(0.35), lineWidth: 0.5)
            }
        }
        .padding(.horizontal, emphasis == nil ? 0 : -6)
        .accessibilityElement(children: .combine)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            KindBadge(kind: message.kind)
            if let sender {
                Text(AgentText.sender(sender))
                    .lineLimit(1)
                    .truncationMode(sender.handle == nil ? .head : .tail)
                    .layoutPriority(1)
                    .help(sender.handle ?? "")
            }
            if let to = recipients {
                Text(verbatim: to)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else if let replyTarget {
                Text(verbatim: "↩ \(replyTarget)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let threadTitle, let onOpenThread {
                Button(action: onOpenThread) {
                    HStack(spacing: 4) {
                        Image(systemName: "bubble.left.and.text.bubble.right")
                            .font(.system(size: 9, weight: .semibold))
                        Text(verbatim: PlainText.clean(threadTitle))
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 7, weight: .bold))
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule(style: .continuous).fill(Color.primary.opacity(0.07)))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .help("Show the thread")
                .accessibilityLabel("Show the thread")
            }
        }
    }

    /// Decisions and human interventions stand out.
    static func emphasis(_ kind: AgentMessageKind) -> Color? {
        switch kind {
        case .decision: Palette.green
        case .human: Theme.intervene
        default: nil
        }
    }
}

struct KindBadge: View {
    let kind: AgentMessageKind

    var body: some View {
        if let label = AgentsRules.kindLabel(kind) {
            let style = Self.style(kind)
            Pill(text: label, symbol: style.symbol, tint: style.tint)
                .accessibilityLabel(label)
        }
    }

    static func style(_ kind: AgentMessageKind) -> (symbol: String?, tint: Color) {
        switch kind {
        case .note: (nil, Palette.gray)
        case .question: ("questionmark", Palette.blue)
        case .reply: ("arrowshape.turn.up.left.fill", Palette.teal)
        case .proposal: ("lightbulb.fill", Palette.purple)
        case .decision: ("checkmark.seal.fill", Palette.green)
        case .handoff: ("arrow.right.circle.fill", Palette.indigo)
        case .human: ("person.fill", Theme.intervene)
        case .sys: ("info.circle.fill", Palette.gray)
        case .overlap: ("exclamationmark.triangle.fill", Theme.overlap)
        case .unknown: ("questionmark.circle", Palette.gray)
        }
    }
}

// MARK: - Intervening

private struct InterveneBar: View {
    @Bindable var agents: AgentsModel
    let snapshot: AgentsSnapshot
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if agents.gate.inputVisible {
                intervening
            } else {
                watching
            }
            if let error = agents.lastError {
                Label {
                    Text(verbatim: error)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.caption)
                .foregroundStyle(.red)
                .padding(.leading, 6)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .animation(.smooth(duration: 0.2), value: agents.gate.inputVisible)
    }

    private var watching: some View {
        let closed = agents.streamIsClosed
        return HStack(spacing: 8) {
            Image(systemName: closed ? "checkmark.seal" : "eye")
                .foregroundStyle(.secondary)
            Text(closed ? "This thread is resolved, so it takes no more messages." : "You're watching. Agents only hear from you if you intervene.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 8)
            Button {
                agents.intervene()
            } label: {
                Label("Intervene…", systemImage: "hand.raised")
            }
            .buttonStyle(.action(tint: Theme.intervene))
            .disabled(closed)
            .help(closed ? "Pick the main stream or an open thread to intervene" : agents.gate.acknowledged ? "Write to the agents as a human" : "Agents read your messages as input. You'll be asked to confirm once.")
        }
        .padding(.vertical, 2)
    }

    private var intervening: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill")
                Text("Intervening as human")
                    .fontWeight(.semibold)
                Text(verbatim: target)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Button("Stop") { agents.stopIntervening() }
                    .buttonStyle(.action(size: .small))
                    .keyboardShortcut(.cancelAction)
                    .help("Hide the input and go back to watching (Esc)")
            }
            .font(.callout)
            .foregroundStyle(Theme.intervene)
            if agents.streamIsClosed {
                Label("This thread is resolved. Pick the main stream or an open thread to intervene.", systemImage: "checkmark.seal")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
                    .padding(.leading, 4)
            } else {
                input
            }
        }
        .onAppear { if !agents.isFixture { focused = true } }
    }

    private var input: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(AgentsRules.inputPlaceholder(agents.stream, in: snapshot), text: $agents.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.body)
                .lineLimit(1...5)
                .focused($focused)
                .focusEffectDisabled()
                .onSubmit { Task { await agents.submit() } }
                .accessibilityLabel("Message to the agents")
                .padding(.vertical, 3)
            Button {
                Task { await agents.submit() }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 22))
                    .symbolRenderingMode(.hierarchical)
            }
            .buttonStyle(.plain)
            .foregroundStyle(canSend ? Theme.intervene : Color.secondary.opacity(0.5))
            .disabled(!canSend)
            .help("Send to the agents (⏎)")
            .accessibilityLabel("Send")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color(nsColor: .textBackgroundColor)))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Theme.intervene.opacity(focused ? 0.75 : 0.45), lineWidth: 1)
        )
    }

    private var target: String {
        let handle = snapshot.human.map { PlainText.clean($0) } ?? "you"
        if let thread = agents.selectedThread {
            return "· \(handle) → “\(PlainText.clean(thread.title))”"
        }
        return "· \(handle) → main stream"
    }

    private var canSend: Bool {
        !agents.sending && AgentsRules.sayText(agents.draft) != nil
    }
}

/// The one-time acknowledgement. Confirming sends `agents.ack`.
struct AckSheet: View {
    let agents: AgentsModel

    var body: some View {
        VStack(spacing: 16) {
            Badge(symbol: "hand.raised.fill", colors: [Color.orange, Color(red: 0.98, green: 0.36, blue: 0.22)])
                .scaleEffect(1.15)
                .padding(.top, 4)
            VStack(spacing: 6) {
                Text("Intervene in the agent room?")
                    .font(.title3.weight(.semibold))
                Text(verbatim: AgentsRules.warning)
                    .font(.body)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 9) {
                point("person.fill", "What you send reaches the agents as a human message, marked as an intervention.")
                point("text.bubble", "It goes to the stream you're looking at: the main stream or a thread.")
                point("checkmark.shield", "You only need to confirm this once.")
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.05)))
            if let error = agents.ackError {
                Label {
                    Text(verbatim: error)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.callout)
                .foregroundStyle(.red)
            }
            HStack(spacing: 10) {
                Button {
                    agents.cancelAck()
                } label: {
                    Text("Cancel").frame(maxWidth: .infinity)
                }
                .buttonStyle(.action(size: .large))
                .keyboardShortcut(.cancelAction)
                Button {
                    Task { await agents.confirmAck() }
                } label: {
                    Text("Intervene").frame(maxWidth: .infinity)
                }
                .buttonStyle(.action(prominent: true, tint: .orange, size: .large))
                .keyboardShortcut(.defaultAction)
                .disabled(agents.acknowledging)
            }
        }
        .padding(24)
        .frame(width: 400)
        .accessibilityElement(children: .contain)
    }

    private func point(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Image(systemName: symbol)
                .font(.callout)
                .foregroundStyle(Theme.intervene)
                .frame(width: 16)
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Not connected yet

private struct AgentsPlaceholder: View {
    let connection: DaemonClient.State

    var body: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 0)
            switch connection {
            case let .incompatible(why):
                Image(systemName: "lock.trianglebadge.exclamationmark")
                    .font(.system(size: 36, weight: .light))
                    .foregroundStyle(.secondary)
                Text("Agent room unavailable")
                    .font(.title3.weight(.semibold))
                Text(verbatim: why)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 380)
            default:
                ProgressView()
                Text("Connecting to the agent room…")
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
