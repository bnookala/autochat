import Foundation
import AutoChatCore
import Observation

/// Single source of UI state: the latest daemon snapshot, shared by the status item, the
/// descending panel and the chat window. The Agents tab's state lives in `agents`; the
/// attention queue comes with the snapshot.
@MainActor
@Observable
public final class AppModel {
    public private(set) var snapshot: Snapshot?
    public private(set) var connection: DaemonClient.State = .idle
    public private(set) var daemon: DaemonSupervisor.Status = .idle
    public private(set) var lastError: String?
    public var chatWindow: ChatWindowState = .closed {
        didSet {
            guard chatWindow != oldValue else { return }
            updateAgentsSubscription()
            markAttentionSeenInChat()
        }
    }
    /// Blocked items already seen (in the chat, or by jumping to them): they don't bring the
    /// panel down again. They stay in the queue (and the badge) until the agent carries on.
    public private(set) var seenAttention: Set<String> = []
    /// The chat's attention strip shows the whole queue rather than its first item.
    public var attentionExpanded = false
    /// The tab the user picked; `effectiveTab` is what the window shows.
    public private(set) var chatTab: ChatTab = .lounge {
        didSet { markAttentionSeenInChat() }
    }
    public let agents: AgentsModel
    public var draft: String = "" {
        didSet { if draft.count > 500 { draft = String(draft.prefix(500)) } }
    }

    @ObservationIgnored public let client: DaemonClient?
    @ObservationIgnored public let supervisor: DaemonSupervisor?
    @ObservationIgnored private var errorClear: DispatchWorkItem?
    @ObservationIgnored private let frozen: Bool

    /// Live model wired to a daemon client and supervisor.
    public init(client: DaemonClient, supervisor: DaemonSupervisor, agents: AgentsModel? = nil) {
        self.client = client
        self.supervisor = supervisor
        self.agents = agents ?? AgentsModel(socketPath: client.socketPath)
        self.frozen = false
        client.setHandlers(
            onSnapshot: { [weak self] s in MainActor.assumeIsolated { self?.apply(s) } },
            onState: { [weak self] s in MainActor.assumeIsolated { self?.connectionChanged(s) } }
        )
        supervisor.onStatus = { [weak self] s in self?.daemonChanged(s) }
    }

    /// Static model for snapshot rendering and tests: actions are no-ops.
    public init(
        fixture: Snapshot?, connection: DaemonClient.State = .connected, daemon: DaemonSupervisor.Status = .spawned(pid: 4242),
        chatWindow: ChatWindowState = .closed, draft: String = "", agents: AgentsModel? = nil, tab: ChatTab = .lounge
    ) {
        self.client = nil
        self.supervisor = nil
        self.agents = agents ?? AgentsModel(fixture: nil)
        self.chatTab = tab
        self.frozen = true
        self.connection = connection
        self.daemon = daemon
        self.chatWindow = chatWindow
        self.draft = draft
        self.snapshot = fixture
    }

    public func start() {
        supervisor?.start()
        client?.start()
    }

    // MARK: Derived state

    public var connected: Bool { connection == .connected }

    /// The daemon hosts an agent room (the lounge snapshot reports `agents`).
    public var showsAgentsTab: Bool { AgentsRules.showsTab(connected: connected, lounge: snapshot) }

    public var effectiveTab: ChatTab { AgentsRules.effectiveTab(chatTab, showsAgents: showsAgentsTab) }

    /// A static model for snapshot rendering.
    public var isFixture: Bool { frozen }

    public var presentation: ChatPresentation {
        ChatPresentation(snapshot: snapshot, connected: connected)
    }

    /// The descending panel: the attention queue, while an agent you haven't seen yet is blocked on you.
    public var showsPanel: Bool {
        PanelRules.showsPanel(PanelInputs(
            connected: connected, chat: chatWindow, chatShowsLounge: effectiveTab == .lounge,
            attention: snapshot?.attention, seenAttention: seenAttention
        ))
    }

    public var iconState: StatusIconState {
        StatusIconState.from(connected: connected, snapshot: snapshot)
    }

    /// Join the Lounge, as the menu's checkmark shows it.
    public var loungeOn: Bool {
        connected && snapshot?.isLoungeOn == true
    }

    /// The attention queue, urgent first.
    public var attention: [AttentionItem] {
        connected ? AttentionRules.sorted(snapshot?.attention ?? []) : []
    }

