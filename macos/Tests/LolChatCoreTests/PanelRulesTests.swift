import Foundation
import Testing
@testable import LolChatCore

private let t0 = Date(timeIntervalSince1970: 1_730_400_000)

@Suite("Chat window visible-and-key rule")
struct VisibilityTests {
    @Test func onlyVisibleKeyActiveUnoccludedCounts() {
        #expect(chatWindowIsVisibleAndKey(ChatWindowState(isVisible: true, isKey: true, appIsActive: true)))
    }

    @Test(arguments: [
        ChatWindowState.closed,
        ChatWindowState(isVisible: false, isKey: false, appIsActive: true),
        ChatWindowState(isVisible: true, isMiniaturized: true, isKey: false, appIsActive: true),
        ChatWindowState(isVisible: true, isKey: false, appIsActive: true),
        ChatWindowState(isVisible: true, isKey: true, appIsActive: false),
        ChatWindowState(isVisible: true, isKey: true, appIsActive: true, isOccluded: true),
        ChatWindowState(isVisible: true, isMiniaturized: true, isKey: true, appIsActive: true)
    ])
    func everythingElseIsNotInFront(state: ChatWindowState) {
        #expect(!chatWindowIsVisibleAndKey(state))
    }
}

@Suite("Descending panel decisions")
struct PanelRuleTests {
    let front = ChatWindowState(isVisible: true, isKey: true, appIsActive: true)
    let background = ChatWindowState(isVisible: true, isKey: false, appIsActive: false)
    let countdown = Countdown(endsAt: t0.addingTimeInterval(23), total: 30, reason: "complete")
    let request = CopilotRequest(sid: "s", title: "Copilot needs you", message: "pick")

    @Test func countdownShowsWhenChatIsNotInFront() {
        for chat in [ChatWindowState.closed, background, ChatWindowState(isVisible: true, isMiniaturized: true, isKey: false, appIsActive: true)] {
            #expect(PanelRules.decide(PanelInputs(connected: true, phase: .room, countdown: countdown, chat: chat, now: t0)) == .countdown)
        }
    }

    @Test func handsOffToTheWindowWhenItIsKey() {
        #expect(PanelRules.decide(PanelInputs(connected: true, phase: .room, countdown: countdown, chat: front, now: t0)) == nil)
        // …and comes back when the window loses key again.
        #expect(PanelRules.decide(PanelInputs(connected: true, phase: .room, countdown: countdown, chat: background, now: t0)) == .countdown)
    }

    @Test func countdownHoldsZeroBrieflyThenDismisses() {
        let ends = countdown.endsAt
        #expect(PanelRules.decide(PanelInputs(connected: true, phase: .room, countdown: countdown, chat: .closed, now: ends)) == .countdown)
        #expect(PanelRules.decide(PanelInputs(connected: true, phase: .room, countdown: countdown, chat: .closed, now: ends.addingTimeInterval(PanelRules.zeroHold))) == nil)
    }

    @Test func countdownBeatsRequestBeatsNotice() {
        let all = PanelInputs(connected: true, phase: .room, countdown: countdown, request: request, autopilotNoticeUntil: t0.addingTimeInterval(5), chat: .closed, now: t0)
        #expect(PanelRules.decide(all) == .countdown)
        var noCountdown = all
        noCountdown.countdown = nil
        #expect(PanelRules.decide(noCountdown) == .request)
        noCountdown.dismissedRequestKey = request.key
        #expect(PanelRules.decide(noCountdown) == .autopilot)
        noCountdown.request?.resolved = true
        noCountdown.dismissedRequestKey = nil
        #expect(PanelRules.decide(noCountdown) == .autopilot)
    }

    @Test func autopilotNoticeExpires() {
        let i = PanelInputs(connected: true, phase: .room, autopilotNoticeUntil: t0.addingTimeInterval(6), chat: .closed, now: t0.addingTimeInterval(6))
        #expect(PanelRules.decide(i) == nil)
        var lounge = i
        lounge.now = t0
        lounge.phase = .lounge
        #expect(PanelRules.decide(lounge) == nil)
    }

    @Test func nothingWhileDisconnected() {
        #expect(PanelRules.decide(PanelInputs(connected: false, phase: .room, countdown: countdown, chat: .closed, now: t0)) == nil)
    }

    @Test func noticeFiresOnEnteringAutopilotOnly() {
        #expect(PanelRules.entersAutopilot(from: nil, to: .room))
        #expect(PanelRules.entersAutopilot(from: .lounge, to: .room))
        #expect(PanelRules.entersAutopilot(from: .reality, to: .room))
        #expect(!PanelRules.entersAutopilot(from: .room, to: .room))
        #expect(!PanelRules.entersAutopilot(from: .spectating, to: .room))
        #expect(!PanelRules.entersAutopilot(from: .lounge, to: .lounge))
    }
}
