import Foundation
import AutoChatCore
import Testing
@testable import AutoChatApp

@Suite("App model: the lounge")
@MainActor
struct PanelModelTests {
    @Test func theRoomNeverBringsThePanelDown() {
        let model = connectedModel()
        model.apply(Fixtures.lounge())
        #expect(!model.showsPanel)
        model.apply(Fixtures.room(now: Date()))
        #expect(!model.showsPanel, "being in the room is nothing to announce")
        model.apply(Fixtures.request(now: Date()))
        #expect(!model.showsPanel, "without a queue (an older daemon), a question waits in the chat")
    }

    @Test func joinTheLoungeFollowsTheDaemon() {
        let model = connectedModel()
        model.apply(Fixtures.room(now: Date()))
        #expect(model.loungeOn)
        #expect(model.iconState == .inLounge)
        #expect(model.presentation.inputEnabled)
        model.apply(Fixtures.lounge())
        #expect(!model.loungeOn)
        #expect(model.iconState == .outOfLounge)
        #expect(!model.presentation.inputEnabled)
    }

    /// A daemon from before always-on: its countdown and closeout phases bring nothing back.
    @Test func anOlderDaemonsCountdownShowsNothing() throws {
        let model = connectedModel()
        guard case let .state(counting) = Inbound.parse(Data(Fixtures.issueExampleJSON.replacingOccurrences(of: "\n", with: "").utf8)) else {
            Issue.record("the issue example didn't decode")
            return
        }
        model.apply(counting)
        #expect(model.iconState == .inLounge)
        #expect(model.loungeOn)
        #expect(!model.showsPanel)
        #expect(model.presentation.inputEnabled)
        guard case let .state(closeout) = Inbound.parse(Data(#"{"type":"state","v":1,"phase":"reality","banner":{"kind":"reality","summary":"done"}}"#.utf8)) else {
            Issue.record("the closeout didn't decode")
            return
        }
        model.apply(closeout)
        #expect(model.iconState == .outOfLounge)
        #expect(!model.loungeOn)
        #expect(!model.showsPanel)
    }

    @Test func nothingDescendsWhileDisconnected() {
        let model = connectedModel()
        model.apply(Fixtures.attention(now: Date()))
        #expect(model.showsPanel)
        model.connectionChanged(.disconnected(nil))
        #expect(!model.showsPanel)
        #expect(model.iconState == .disconnected)
        #expect(!model.loungeOn)
        #expect(!model.presentation.inputEnabled)
    }
}
