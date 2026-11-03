import Foundation
import Testing
@testable import AutoChatCore

private let t0 = Date(timeIntervalSince1970: 1_730_400_000)

@Suite("Chat presentation")
struct ChatPresentationTests {
    @Test func theRoomEnablesInputAndLeaveRoom() {
        let p = ChatPresentation(snapshot: Fixtures.room(now: t0), connected: true)
        #expect(p.title == "#lobby")
        #expect(p.subtitle == "4 here · host jade-lynx-0c")
        #expect(p.myHandle == "stormy-newt-59")
        #expect(p.showsRoom)
        #expect(p.inputEnabled)
        #expect(p.inputPlaceholder == "Message #lobby")
        #expect(p.loungeOn && p.canToggleLounge, "the toolbar says Leave Room")
        #expect(!p.canJumpToCopilot)
    }

    @Test func requestEnablesJump() {
        let p = ChatPresentation(snapshot: Fixtures.request(now: t0), connected: true)
        #expect(p.canJumpToCopilot)
        #expect(p.inputEnabled)
    }

    @Test func loungeOffOffersJoinRoomAndDisablesInput() {
        let p = ChatPresentation(snapshot: Fixtures.lounge(), connected: true)
        #expect(p.title == "#lobby")
        #expect(p.subtitle == "not in the lounge")
        #expect(!p.showsRoom)
        #expect(!p.inputEnabled)
        #expect(p.inputPlaceholder == "Join the lounge to chat")
        #expect(!p.loungeOn && p.canToggleLounge, "the toolbar says Join Room")
    }

    @Test func hostSeesHostYou() {
        var s = Fixtures.room(now: t0)
        s.room?.isHost = true
        #expect(ChatPresentation(snapshot: s, connected: true).subtitle == "4 here · host: you")
    }

    @Test func aloneSaysSo() {
        var s = Fixtures.room(now: t0)
        s.room?.isHost = true
        s.room?.mates = 0
        s.members = [Member(handle: "stormy-newt-59", status: .active, isHost: true, isYou: true)]
        #expect(ChatPresentation(snapshot: s, connected: true).subtitle == "1 here · host: you · searching for peers…")
    }

    @Test func disconnectedDisablesEverything() {
        let p = ChatPresentation(snapshot: Fixtures.room(now: t0), connected: false)
        #expect(!p.showsRoom)
        #expect(!p.inputEnabled)
        #expect(!p.canToggleLounge)
        #expect(!p.canJumpToCopilot)
        #expect(p.subtitle == "not connected")
        #expect(p.inputPlaceholder == "Not connected to autochat")
    }

    @Test func scrollFollowing() {
        #expect(ScrollFollow.shouldFollow(pinnedToBottom: true, newestIsMine: false))
        #expect(ScrollFollow.shouldFollow(pinnedToBottom: false, newestIsMine: true))
        #expect(!ScrollFollow.shouldFollow(pinnedToBottom: false, newestIsMine: false))
    }
}
