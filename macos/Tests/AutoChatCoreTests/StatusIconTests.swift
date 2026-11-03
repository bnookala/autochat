import Foundation
import Testing
@testable import AutoChatCore

private let t0 = Date(timeIntervalSince1970: 1_730_400_000)

@Suite("Status icon states")
struct StatusIconTests {
    @Test func states() {
        #expect(StatusIconState.from(connected: false, snapshot: Fixtures.room(now: t0)) == .disconnected)
        #expect(StatusIconState.from(connected: true, snapshot: nil) == .disconnected)
        #expect(StatusIconState.from(connected: true, snapshot: Fixtures.room(now: t0)) == .inLounge)
        #expect(StatusIconState.from(connected: true, snapshot: Fixtures.lounge()) == .outOfLounge)
    }

    @Test func whatYourAgentsNeedIsTheBadgesJob() {
        #expect(StatusIconState.from(connected: true, snapshot: Fixtures.request(now: t0)) == .inLounge)
        #expect(StatusIconState.from(connected: true, snapshot: Fixtures.attention(now: t0)) == .inLounge)
        #expect(StatusIconState.from(connected: true, snapshot: Fixtures.attentionLounge(now: t0)) == .outOfLounge)
    }
}

@Suite("Plain text")
struct PlainTextTests {
    @Test func stripsControlsButKeepsMarkdownLiteral() {
        #expect(PlainText.clean("**hi** [x](https://e.com)") == "**hi** [x](https://e.com)")
        #expect(PlainText.clean("a\u{1b}[31mb\u{7}c") == "a[31mbc")
        #expect(PlainText.clean("x\u{202E}y\u{2066}z") == "xyz")
        #expect(PlainText.clean("one\ntwo") == "one two")
        #expect(PlainText.clean("one\ntwo", keepNewlines: true) == "one\ntwo")
    }
}
