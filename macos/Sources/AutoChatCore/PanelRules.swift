import Foundation

// MARK: - The panel/window hand-off rule

/// What AppKit tells us about the chat window.
public struct ChatWindowState: Sendable, Equatable {
    public var isVisible: Bool
    public var isMiniaturized: Bool
    public var isKey: Bool
    public var appIsActive: Bool
    /// Fully covered by other windows, or on another Space.
    public var isOccluded: Bool

    public init(isVisible: Bool, isMiniaturized: Bool = false, isKey: Bool, appIsActive: Bool, isOccluded: Bool = false) {
        self.isVisible = isVisible
        self.isMiniaturized = isMiniaturized
        self.isKey = isKey
        self.appIsActive = appIsActive
        self.isOccluded = isOccluded
    }

    public static let closed = ChatWindowState(isVisible: false, isKey: false, appIsActive: false)
}

/// The chat window counts as "in front" only when it is visible **and** key: open, not
/// minimized, not occluded or on another Space, and the app is active. Otherwise the
/// descending panel takes over.
public func chatWindowIsVisibleAndKey(_ s: ChatWindowState) -> Bool {
    s.isVisible && !s.isMiniaturized && !s.isOccluded && s.isKey && s.appIsActive
}

// MARK: - Descending panel

public enum PanelKind: Sendable, Equatable {
    case autopilot
    case countdown
    case request
}

public struct PanelInputs: Sendable, Equatable {
    public var connected: Bool
    public var phase: Phase
    public var countdown: Countdown?
    public var request: CopilotRequest?
    public var dismissedRequestKey: String?
    public var autopilotNoticeUntil: Date?
    public var chat: ChatWindowState
    /// The chat window shows the Lounge tab (not Agents).
    public var chatShowsLounge: Bool
    public var now: Date

    public init(
        connected: Bool, phase: Phase, countdown: Countdown? = nil, request: CopilotRequest? = nil,
        dismissedRequestKey: String? = nil, autopilotNoticeUntil: Date? = nil, chat: ChatWindowState,
        chatShowsLounge: Bool = true, now: Date
    ) {
        self.connected = connected
        self.phase = phase
        self.countdown = countdown
        self.request = request
        self.dismissedRequestKey = dismissedRequestKey
        self.autopilotNoticeUntil = autopilotNoticeUntil
        self.chat = chat
        self.chatShowsLounge = chatShowsLounge
        self.now = now
    }
}

public enum PanelRules {
    /// How long "0s" stays up before the countdown panel dismisses.
    public static let zeroHold: TimeInterval = 1.5
    /// How long the "Autopilot is on" notice stays up.
    public static let autopilotNoticeDuration: TimeInterval = 6

    /// Which panel (if any) should hang under the status item. Countdown beats a Copilot
    /// request, which beats the autopilot notice. Nothing shows while the chat is in front on
    /// its Lounge tab (the Agents tab doesn't show any of this). Agents never get a panel.
    public static func decide(_ i: PanelInputs) -> PanelKind? {
        guard i.connected, !(chatWindowIsVisibleAndKey(i.chat) && i.chatShowsLounge) else { return nil }
        if let c = i.countdown, i.now < c.endsAt.addingTimeInterval(zeroHold) {
            return .countdown
        }
        if let r = i.request, !r.resolved, r.key != i.dismissedRequestKey, i.phase.isInRoom {
            return .request
        }
        if let until = i.autopilotNoticeUntil, i.now < until, i.phase == .room {
            return .autopilot
        }
        return nil
    }

    /// The notice fires when we *enter* autopilot (phase → room), not on every snapshot.
    public static func entersAutopilot(from old: Phase?, to new: Phase) -> Bool {
        new == .room && old != .room && old != .spectating
    }
}
