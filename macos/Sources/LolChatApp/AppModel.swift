import Foundation
import LolChatCore
import Observation

/// Single source of UI state: the latest daemon snapshot plus a clock that ticks on the
/// countdown's second boundaries.
@MainActor
@Observable
public final class AppModel {
    public private(set) var snapshot: Snapshot?
    public private(set) var connection: DaemonClient.State = .idle
    public private(set) var daemon: DaemonSupervisor.Status = .idle
    /// Re-published once per countdown second.
    public private(set) var now: Date
    public private(set) var countdown: Countdown?
    public private(set) var lastError: String?

    @ObservationIgnored public let client: DaemonClient?
    @ObservationIgnored public let supervisor: DaemonSupervisor?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var errorClear: DispatchWorkItem?

    /// Live model wired to a daemon client and supervisor.
    public init(client: DaemonClient, supervisor: DaemonSupervisor) {
        self.client = client
        self.supervisor = supervisor
        self.now = Date()
        client.setHandlers(
            onSnapshot: { [weak self] s in MainActor.assumeIsolated { self?.apply(s) } },
            onState: { [weak self] s in MainActor.assumeIsolated { self?.connectionChanged(s) } }
        )
        supervisor.onStatus = { [weak self] s in self?.daemonChanged(s) }
    }

    public func start() {
        supervisor?.start()
        client?.start()
    }

    // MARK: Derived state

    public var connected: Bool { connection == .connected }

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
        countdown = next.countdown
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

    private func report(_ message: String) {
        lastError = message
        errorClear?.cancel()
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.lastError = nil } }
        errorClear = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
    }

    // MARK: Clock

    /// One-shot timer for the next instant the countdown's displayed second changes
    /// (derived from `endsAt`, never decremented, so it can't drift).
    private func reschedule() {
        timer?.invalidate()
        timer = nil
        let current = Date()
        guard let c = countdown, let next = CountdownClock.nextTick(endsAt: c.endsAt, now: current) else { return }
        let t = Timer(fire: next.addingTimeInterval(0.004), interval: 0, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func tick() {
        now = Date()
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
