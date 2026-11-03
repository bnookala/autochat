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

// MARK: - Status item

/// The menu bar icon. The attention badge (agents blocked on you) goes on top of any of these.
public enum StatusIconState: Sendable, Equatable {
    case disconnected
    /// In the lounge's room.
    case inLounge
    /// Connected, not in the lounge (Join the Lounge is off).
    case outOfLounge

    public static func from(connected: Bool, snapshot: Snapshot?) -> StatusIconState {
        guard connected, let snapshot else { return .disconnected }
        return snapshot.inRoom ? .inLounge : .outOfLounge
    }
}

// MARK: - Descending panel

public struct PanelInputs: Sendable, Equatable {
    public var connected: Bool
    public var chat: ChatWindowState
    /// The chat window shows the Lounge tab (not Agents).
    public var chatShowsLounge: Bool
    /// The snapshot's queue; nil from a daemon without one.
    public var attention: [AttentionItem]?
    /// Blocked items the user has already seen (in the chat, or by jumping to them).
    public var seenAttention: Set<String>

    public init(connected: Bool, chat: ChatWindowState, chatShowsLounge: Bool = true, attention: [AttentionItem]? = nil, seenAttention: Set<String> = []) {
        self.connected = connected
        self.chat = chat
        self.chatShowsLounge = chatShowsLounge
        self.attention = attention
        self.seenAttention = seenAttention
    }
}

public enum PanelRules {
    /// Whether the panel hangs under the status item: it lists the attention queue while an agent
    /// is blocked on you and you haven't seen it yet. Finished and failed agents never bring it
    /// down by themselves. Nothing shows while the chat is in front on its Lounge tab (the Agents
    /// tab doesn't show the queue). The agent room never gets a panel.
    public static func showsPanel(_ i: PanelInputs) -> Bool {
        guard i.connected, !(chatWindowIsVisibleAndKey(i.chat) && i.chatShowsLounge) else { return false }
        return (i.attention ?? []).contains { $0.kind.isUrgent && !i.seenAttention.contains($0.id) }
    }
}
