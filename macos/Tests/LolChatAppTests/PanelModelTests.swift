import Foundation
import LolChatCore
import Testing
@testable import LolChatApp

@Suite("App model: descending panel")
@MainActor
struct PanelModelTests {
    @Test func enteringAutopilotDescendsTheNoticeUnlessChatIsInFront() {
        let model = connectedModel()
        model.apply(Fixtures.lounge())
        #expect(model.panelKind == nil)
        model.apply(Fixtures.room(now: Date()))
        #expect(model.autopilotNoticeUntil != nil)
        #expect(model.panelKind == .autopilot)
        model.chatWindow = ChatWindowState(isVisible: true, isKey: true, appIsActive: true)
        #expect(model.panelKind == nil)
        model.chatWindow = .closed
        model.dismissAutopilotNotice()
        #expect(model.panelKind == nil)
    }

    @Test func countdownPanelAndIconTrackEndsAt() {
        let model = connectedModel()
        model.apply(Fixtures.room(now: Date()))
        model.apply(Fixtures.countdown(now: Date(), remaining: 22.5))
        #expect(model.panelKind == .countdown)
        #expect(model.countdownRemaining == 23)
        #expect(model.iconState == .countdown(23))
        #expect(model.presentation.inputEnabled)
    }

    @Test func expiredCountdownHoldsZeroThenTheBannerTakesOver() {
        let model = connectedModel()
        model.apply(Fixtures.countdown(now: Date(), remaining: 0.5))
        model.apply(Fixtures.reality(now: Date()))
        #expect(model.countdown != nil)
        #expect(model.countdownRemaining == 0)
        #expect(model.panelKind == .countdown)
        #expect(model.presentation.closeout?.title == "Back to reality")
    }

    @Test func cancelledCountdownDisappearsAtOnce() {
        let model = connectedModel()
        model.apply(Fixtures.countdown(now: Date(), remaining: 20))
        model.apply(Fixtures.room(now: Date()))
        #expect(model.countdown == nil)
        #expect(model.panelKind != .countdown)
    }

    @Test func requestPanelCanBeDismissedLocally() {
        let model = connectedModel()
        model.apply(Fixtures.request(now: Date()))
        #expect(model.panelKind == .request)
        #expect(model.iconState == .needsYou)
        model.dismissRequestPanel()
        #expect(model.panelKind == .autopilot)
    }

    @Test func nothingDescendsWhileDisconnected() {
        let model = connectedModel()
        model.apply(Fixtures.countdown(now: Date()))
        model.connectionChanged(.disconnected(nil))
        #expect(model.panelKind == nil)
        #expect(model.iconState == .disconnected)
        #expect(!model.presentation.inputEnabled)
    }
}
