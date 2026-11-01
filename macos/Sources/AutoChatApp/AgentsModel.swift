import Foundation
import AutoChatCore
import Observation

/// State of the Agents tab: the latest `agents` snapshot from an agents-stream subscription
/// (issue #21), the selected stream, the draft, and the intervention gate. `AppModel` decides
/// when the subscription runs: while the daemon hosts an agent room and the chat window is open.
@MainActor
@Observable
public final class AgentsModel {
    public private(set) var snapshot: AgentsSnapshot?
    public private(set) var connection: DaemonClient.State = .idle
    public private(set) var selection: AgentStream = .main
    public private(set) var gate = InterventionGate()
    /// Cards (by id) whose child sessions are folded away on the board.
    public private(set) var collapsedChildren: Set<String> = []
    public var draft: String = "" {
        didSet { if draft.count > AgentsRules.maxSayLength { draft = String(draft.prefix(AgentsRules.maxSayLength)) } }
    }
    public private(set) var lastError: String?
    /// Why the acknowledgement didn't go through (shown in the sheet).
    public private(set) var ackError: String?
    public private(set) var sending = false
    public private(set) var acknowledging = false

    @ObservationIgnored private let socketPath: String?
    @ObservationIgnored private let sendOverride: (@MainActor (Command) async throws -> Reply)?
    @ObservationIgnored private let frozen: Bool
    @ObservationIgnored private var client: DaemonClient?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var stopWork: DispatchWorkItem?
    @ObservationIgnored private var errorClear: DispatchWorkItem?
    /// When the latest snapshot arrived: its `now` ticks on from there.
    @ObservationIgnored private var receivedAt: Date?

    /// How long the subscription outlives the window, so a quick hide/show doesn't resubscribe.
    static let idleGrace: TimeInterval = 15

    /// Live: subscribes to the agents stream on `socketPath` while active.
    public init(socketPath: String) {
        self.socketPath = socketPath
        self.sendOverride = nil
        self.frozen = false
    }

    /// Tests: commands go to `send`, and snapshots come from `apply`.
    init(send: @escaping @MainActor (Command) async throws -> Reply) {
        self.socketPath = nil
        self.sendOverride = send
        self.frozen = false
        self.connection = .connected
    }

    deinit {
        client?.stop()
    }

    /// Static model for snapshot rendering: nothing connects, actions are no-ops.
    public init(fixture: AgentsSnapshot?, selection: AgentStream = .main, intervening: Bool = false, draft: String = "") {
        self.socketPath = nil
        self.sendOverride = nil
        self.frozen = true
        self.snapshot = fixture
        self.connection = fixture == nil ? .connecting : .connected
        self.selection = selection
        self.draft = draft
        gate.update(daemonAck: fixture?.ack ?? false)
        if intervening { gate.requestIntervene() }
    }

    // MARK: Derived state

    /// The selected stream, or main once the selected thread is gone.
    public var stream: AgentStream { AgentsRules.resolve(selection, in: snapshot) }
    public var messages: [AgentMessage] { AgentsRules.messages(in: stream, of: snapshot) }
    public var selectedThread: AgentThread? { snapshot?.thread(stream.threadID) }
    /// The selected stream is a resolved thread, which takes no more messages.
    public var streamIsClosed: Bool { !AgentsRules.acceptsInterventions(stream, in: snapshot) }
    public var isFixture: Bool { frozen }
    /// The board: cards with their child sessions nested under them.
    public var boardRows: [AgentBoardRow] { AgentsRules.boardRows(snapshot?.agents ?? [], collapsed: collapsedChildren) }

    /// The daemon's clock at local time `date`, for "left 4 min ago": the snapshot's `now`
    /// moved on by the time since it arrived (the local clock if it has none). A fixture's
    /// stays at its `now`.
    public func daemonNow(at date: Date = Date()) -> Date? {
        guard let now = snapshot?.now else { return frozen ? nil : date }
        guard !frozen, let receivedAt else { return now }
        return now.addingTimeInterval(date.timeIntervalSince(receivedAt))
    }

    // MARK: Subscription

