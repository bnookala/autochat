import Foundation
import Testing
@testable import AutoChatCore

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
    let blocked = AttentionItem(id: "b", harness: .claude, kind: .blocked, title: "Permission needed")

    @Test func showsWhenTheChatIsNotInFront() {
        for chat in [ChatWindowState.closed, background, ChatWindowState(isVisible: true, isMiniaturized: true, isKey: false, appIsActive: true)] {
            #expect(PanelRules.showsPanel(PanelInputs(connected: true, chat: chat, attention: [blocked])))
        }
    }

    @Test func handsOffToTheWindowWhenItIsKey() {
        #expect(!PanelRules.showsPanel(PanelInputs(connected: true, chat: front, attention: [blocked])))
        // …and comes back when the window loses key again.
        #expect(PanelRules.showsPanel(PanelInputs(connected: true, chat: background, attention: [blocked])))
    }

    @Test func nothingWhileDisconnected() {
        #expect(!PanelRules.showsPanel(PanelInputs(connected: false, chat: .closed, attention: [blocked])))
    }

    /// The lounge itself never brings the panel down: being in the room, or a daemon from before
    /// always-on with a request and no queue.
    @Test func onlyTheAttentionQueue() {
        #expect(!PanelRules.showsPanel(PanelInputs(connected: true, chat: .closed)))
        #expect(!PanelRules.showsPanel(PanelInputs(connected: true, chat: .closed, attention: [])))
    }
}
