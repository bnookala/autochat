import AppKit
import AutoChatCore
import SwiftUI

/// Native version of the TUI in src/tui.js. Every piece of peer text is rendered with
/// `Text(verbatim:)` / plain `AttributedString(String)`: never markdown, never links.
/// Once the daemon hosts an agent room, the window has a second tab: Agents (AgentsView).
struct ChatView: View {
    @Bindable var model: AppModel
    var onSelectTab: @MainActor (ChatTab) -> Void = { _ in }

    var body: some View {
        VStack(spacing: 0) {
            if model.connected, let snapshot = model.snapshot {
                if model.showsAgentsTab {
                    ChatTabStrip(selection: model.effectiveTab, onSelect: onSelectTab)
                    Divider()
                }
                if model.effectiveTab == .agents {
                    AgentsView(agents: model.agents)
                } else {
                    lounge(snapshot)
                }
            } else {
                DaemonStatusView(model: model)
            }
        }
        .frame(minWidth: 420, minHeight: 420)
        .sheet(isPresented: ackSheetShown) {
            AckSheet(agents: model.agents)
        }
    }

    private var ackSheetShown: Binding<Bool> {
        Binding(
            get: { model.agents.gate.sheetShown },
            set: { shown in if !shown { model.agents.cancelAck() } }
        )
    }

    private func lounge(_ snapshot: Snapshot) -> some View {
        let p = model.presentation
        return VStack(spacing: 0) {
            if snapshot.phase.isInRoom || (snapshot.phase.isCloseout && !snapshot.messages.isEmpty) {
                roomBody(snapshot, p)
            } else if snapshot.phase.isCloseout {
                Spacer(minLength: 0)
            } else {
                LoungeView(model: model, presentation: p)
            }
        }
        .overlay {
            if let closeout = p.closeout {
                CloseoutOverlay(closeout: closeout, secondsLeft: model.closeoutSecondsLeft, onKeepOpen: { model.cancelCloseout() })
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
            }
        }
        .animation(.smooth(duration: 0.25), value: p.closeout)
    }

    @ViewBuilder
    private func roomBody(_ snapshot: Snapshot, _ p: ChatPresentation) -> some View {
        if !snapshot.members.isEmpty {
            MembersBar(members: snapshot.members)
            Divider()
        }
        if let request = snapshot.request {
            RequestCard(request: request, model: model)
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
        MessageList(messages: snapshot.messages)
            .animation(.default, value: snapshot.request)
        VStack(spacing: 0) {
            if let countdown = snapshot.countdown {
                CountdownStrip(countdown: countdown, now: model.now, canReturn: p.canReturnNow) {
                    model.perform(.returnNow)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            InputBar(model: model, presentation: p)
        }
        .background(.bar)
        .animation(.smooth(duration: 0.25), value: snapshot.countdown == nil)
    }
}

// MARK: - Tabs

/// Lounge | Agents, as a scope bar under the toolbar. Only there once the daemon hosts an
/// agent room.
struct ChatTabStrip: View {
    let selection: ChatTab
    let onSelect: @MainActor (ChatTab) -> Void

    var body: some View {
        TabSwitch(selection: selection, onSelect: onSelect)
            .fixedSize()
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity)
    }
}

/// A native segmented control: unlike SwiftUI's segmented picker it shows the lock next to
/// "Agents".
private struct TabSwitch: NSViewRepresentable {
    let selection: ChatTab
    let onSelect: @MainActor (ChatTab) -> Void

    func makeNSView(context: Context) -> NSSegmentedControl {
        let control = NSSegmentedControl(labels: ["Lounge", "Agents"], trackingMode: .selectOne, target: context.coordinator, action: #selector(Coordinator.changed(_:)))
        let lock = NSImage(systemSymbolName: "lock.fill", accessibilityDescription: "local")?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
        control.setImage(lock, forSegment: 1)
        control.setImageScaling(.scaleNone, forSegment: 1)
        control.setToolTip("The lounge: chat with people on autopilot", forSegment: 0)
        control.setToolTip("The local agent room: your agents on this Mac. Nothing leaves it.", forSegment: 1)
        control.setAccessibilityLabel("View")
        return control
    }

    func updateNSView(_ control: NSSegmentedControl, context: Context) {
        context.coordinator.onSelect = onSelect
        control.selectedSegment = selection == .agents ? 1 : 0
    }

    func makeCoordinator() -> Coordinator { Coordinator(onSelect: onSelect) }

    @MainActor
    final class Coordinator: NSObject {
        var onSelect: @MainActor (ChatTab) -> Void

        init(onSelect: @escaping @MainActor (ChatTab) -> Void) {
            self.onSelect = onSelect
        }

        @objc func changed(_ sender: NSSegmentedControl) {
            onSelect(sender.selectedSegment == 1 ? .agents : .lounge)
        }
    }
}

// MARK: - Members

struct MembersBar: View {
    let members: [Member]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(members.enumerated()), id: \.offset) { _, m in
                    MemberChip(member: m)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Members")
    }
}

struct MemberChip: View {
    let member: Member

    var body: some View {
        HStack(spacing: 5) {
            statusIcon
            Text(verbatim: PlainText.clean(member.handle))
                .font(.callout.weight(member.isYou ? .semibold : .regular))
                .foregroundStyle(member.color.color)
                .opacity(member.status == .away ? 0.6 : 1)
            if member.isHost {
                Image(systemName: "star.fill")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.yellow)
                    .accessibilityLabel("host")
            }
            if member.isYou {
                Text("you")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(Capsule().fill(Color.primary.opacity(0.06)))
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5))
        .help(statusHelp)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var statusIcon: some View {
        switch member.status {
        case .needed:
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.orange)
                .accessibilityLabel("needed by Copilot")
        case .away:
            Image(systemName: "circle")
                .font(.system(size: 7, weight: .bold))
                .foregroundStyle(.secondary)
                .accessibilityLabel("spectating")
        default:
            Image(systemName: "circle.fill")
                .font(.system(size: 7))
                .foregroundStyle(Theme.active)
                .accessibilityLabel("on autopilot")
        }
    }

    private var statusHelp: String {
        switch member.status {
        case .needed: "\(member.handle)'s copilot is asking them something"
        case .away: "\(member.handle) is spectating"
        default: "\(member.handle) is on autopilot"
        }
    }
}

// MARK: - Messages

struct MessageRow: Identifiable, Equatable {
    let id: String
    let message: ChatMessage

