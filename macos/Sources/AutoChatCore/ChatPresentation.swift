import Foundation

/// View-model logic for the chat window: header copy and which controls are enabled.
public struct ChatPresentation: Sendable, Equatable {
    public var title: String
    public var subtitle: String
    public var myHandle: String?
    public var inputEnabled: Bool
    public var inputPlaceholder: String
    /// Join the Lounge: the toolbar says Leave Room while it's on, Join Room while it's off.
    public var loungeOn: Bool
    public var canToggleLounge: Bool
    public var canJumpToCopilot: Bool
    public var showsRoom: Bool

    public init(snapshot: Snapshot?, connected: Bool) {
        let room = snapshot?.room?.display ?? "AutoChat"
        title = room
        myHandle = snapshot?.me?.handle ?? snapshot?.members.first(where: { $0.isYou })?.handle
        let inRoom = connected && snapshot?.inRoom == true
        showsRoom = inRoom

        var bits: [String] = []
        if let snapshot, connected {
            if inRoom {
                bits.append("\(snapshot.members.count) here")
                if snapshot.isHost { bits.append("host: you") } else if let host = snapshot.hostHandle { bits.append("host \(host)") }
                if snapshot.room?.mates == 0 { bits.append("searching for peers…") }
            } else {
                bits.append("not in the lounge")
            }
        } else {
            bits.append("not connected")
        }
        subtitle = bits.joined(separator: " · ")

        inputEnabled = inRoom
        if !connected {
            inputPlaceholder = "Not connected to autochat"
        } else if inRoom {
            inputPlaceholder = "Message \(room)"
        } else {
            inputPlaceholder = "Join the lounge to chat"
        }
        loungeOn = snapshot?.isLoungeOn ?? false
        canToggleLounge = connected && snapshot != nil
        canJumpToCopilot = connected && snapshot?.request != nil
    }
}

/// "Stick to the bottom unless the user scrolled up", but always follow your own message.
public enum ScrollFollow {
    public static func shouldFollow(pinnedToBottom: Bool, newestIsMine: Bool) -> Bool {
        pinnedToBottom || newestIsMine
    }
}
