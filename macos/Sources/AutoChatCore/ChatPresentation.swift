import Foundation

public struct Closeout: Sendable, Equatable {
    public var symbol: String
    public var title: String
    public var body: String
    public var cwd: String?
    public var summary: String?

    public init(banner: Banner) {
        switch banner.kind {
        case .dead:
            symbol = "moon.zzz.fill"
            title = "The room died"
            body = "Everyone got pulled back to reality. Nothing was saved. It never happened."
        case .left:
            symbol = "door.left.hand.open"
            title = "You left the room"
            body = "You won't be pulled back in for the rest of this autopilot run."
        case .reality, .unknown:
            symbol = "sunrise.fill"
            title = "Back to reality"
            switch banner.reason {
            case "complete": body = "Your copilot finished its autopilot run."
            case "abort": body = "You interrupted your copilot."
            case "mode": body = "Autopilot was switched off."
            case "idle": body = "Your copilot stopped and is waiting for you."
            case "end": body = "Your copilot session ended."
            default: body = "Your autopilot run is over."
            }
        }
        cwd = banner.cwd.flatMap { $0.isEmpty ? nil : $0 }
        summary = banner.summary.flatMap { $0.isEmpty ? nil : PlainText.clean($0, keepNewlines: true) }
    }
}

/// View-model logic for the chat window: header copy and which controls are enabled.
public struct ChatPresentation: Sendable, Equatable {
    public var title: String
    public var subtitle: String
    public var myHandle: String?
    public var inputEnabled: Bool
    public var inputPlaceholder: String
    public var canLeave: Bool
    public var canJoinNow: Bool
    public var canReturnNow: Bool
    public var canJumpToCopilot: Bool
    public var showsRoom: Bool
    public var countdownRemaining: Int?
    public var closeout: Closeout?

    public init(snapshot: Snapshot?, connected: Bool, countdown: Countdown?, now: Date) {
        let phase = snapshot?.phase ?? .lounge
        let room = snapshot?.room?.display ?? "AutoChat"
        title = room
        myHandle = snapshot?.me?.handle ?? snapshot?.members.first(where: { $0.isYou })?.handle
        showsRoom = connected && phase.isInRoom

        var bits: [String] = []
        if let snapshot, connected {
            switch phase {
            case .room, .spectating:
                if phase == .spectating { bits.append("spectating") }
                bits.append("\(snapshot.activeCount) on autopilot")
                if snapshot.isHost { bits.append("host: you") } else if let host = snapshot.hostHandle { bits.append("host \(host)") }
                if snapshot.room?.mates == 0 { bits.append("searching for peers…") }
            case .lounge:
                bits.append("waiting for autopilot")
            case .reality, .dead, .left, .unknown:
                bits.append("autopilot is over")
            }
        } else {
            bits.append("not connected")
        }
        subtitle = bits.joined(separator: " · ")

        let inRoom = connected && phase == .room
        inputEnabled = inRoom
        if !connected {
            inputPlaceholder = "Not connected to autochat"
        } else {
            switch phase {
            case .room: inputPlaceholder = "Message \(room)"
            case .spectating: inputPlaceholder = "You're spectating. Chat reopens when you're back on autopilot"
            case .lounge: inputPlaceholder = "Chat opens when a Copilot session goes on autopilot"
            default: inputPlaceholder = "Autopilot is over"
            }
        }
        canLeave = connected && phase.isInRoom
        canJoinNow = connected && phase == .lounge
        canReturnNow = connected && countdown != nil
        canJumpToCopilot = connected && snapshot?.request != nil
        countdownRemaining = countdown.map { CountdownClock.remainingSeconds(until: $0.endsAt, now: now) }
        if connected, phase.isCloseout, let banner = snapshot?.banner {
            closeout = Closeout(banner: banner)
        } else {
            closeout = nil
        }
    }
}

/// "Stick to the bottom unless the user scrolled up", but always follow your own message.
public enum ScrollFollow {
    public static func shouldFollow(pinnedToBottom: Bool, newestIsMine: Bool) -> Bool {
        pinnedToBottom || newestIsMine
    }
}