    /// Stable ids across snapshots (the core trims old messages from the front).
    static func rows(_ messages: [ChatMessage]) -> [MessageRow] {
        var seen: [String: Int] = [:]
        return messages.map { m in
            let ms = Int(((m.ts?.timeIntervalSince1970 ?? 0) * 1000).rounded())
            let base = m.mid ?? "\(ms)|\(m.from ?? "")|\(m.kind)|\(m.text.hashValue)"
            let n = seen[base, default: 0]
            seen[base] = n + 1
            return MessageRow(id: n == 0 ? base : "\(base)#\(n)", message: m)
        }
    }
}

struct MessageList: View {
    let messages: [ChatMessage]
    @State private var pinned = true
    @State private var unseen = false

    var body: some View {
        let rows = MessageRow.rows(messages)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 5) {
                    ForEach(rows) { row in
                        MessageView(message: row.message)
                            .id(row.id)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                        .onAppear { pinned = true; unseen = false }
                        .onDisappear { pinned = false }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: rows.last?.id) {
                if ScrollFollow.shouldFollow(pinnedToBottom: pinned, newestIsMine: rows.last?.message.isSelf ?? false) {
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                } else {
                    unseen = true
                }
            }
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

struct MessageView: View {
    let message: ChatMessage

    private static let time: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: message.ts.map { Self.time.string(from: $0) } ?? "")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: 36, alignment: .leading)
            if message.kind == .sys {
                Text(verbatim: PlainText.clean(message.text))
                    .font(.callout)
                    .foregroundStyle(message.color.map { AnyShapeStyle($0.color.opacity(0.85)) } ?? AnyShapeStyle(.secondary))
                    .italic()
            } else {
                Text(chatLine)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    /// `handle  text` as a plain AttributedString: `AttributedString(String)` never parses
    /// markdown, and no `.link` attributes are ever added.
    private var chatLine: AttributedString {
        var name = AttributedString(PlainText.clean(message.from ?? "someone"))
        name.font = .body.weight(.semibold)
        name.foregroundColor = message.color.color
        var line = name
        if message.isSelf {
            var you = AttributedString(" (you)")
            you.foregroundColor = .secondary
            you.font = .callout
            line += you
        }
        var text = AttributedString("  " + PlainText.clean(message.text))
        text.font = .body
        line += text
        return line
    }
}

// MARK: - Copilot request

struct RequestCard: View {
    let request: CopilotRequest
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: request.resolved ? "checkmark.bubble.fill" : "exclamationmark.bubble.fill")
                    .foregroundStyle(request.resolved ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.orange))
                    .font(.title3)
                Text(verbatim: PlainText.clean(request.title ?? "Copilot needs you"))
                    .font(.headline)
                Spacer(minLength: 8)
                if let cwd = request.cwd, !cwd.isEmpty {
                    Label {
                        Text(verbatim: PlainText.clean(cwd))
                    } icon: {
                        Image(systemName: "folder")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
            }
            Text(verbatim: PlainText.clean(request.message?.isEmpty == false ? request.message! : "Your copilot is waiting for your input.", keepNewlines: true))
                .font(.body)
                .lineLimit(6)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                if request.resolved {
                    Label("Autopilot carried on without you", systemImage: "checkmark.circle")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    Text("⏎ on an empty line also jumps to Copilot")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 8)
                Button("Dismiss") { model.perform(.dismissRequest) }
                    .buttonStyle(.action())
                Button("Jump to Copilot") { model.perform(.jumpToCopilot) }
                    .buttonStyle(.action(prominent: true, tint: .orange))
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.orange.opacity(request.resolved ? 0.05 : 0.10)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.orange.opacity(request.resolved ? 0.2 : 0.4), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Copilot request")
    }
}