    /// Keeps the agents stream subscribed while `active`, and stops it a little after it isn't.
    func setActive(_ active: Bool) {
        guard !frozen, socketPath != nil else { return }
        if active {
            stopWork?.cancel()
            stopWork = nil
            if client == nil { startClient() }
        } else if client != nil, stopWork == nil {
            let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.stopClient() } }
            stopWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.idleGrace, execute: work)
        }
    }

    var isSubscribed: Bool { client != nil }

    private func startClient() {
        guard let socketPath else { return }
        generation += 1
        let current = generation
        let c = DaemonClient(socketPath: socketPath, stream: .agents)
        c.setAgentsHandlers(
            onAgents: { [weak self] s in MainActor.assumeIsolated { self?.received(s, generation: current) } },
            onState: { [weak self] s in MainActor.assumeIsolated { self?.connectionChanged(s, generation: current) } }
        )
        client = c
        DebugLog.log("agents: subscribing")
        c.start()
    }

    private func stopClient() {
        stopWork = nil
        guard let c = client else { return }
        DebugLog.log("agents: unsubscribing")
        generation += 1
        client = nil
        c.stop()
        connection = .idle
    }

    private func received(_ s: AgentsSnapshot, generation g: Int) {
        guard g == generation else { return }
        apply(s)
    }

    private func connectionChanged(_ s: DaemonClient.State, generation g: Int) {
        guard g == generation else { return }
        DebugLog.log("agents: connection \(s)")
        connection = s
    }

    func apply(_ s: AgentsSnapshot, receivedAt: Date = Date()) {
        snapshot = s
        self.receivedAt = receivedAt
        gate.update(daemonAck: s.ack)
        if selection != .main, AgentsRules.resolve(selection, in: s) == .main { selection = .main }
    }

    // MARK: Actions

    public func select(_ stream: AgentStream) {
        selection = AgentsRules.resolve(stream, in: snapshot)
        lastError = nil
    }

    /// The disclosure under a parent card: show or hide its child sessions.
    public func toggleChildren(of cardID: String) {
        if collapsedChildren.remove(cardID) == nil { collapsedChildren.insert(cardID) }
    }

    /// Intervene…: the one-time warning sheet, or straight to the input once acknowledged.
    public func intervene() {
        ackError = nil
        gate.requestIntervene()
    }

    public func cancelAck() {
        ackError = nil
        gate.dismissSheet()
    }

    public func stopIntervening() {
        gate.stopIntervening()
        lastError = nil
    }

    /// The sheet's Intervene button: `agents.ack`, then the input appears.
    public func confirmAck() async {
        guard !frozen, gate.sheetShown, !acknowledging else { return }
        acknowledging = true
        defer { acknowledging = false }
        do {
            let reply = try await send(.agentsAck)
            if reply.ok {
                ackError = nil
                gate.ackConfirmed()
            } else {
                ackError = reply.error ?? "autochat didn't accept the acknowledgement"
            }
        } catch {
            ackError = error.localizedDescription
        }
    }

    /// ⏎ in the intervention input: `agents.say` to the selected stream. Only possible once
    /// acknowledged; `ack-required` hides the input and brings the sheet back.
    public func submit() async {
        guard !frozen, gate.inputVisible, !streamIsClosed, !sending, let text = AgentsRules.sayText(draft) else { return }
        let thread = stream.threadID
        sending = true
        defer { sending = false }
        do {
            let reply = try await send(.agentsSay(text: text, thread: thread, to: []))
            if reply.ok {
                if AgentsRules.sayText(draft) == text { draft = "" }
                lastError = nil
            } else if reply.error == AgentsRules.ackRequired {
                lastError = nil
                gate.ackRequired()
            } else {
                report(reply.error ?? "couldn't send")
            }
        } catch {
            report(error.localizedDescription)
        }
    }

    private func send(_ command: Command) async throws -> Reply {
        if let sendOverride { return try await sendOverride(command) }
        guard let client else { throw CommandError.notConnected }
        return try await client.send(command)
    }

    private func report(_ message: String) {
        lastError = message
        errorClear?.cancel()
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.lastError = nil } }
        errorClear = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: work)
    }
}