    /// The menu bar badge: agents blocked on you.
    public var badgeCount: Int {
        connected ? AttentionRules.urgentCount(snapshot?.attention) : 0
    }

    // MARK: Inputs

    func apply(_ next: Snapshot) {
        let previous = snapshot
        if previous?.phase != next.phase { DebugLog.log("phase \(String(describing: previous?.phase)) → \(next.phase)") }
        snapshot = next
        if (previous?.agents == nil) != (next.agents == nil) { DebugLog.log("agent room \(next.agents == nil ? "gone" : "available")") }
        if previous?.attention != next.attention { DebugLog.log("attention: \(AttentionRules.counts(next.attention ?? []))") }
        seenAttention.formIntersection((next.attention ?? []).map(\.id))
        if (next.attention ?? []).count < 2 { attentionExpanded = false }
        updateAgentsSubscription()
        markAttentionSeenInChat()
    }

    func connectionChanged(_ state: DaemonClient.State) {
        DebugLog.log("connection \(state)")
        connection = state
        switch state {
        case .disconnected, .incompatible: supervisor?.connectionLost()
        default: break
        }
        updateAgentsSubscription()
    }

    /// The agents stream is only subscribed while there's a room to show and the window is open.
    private func updateAgentsSubscription() {
        guard !frozen else { return }
        agents.setActive(showsAgentsTab && chatWindow.isVisible)
    }

    private func daemonChanged(_ status: DaemonSupervisor.Status) {
        DebugLog.log("daemon \(status)")
        daemon = status
        if case .spawned = status { client?.reconnectNow() }
    }

    // MARK: Actions

    public func perform(_ command: Command) {
        guard let client else { return }
        Task {
            do {
                let reply = try await client.send(command)
                if !reply.ok { report(reply.error ?? "autochat refused \(command.name)") }
            } catch {
                report(error.localizedDescription)
            }
        }
    }

    /// ⏎ in the chat input: send the draft, or jump to Copilot on an empty line when it asks.
    public func submitDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            if snapshot?.request != nil { perform(.jumpToCopilot) }
            return
        }
        guard let client, presentation.inputEnabled else { return }
        Task {
            do {
                let reply = try await client.send(.say(text))
                if reply.ok {
                    if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
                } else {
                    report(reply.error ?? "couldn't send")
                }
            } catch {
                report(error.localizedDescription)
            }
        }
    }

    /// Join the Lounge (the menu), or Join Room / Leave Room (the chat window).
    public func setLounge(_ on: Bool) {
        perform(.lounge(on))
    }

    /// Jump to: focus that agent's terminal. A blocked agent stays in the queue until it carries
    /// on, but the panel won't come down for it again.
    public func jump(to item: AttentionItem) {
        if item.kind.isUrgent { seenAttention.insert(item.id) }
        perform(.jumpTo(item.id))
    }

    public func dismiss(_ item: AttentionItem) {
        seenAttention.insert(item.id)
        perform(.dismissAttention(item.id))
    }

    /// What the chat shows in front of you counts as seen: the panel doesn't nag about it later.
    private func markAttentionSeenInChat() {
        guard chatWindowIsVisibleAndKey(chatWindow), effectiveTab == .lounge, let items = snapshot?.attention else { return }
        let urgent = items.filter(\.kind.isUrgent).map(\.id)
        if !seenAttention.isSuperset(of: urgent) { seenAttention.formUnion(urgent) }
    }

    public func selectTab(_ tab: ChatTab) {
        guard chatTab != tab else { return }
        chatTab = tab
        DebugLog.log("tab \(tab)")
    }

    /// Open Chat: the lounge when a Copilot question waits there, otherwise the last tab.
    public func selectTabForOpening() {
        selectTab(AgentsRules.tabOnOpen(current: chatTab, lounge: snapshot))
    }

    private func report(_ message: String) {
        lastError = message
        errorClear?.cancel()
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.lastError = nil } }
        errorClear = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
    }
}

/// Re-runs `body` whenever any observable state it read changes (AppKit glue for @Observable).
@MainActor
func observeChanges(_ body: @escaping @MainActor () -> Void) {
    withObservationTracking {
        body()
    } onChange: {
        Task { @MainActor in observeChanges(body) }
    }
}