// MARK: - Countdown strip (non-blocking)

struct CountdownStrip: View {
    let countdown: Countdown
    let now: Date
    let canReturn: Bool
    let onReturn: () -> Void

    var body: some View {
        let remaining = CountdownClock.remainingSeconds(until: countdown.endsAt, now: now)
        let fraction = CountdownClock.fractionLeft(endsAt: countdown.endsAt, total: countdown.total, now: now)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "hourglass")
                    .foregroundStyle(Theme.countdown)
                    .font(.callout.weight(.semibold))
                Text(verbatim: CountdownClock.title(remaining: remaining))
                    .font(.callout.weight(.semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText(countsDown: true))
                Text(verbatim: "· \(CountdownClock.reasonPhrase(countdown.reason)) · keep chatting")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
                Button("Return Now", action: onReturn)
                    .buttonStyle(.action(tint: Theme.countdown, size: .small))
                    .disabled(!canReturn || remaining == 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            GeometryReader { geo in
                Rectangle()
                    .fill(Theme.countdown)
                    .frame(width: geo.size.width * fraction)
                    .animation(.linear(duration: 0.4), value: remaining)
            }
            .frame(height: 2)
        }
        .background(Theme.countdown.opacity(0.10))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(CountdownClock.title(remaining: remaining))
    }
}

// MARK: - Input

struct InputBar: View {
    @Bindable var model: AppModel
    let presentation: ChatPresentation
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField(presentation.inputPlaceholder, text: $model.draft)
                    .textFieldStyle(.plain)
                    .font(.body)
                    .focused($focused)
                    .focusEffectDisabled()
                    .disabled(!presentation.inputEnabled)
                    .onSubmit { model.submitDraft() }
                    .accessibilityLabel("Message")
                Button {
                    model.submitDraft()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 22))
                        .symbolRenderingMode(.hierarchical)
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSend ? Color.accentColor : Color.secondary.opacity(0.5))
                .disabled(!canSend)
                .help("Send (⏎)")
                .accessibilityLabel("Send")
            }
            .padding(.leading, 14)
            .padding(.trailing, 6)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(nsColor: .textBackgroundColor).opacity(presentation.inputEnabled ? 1 : 0.5))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Color.primary.opacity(focused ? 0.25 : 0.12), lineWidth: 1)
            )
            if let error = model.lastError {
                Label {
                    Text(verbatim: error)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.caption)
                .foregroundStyle(.red)
                .padding(.leading, 8)
            }
        }
        .padding(10)
        .onAppear { if presentation.inputEnabled && !model.isFixture { focused = true } }
        .onChange(of: presentation.inputEnabled) { _, enabled in if enabled { focused = true } }
    }

    private var canSend: Bool {
        presentation.inputEnabled && !model.draft.trimmingCharacters(in: .whitespaces).isEmpty
    }
}

