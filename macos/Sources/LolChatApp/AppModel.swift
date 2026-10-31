import Foundation
import LolChatCore
import Observation

/// Single source of UI state: the latest daemon snapshot plus local, time-driven state
/// (the ticking countdown, the autopilot notice). Shared by the status item, the
/// descending panel and the chat window.
@MainActor
@Observable
public final class AppModel {
    public private(set) var snapshot: Snapshot?
    public private(set) var connection: DaemonClient.State = .idle
    public private(set) var daemon: DaemonSupervisor.Status = .idle
    /// Re-published once per countdown second (and when other timed state expires).
    public private(set) var now: Date
    /// The live countdown, or the last one held at zero for a moment after it expired.
    public private(set) var countdown: Countdown?
    public private(set) var autopilotNoticeUntil: Date?
    public private(set) var dismissedRequestKey: String?
    public private(set) var lastError: String?
    public var chatWindow: ChatWindowState = .closed

    @ObservationIgnored public let client: DaemonClient?
    @ObservationIgnored public let supervisor: DaemonSupervisor?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var errorClear: DispatchWorkItem?
    @ObservationIgnored private let frozen: Bool

    /// Live model wired to a daemon client and supervisor.
    public init(client: DaemonClient, supervisor: DaemonSupervisor) {
        self.client = client
        self.supervisor = supervisor
        self.now = Date()
        self.frozen = false
        client.setHandlers(
            onSnapshot: { [weak self] s in MainActor.assumeIsolated { self?.apply(s) } },
            onState: { [weak self] s in MainActor.assumeIsolated { self?.connectionChanged(s) } }
        )
        supervisor.onStatus = { [weak self] s in self?.daemonChanged(s) }
    }

    /// Static model for snapshot rendering and tests: nothing ticks, actions are no-ops.
    public init(fixture: Snapshot?, now: Date, connection: DaemonClient.State = .connected, daemon: DaemonSupervisor.Status = .spawned(pid: 4242), chatWindow: ChatWindowState = .closed) {
        self.client = nil
        self.supervisor = nil
        self.frozen = true
        self.now = now
        self.connection = connection
        self.daemon = daemon
        self.chatWindow = chatWindow
        self.snapshot = fixture
        self.countdown = fixture?.countdown
        if fixture?.phase == .room { autopilotNoticeUntil = now.addingTimeInterval(PanelRules.autopilotNoticeDuration) }
    }

    public func start() {
        supervisor?.start()
        client?.start()
    }

    // MARK: Derived state

    public var connected: Bool { connection == .connected }

    /// A static model for snapshot rendering.
    public var isFixture: Bool { frozen }

    public var panelKind: PanelKind? {
        PanelRules.decide(PanelInputs(
            connected: connected, phase: snapshot?.phase ?? .lounge, countdown: countdown,
            request: snapshot?.request, dismissedRequestKey: dismissedRequestKey,
            autopilotNoticeUntil: autopilotNoticeUntil, chat: chatWindow, now: now
        ))
    }

    public var iconState: StatusIconState {
        StatusIconState.from(connected: connected, snapshot: snapshot, countdown: countdown, now: now)
    }

    public var countdownRemaining: Int? {
        countdown.map { CountdownClock.remainingSeconds(until: $0.endsAt, now: now) }
    }

    // MARK: Inputs

    func apply(_ incoming: Snapshot) {
        let next = incoming.alignedToLocalClock(receivedAt: Date())
        let previous = snapshot
        if previous?.phase != next.phase { DebugLog.log("phase \(String(describing: previous?.phase)) → \(next.phase)") }
        if (previous?.countdown == nil) != (next.countdown == nil) { DebugLog.log("countdown \(next.countdown.map { "ends in \(Int($0.endsAt.timeIntervalSinceNow.rounded()))s" } ?? "cleared")") }
        snapshot = next
        now = Date()
        if PanelRules.entersAutopilot(from: previous?.phase, to: next.phase) {
            autopilotNoticeUntil = now.addingTimeInterval(PanelRules.autopilotNoticeDuration)
        }
        if next.phase != .room { autopilotNoticeUntil = nil }
        if let c = next.countdown {
            countdown = c
        } else if let c = countdown, previous?.countdown != nil {
            // Expired (or "Return now"): hold "0s" briefly so the panel visibly hits zero.
            // Cancelled because autopilot resumed: drop it at once.
            let expired = next.phase.isCloseout || c.endsAt.timeIntervalSince(now) <= 1
            countdown = expired ? Countdown(endsAt: min(c.endsAt, now), total: c.total, reason: c.reason, summary: c.summary, cwd: c.cwd) : nil
        }
        reschedule()
    }

    func connectionChanged(_ state: DaemonClient.State) {
        DebugLog.log("connection \(state)")
        connection = state
        switch state {
        case .disconnected, .incompatible: supervisor?.connectionLost()
        default: break
        }
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
                if !reply.ok { report(reply.error ?? "lolchat refused \(command.name)") }
            } catch {
                report(error.localizedDescription)
            }
        }
    }

    public func dismissAutopilotNotice() {
        autopilotNoticeUntil = nil
    }

    /// Hides the request panel for this question without dismissing it in the core.
    public func dismissRequestPanel() {
        dismissedRequestKey = snapshot?.request?.key
    }

    private func report(_ message: String) {
        lastError = message
        errorClear?.cancel()
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.lastError = nil } }
        errorClear = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
    }

    // MARK: Clock

    /// One-shot timer for the next instant something visible changes, so the countdown
    /// updates exactly on its second boundaries (derived from `endsAt`, never decremented).
    private func reschedule() {
        timer?.invalidate()
        timer = nil
        guard !frozen else { return }
        let current = Date()
        var wakes: [Date] = []
        if let c = countdown {
            if let next = CountdownClock.nextTick(endsAt: c.endsAt, now: current) { wakes.append(next) }
            wakes.append(c.endsAt.addingTimeInterval(PanelRules.zeroHold))
        }
        if let until = autopilotNoticeUntil { wakes.append(until) }
        guard let next = wakes.filter({ $0 > current }).min() else { return }
        let t = Timer(fire: next.addingTimeInterval(0.004), interval: 0, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func tick() {
        now = Date()
        if let c = countdown, snapshot?.countdown != c, now >= c.endsAt.addingTimeInterval(PanelRules.zeroHold) {
            countdown = nil
        }
        if let until = autopilotNoticeUntil, now >= until { autopilotNoticeUntil = nil }
        reschedule()
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
