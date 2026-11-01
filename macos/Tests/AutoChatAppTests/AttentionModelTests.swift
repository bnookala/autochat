import AppKit
import Foundation
import AutoChatCore
import Testing
@testable import AutoChatApp

@Suite("App model: attention queue")
@MainActor
struct AttentionModelTests {
    let front = ChatWindowState(isVisible: true, isKey: true, appIsActive: true)

    @Test func blockedAgentsBadgeTheIconAndBringThePanelDown() {
        let model = connectedModel()
        model.apply(Fixtures.attention(now: Date()))
        #expect(model.badgeCount == 2)
        #expect(model.iconState == .autopilot, "the badge says who needs you")
        #expect(model.panelKind == .attention)
        #expect(model.attention.map(\.id) == ["7", "9", "6", "4"])
        model.connectionChanged(.disconnected(nil))
        #expect(model.badgeCount == 0)
        #expect(model.attention.isEmpty)
        #expect(model.panelKind == nil)
    }

    @Test func jumpingToABlockedAgentPutsThePanelAwayForIt() {
        let model = connectedModel()
        var s = Fixtures.attention(now: Date())
        model.apply(s)
        let items = model.attention
        model.jump(to: items[0])
        #expect(model.panelKind == .attention, "another agent still waits")
        model.jump(to: items[1])
        #expect(model.panelKind != .attention)
        #expect(model.badgeCount == 2, "blocked agents stay in the queue until they carry on")

        // One carries on; later a new question comes in: down again.
        s.attention = Array(s.attention!.dropFirst())
        model.apply(s)
        #expect(model.seenAttention == ["9"], "what's gone is forgotten")
        s.attention!.append(AttentionItem(id: "20", harness: .copilot, sid: "x", kind: .blocked, title: "Permission needed", at: Date()))
        model.apply(s)
        #expect(model.panelKind == .attention)
    }

    @Test func whatTheChatShowedDoesNotComeBackAsAPanel() {
        let model = connectedModel()
        model.apply(Fixtures.attention(now: Date()))
        model.chatWindow = front
        #expect(model.panelKind == nil)
        model.chatWindow = .closed
        #expect(model.panelKind != .attention)
        #expect(model.badgeCount == 2)
    }

    @Test func notOnTheAgentsTab() {
        let model = connectedModel()
        var s = Fixtures.attention(now: Date())
        s.agents = LoungeAgents(present: 1, openThreads: 0)
        model.apply(s)
        model.selectTab(.agents)
        model.chatWindow = front
        #expect(model.panelKind == .attention, "the Agents tab doesn't show the queue")
        model.selectTab(.lounge)
        #expect(model.panelKind == nil)
        model.chatWindow = .closed
        #expect(model.panelKind != .attention)
    }

    @Test func finishedAgentsWaitQuietly() {
        let model = connectedModel()
        model.apply(Fixtures.attentionLounge(now: Date()))
        #expect(model.attention.count == 3)
        #expect(model.badgeCount == 0)
        #expect(model.panelKind == nil, "finished and failed agents never bring the panel down")
        model.apply(Fixtures.attentionCountdown(now: Date()))
        #expect(model.panelKind == .countdown)
    }

    @Test func theStripCollapsesWhenThereIsLittleLeft() {
        let model = connectedModel()
        var s = Fixtures.attention(now: Date())
        model.apply(s)
        model.attentionExpanded = true
        s.attention = Array(s.attention!.prefix(1))
        model.apply(s)
        #expect(!model.attentionExpanded)
    }

    @Test func theBadgeIsATemplateImage() {
        let plain = StatusIcon.image(for: .autopilot, badge: 0, description: "AutoChat")
        let badged = StatusIcon.image(for: .autopilot, badge: 2, description: "AutoChat")
        #expect(plain?.isTemplate == true)
        #expect(badged?.isTemplate == true)
        #expect((badged?.size.width ?? 0) > (plain?.size.width ?? 0), "the badge sticks out on the right")
        #expect(badged?.accessibilityDescription == "AutoChat")
        let rep = badged.flatMap { NSBitmapImageRep(data: $0.tiffRepresentation ?? Data()) }
        #expect((rep?.pixelsWide ?? 0) > 0)
    }
}
