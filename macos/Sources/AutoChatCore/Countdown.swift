import Foundation

// Pure presentation rules are deterministic given their inputs (including `now`), so they
// can be unit-tested.

public enum CountdownClock {
    /// Whole seconds left, rounded up, computed from `endsAt` so it never drifts.
    public static func remainingSeconds(until endsAt: Date, now: Date) -> Int {
        let left = endsAt.timeIntervalSince(now)
        guard left > 0 else { return 0 }
        return Int(left.rounded(.up))
    }

    /// The instant the displayed number next changes, or nil once it reached zero.
    public static func nextTick(endsAt: Date, now: Date) -> Date? {
        let remaining = remainingSeconds(until: endsAt, now: now)
        guard remaining > 0 else { return nil }
        return endsAt.addingTimeInterval(-Double(remaining - 1))
    }

    /// `23s`, or `1:05` past a minute.
    public static func format(_ seconds: Int) -> String {
        let s = max(0, seconds)
        if s < 60 { return "\(s)s" }
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    /// Fraction of the countdown still left, 0...1.
    public static func fractionLeft(endsAt: Date, total: Int?, now: Date) -> Double {
        let total = Double(max(1, total ?? 30))
        return min(1, max(0, endsAt.timeIntervalSince(now) / total))
    }

    public static func title(remaining: Int) -> String {
        remaining > 0 ? "Back to reality in \(format(remaining))" : "Back to reality now"
    }

    /// Lower-case, panel/strip sized explanation, e.g. "your copilot finished".
    public static func reasonPhrase(_ reason: String?) -> String {
        switch reason {
        case "complete": "your copilot finished"
        case "abort": "you interrupted your copilot"
        case "mode": "autopilot was switched off"
        case "idle": "your copilot is waiting for you"
        case "end": "your copilot session ended"
        case "failed": "your agent stopped on an error"
        default: "your autopilot run is over"
        }
    }
}

// MARK: - Status item

public enum StatusIconState: Sendable, Equatable {
    case disconnected
    case lounge
    case autopilot
    case needsYou
    case countdown(Int)

    public static func from(connected: Bool, snapshot: Snapshot?, countdown: Countdown?, now: Date) -> StatusIconState {
        guard connected, let snapshot else { return .disconnected }
        if let c = countdown {
            return .countdown(CountdownClock.remainingSeconds(until: c.endsAt, now: now))
        }
        // With an attention queue, the badge says who needs you (see AttentionRules.urgentCount).
        if snapshot.attention == nil, let r = snapshot.request, !r.resolved, snapshot.phase.isInRoom { return .needsYou }
        if snapshot.phase.isInRoom { return .autopilot }
        return .lounge
    }
}