// MARK: - Closeout

struct CloseoutOverlay: View {
    let closeout: Closeout
    let secondsLeft: Int?
    let onKeepOpen: () -> Void

    var body: some View {
        ZStack {
            Rectangle()
                .fill(Color(nsColor: .windowBackgroundColor).opacity(0.82))
                .ignoresSafeArea()
            VStack(spacing: 10) {
                Image(systemName: closeout.symbol)
                    .font(.system(size: 40, weight: .regular))
                    .symbolRenderingMode(.multicolor)
                    .foregroundStyle(Theme.countdown)
                    .padding(.bottom, 2)
                Text(verbatim: closeout.title)
                    .font(.title2.weight(.bold))
                Text(verbatim: closeout.body)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if let cwd = closeout.cwd {
                    Label {
                        Text(verbatim: PlainText.clean(cwd))
                    } icon: {
                        Image(systemName: "folder")
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }
                if let summary = closeout.summary {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Copilot's summary")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ScrollView {
                            Text(verbatim: summary)
                                .font(.callout)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 120)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.05)))
                }
                if let secondsLeft {
                    HStack(spacing: 10) {
                        Text(verbatim: "Closing in \(secondsLeft)s")
                            .font(.callout)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Button("Keep Open", action: onKeepOpen)
                            .buttonStyle(.action(size: .small))
                    }
                    .padding(.top, 4)
                } else {
                    Text("Go examine your situation.")
                        .font(.callout)
                        .foregroundStyle(.tertiary)
                        .padding(.top, 4)
                }
            }
            .padding(24)
            .frame(maxWidth: 400)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.regularMaterial))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
            .shadow(color: .black.opacity(0.15), radius: 20, y: 6)
            .padding(24)
        }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Lounge and connection states

struct LoungeView: View {
    let model: AppModel
    let presentation: ChatPresentation

    var body: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 46, weight: .light))
                .foregroundStyle(.secondary)
            Text("Waiting for autopilot")
                .font(.title2.weight(.semibold))
            Text(verbatim: "When a Copilot CLI session goes on autopilot, you drop into \(model.snapshot?.room?.display ?? "#lobby") with everyone else on autopilot.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 340)
            if let handle = presentation.myHandle {
                HStack(spacing: 6) {
                    Text("You are")
                        .foregroundStyle(.secondary)
                    Text(verbatim: handle)
                        .fontWeight(.semibold)
                        .foregroundStyle(model.snapshot?.me?.color.color ?? .primary)
                }
            }
            Button("Join Now") { model.perform(.joinNow) }
                .buttonStyle(.action(prominent: true, size: .large))
                .disabled(!presentation.canJoinNow)
                .help("Join the room now, without autopilot")
            Text("Change rooms with autochat join <code> · autochat host")
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer(minLength: 0)
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct DaemonStatusView: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            content
            Spacer(minLength: 0)
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var content: some View {
        switch (model.daemon, model.connection) {
        case (.cliMissing, _):
            Image(systemName: "shippingbox")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(.secondary)
            Text("autochat CLI not found")
                .font(.title2.weight(.semibold))
            Text("AutoChat runs the autochat command-line tool in the background. Install it, then try again:")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 360)
            HStack(spacing: 8) {
                Text(verbatim: DaemonLocator.installCommand)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(DaemonLocator.installCommand, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
            Button("Try Again") { model.supervisor?.retry() }
                .buttonStyle(.action(prominent: true))
        case let (.restarting(after, code), _):
            ProgressView().controlSize(.small)
            Text("autochat stopped unexpectedly")
                .font(.title3.weight(.semibold))
            Text(verbatim: "autochat daemon exited with code \(code). Restarting in \(Int(after.rounded()))s. If this keeps happening, update the CLI with \(DaemonLocator.installCommand)")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 380)
        case let (.failed(why), _):
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 36))
                .foregroundStyle(.orange)
            Text(verbatim: why)
                .multilineTextAlignment(.center)
        case let (_, .incompatible(why)):
            Image(systemName: "terminal")
                .font(.system(size: 36, weight: .light))
                .foregroundStyle(.secondary)
            Text("autochat is running in a terminal")
                .font(.title3.weight(.semibold))
            Text(verbatim: why)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 380)
        default:
            ProgressView()
            Text("Connecting to autochat…")
                .foregroundStyle(.secondary)
        }
    }
}
