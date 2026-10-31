import Foundation
import Testing
@testable import LolChatCore

private let t0 = Date(timeIntervalSince1970: 1_730_400_000)

@Suite("Chat presentation")
struct ChatPresentationTests {
    @Test func roomEnablesInputAndLeave() {
        let p = ChatPresentation(snapshot: Fixtures.room(now: t0), connected: true, countdown: nil, now: t0)
        #expect(p.title == "#lobby")
        #expect(p.subtitle == "3 on autopilot · host jade-lynx-0c")
        #expect(p.myHandle == "stormy-newt-59")
        #expect(p.inputEnabled)
        #expect(p.inputPlaceholder == "Message #lobby")
        #expect(p.canLeave)
        #expect(!p.canJoinNow)
        #expect(!p.canReturnNow)
        #expect(p.countdownRemaining == nil)
        #expect(p.closeout == nil)
    }

    @Test func countdownNeverDisablesInput() {
        let s = Fixtures.countdown(now: t0)
        let p = ChatPresentation(snapshot: s, connected: true, countdown: s.countdown, now: t0)
        #expect(p.inputEnabled)
        #expect(p.canReturnNow)
        #expect(p.canLeave)
        #expect(p.countdownRemaining == 23)
    }

    @Test func requestEnablesJump() {
        let p = ChatPresentation(snapshot: Fixtures.request(now: t0), connected: true, countdown: nil, now: t0)
        #expect(p.canJumpToCopilot)
        #expect(p.inputEnabled)
    }

    @Test func loungeOffersJoinNowAndDisablesInput() {
        let p = ChatPresentation(snapshot: Fixtures.lounge(), connected: true, countdown: nil, now: t0)
        #expect(!p.inputEnabled)
        #expect(p.canJoinNow)
        #expect(!p.canLeave)
        #expect(p.inputPlaceholder.contains("autopilot"))
    }

    @Test func spectatingDisablesInputButAllowsLeave() {
        var s = Fixtures.room(now: t0)
        s.phase = .spectating
        let p = ChatPresentation(snapshot: s, connected: true, countdown: nil, now: t0)
        #expect(!p.inputEnabled)
        #expect(p.canLeave)
        #expect(p.subtitle.hasPrefix("spectating · "))
    }

    @Test func hostSeesHostYou() {
        var s = Fixtures.room(now: t0)
        s.room?.isHost = true
        #expect(ChatPresentation(snapshot: s, connected: true, countdown: nil, now: t0).subtitle == "3 on autopilot · host: you")
    }

    @Test func closeoutBanners() {
        let reality = ChatPresentation(snapshot: Fixtures.reality(now: t0), connected: true, countdown: nil, now: t0)
        #expect(!reality.inputEnabled)
        #expect(!reality.canLeave)
        #expect(reality.closeout?.title == "Back to reality")
        #expect(reality.closeout?.body == "Your copilot finished its autopilot run.")
        #expect(reality.closeout?.summary == Fixtures.summary)
        #expect(reality.closeout?.cwd == "~/code/api-server")

        var dead = Fixtures.reality(now: t0)
        dead.phase = .dead
        dead.banner = Banner(kind: .dead)
        #expect(ChatPresentation(snapshot: dead, connected: true, countdown: nil, now: t0).closeout?.title == "The room died")

        var left = dead
        left.phase = .left
        left.banner = Banner(kind: .left)
        #expect(ChatPresentation(snapshot: left, connected: true, countdown: nil, now: t0).closeout?.body == "You won't be pulled back in for the rest of this autopilot run.")
    }

    @Test func disconnectedDisablesEverything() {
        let p = ChatPresentation(snapshot: Fixtures.room(now: t0), connected: false, countdown: nil, now: t0)
        #expect(!p.inputEnabled)
        #expect(!p.canLeave)
        #expect(!p.canJoinNow)
        #expect(p.subtitle == "not connected")
    }

    @Test func scrollFollowing() {
        #expect(ScrollFollow.shouldFollow(pinnedToBottom: true, newestIsMine: false))
        #expect(ScrollFollow.shouldFollow(pinnedToBottom: false, newestIsMine: true))
        #expect(!ScrollFollow.shouldFollow(pinnedToBottom: false, newestIsMine: false))
    }
}
