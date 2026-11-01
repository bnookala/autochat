import Foundation
import Testing
@testable import AutoChatCore

private let t0 = Date(timeIntervalSince1970: 1_730_400_000)

@Suite("Attention queue: decoding")
struct AttentionDecodingTests {
    private func decode(_ json: String) throws -> Snapshot {
        guard case let .state(s) = Inbound.parse(Data(json.utf8)) else {
            throw CommandError.rejected("not a state line")
        }
        return s
    }

    @Test func decodesTheProtocolDocExample() throws {
        let s = try decode(#"""
        {"type":"state","v":1,"phase":"room","attention":[
          {"id":"7","harness":"claude","sid":"e5f6","cwd":"/Users/me/code/web","kind":"blocked","title":"Permission needed","summary":"Bash: npm test","at":1730400004000},
          {"id":"5","harness":"copilot","sid":"5d0c","cwd":"/Users/me/code/x","kind":"finished","title":"Copilot CLI finished","summary":"Shipped it.","at":1730400001000}]}
        """#.replacingOccurrences(of: "\n", with: ""))
        let items = try #require(s.attention)
        #expect(items.map(\.id) == ["7", "5"])
        #expect(items[0] == AttentionItem(
            id: "7", harness: .claude, sid: "e5f6", cwd: "/Users/me/code/web", kind: .blocked, title: "Permission needed",
            summary: "Bash: npm test", at: Date(timeIntervalSince1970: 1_730_400_004)
        ))
        #expect(items[1].kind == .finished)
        #expect(items[1].harness == .copilot)
    }

    @Test func decodesLeniently() throws {
        let s = try decode(#"""
        {"type":"state","attention":[
          {"id":12,"kind":"blocked","title":"x","at":"1730400000000"},
          {"id":"a","harness":"aider","kind":"exploded","summary":null,"cwd":7},
          {"kind":"finished","title":"no id"},
          {"id":"","title":"empty id"},
          "garbage", 42, null,
          {"id":"b","harness":null,"kind":null,"title":null,"extra":{"x":1}}]}
        """#.replacingOccurrences(of: "\n", with: ""))
        let items = try #require(s.attention)
        #expect(items.map(\.id) == ["12", "a", "b"])
        #expect(items[0].at == t0)
        #expect(items[0].harness == .copilot, "no harness: Copilot, like hooks from before adapters")
        #expect(items[1].harness == .generic("aider"))
        #expect(items[1].kind == .unknown("exploded"))
        #expect(items[1].cwd == nil)
        #expect(items[2].kind == .finished)
        #expect(items[2].title == "")
        #expect(AttentionRules.title(items[2]) == "Copilot finished")
    }

    @Test func missingMeansAnOlderDaemon() throws {
        #expect(try decode(#"{"type":"state","phase":"room"}"#).attention == nil)
        #expect(try decode(#"{"type":"state","phase":"room","attention":null}"#).attention == nil)
        #expect(try decode(#"{"type":"state","phase":"room","attention":"nope"}"#).attention == nil)
        #expect(try decode(#"{"type":"state","phase":"room","attention":[]}"#).attention == [])
    }

    @Test func encodesItsCommands() throws {
        let jump = try JSONSerialization.jsonObject(with: Command.jumpTo("7").encodedLine(id: 3)) as? [String: Any]
        #expect(jump?["cmd"] as? String == "jumpTo")
        #expect(jump?["id"] as? Int == 3, "id stays the command's")
        #expect(jump?["item"] as? String == "7")
        #expect(String(decoding: Command.dismissAttention("7").encodedLine(id: 4), as: UTF8.self) == "{\"cmd\":\"dismissAttention\",\"id\":4,\"item\":\"7\",\"type\":\"cmd\"}\n")
        #expect(String(decoding: Command.joinNow.encodedLine(id: 5), as: UTF8.self) == "{\"cmd\":\"joinNow\",\"id\":5,\"type\":\"cmd\"}\n")
    }
}

@Suite("Attention queue: rules")
struct AttentionRulesTests {
    let items = Fixtures.attentionItems(now: t0)

    @Test func urgentFirstThenOldest() {
        let shuffled = [items[3], items[1], items[2], items[0]]
        #expect(AttentionRules.sorted(shuffled).map(\.id) == ["7", "9", "6", "4"])
        let unknown = AttentionItem(id: "u", kind: .unknown("x"), title: "?", at: t0.addingTimeInterval(-9999))
        #expect(AttentionRules.sorted(items + [unknown]).last?.id == "4", "unknown kinds sort with finished, by time")
    }

    @Test func countsAndBadge() {
        #expect(AttentionRules.urgentCount(items) == 2)
        #expect(AttentionRules.urgentCount(nil) == 0)
        #expect(AttentionRules.counts(items) == "2 blocked · 1 failed · 1 finished")
        #expect(AttentionRules.counts([items[3]]) == "1 finished")
        #expect(AttentionRules.badgeText(3) == "3")
        #expect(AttentionRules.badgeText(12) == "9+")
        #expect(AttentionRules.badgeTooltip(1) == "An agent needs you")
        #expect(AttentionRules.badgeTooltip(2) == "2 agents need you")
    }

    @Test func headlines() {
        #expect(AttentionRules.headline(items) == "2 agents need you")
        #expect(AttentionRules.subheadline(items) == "Also 1 failed · 1 finished")
        #expect(AttentionRules.headline([items[0]]) == "Claude Code needs you")
        #expect(AttentionRules.subheadline([items[0]]) == "Waiting for an approval or an answer")
    }

    @Test func textIsPlainAndHasFallbacks() {
        let raw = AttentionItem(id: "x", harness: .gemini, cwd: "/Users/me/code/web/", kind: .blocked, title: "  ", summary: "a\u{202E}b\nc")
        #expect(AttentionRules.title(raw) == "Gemini needs you")
        #expect(AttentionRules.summary(raw) == "ab c")
        #expect(AttentionRules.place(raw) == "web")
        #expect(AttentionRules.place(AttentionItem(id: "y", cwd: "~", kind: .finished, title: "t")) == "~")
        #expect(AttentionRules.place(AttentionItem(id: "z", kind: .finished, title: "t")) == nil)
        #expect(AttentionRules.accessibilityLabel(items[0]) == "Permission needed, Claude Code, in web, Bash: npm run migrate -- --env staging")
    }

    @Test func theStripLeavesOutTheQuestionTheCardShows() {
        let s = Fixtures.attention(now: t0)
        #expect(AttentionRules.stripItems(s).map(\.id) == ["7", "6", "4"])
        var resolved = s
        resolved.request?.resolved = true
        #expect(AttentionRules.stripItems(resolved).map(\.id) == ["7", "9", "6", "4"])
        #expect(AttentionRules.stripItems(Fixtures.room(now: t0)).isEmpty)
    }

    @Test func theCountdownListsTheQueueOnlyWithSeveralAgents() {
        #expect(AttentionRules.countdownList(Fixtures.attentionCountdown(now: t0).attention).map(\.id) == ["11", "12", "13"])
        #expect(AttentionRules.countdownList([items[3]]).isEmpty, "one agent: the countdown already says it all")
        #expect(AttentionRules.countdownList(nil).isEmpty)
    }

    @Test func theIconLeavesNeedsYouToTheBadge() {
        #expect(StatusIconState.from(connected: true, snapshot: Fixtures.attention(now: t0), countdown: nil, now: t0) == .autopilot)
        #expect(StatusIconState.from(connected: true, snapshot: Fixtures.request(now: t0), countdown: nil, now: t0) == .needsYou, "older daemons: as before")
    }
}

@Suite("Attention queue: the descending panel")
struct AttentionPanelRuleTests {
    let blocked = AttentionItem(id: "b", harness: .claude, kind: .blocked, title: "Permission needed")
    let finished = AttentionItem(id: "f", kind: .finished, title: "Copilot CLI finished")
    let front = ChatWindowState(isVisible: true, isKey: true, appIsActive: true)

    private func inputs(_ attention: [AttentionItem]?, seen: Set<String> = [], chat: ChatWindowState = .closed, lounge: Bool = true) -> PanelInputs {
        PanelInputs(connected: true, phase: .room, chat: chat, chatShowsLounge: lounge, attention: attention, seenAttention: seen, now: t0)
    }

    @Test func comesDownForAgentsBlockedOnYouOnly() {
        #expect(PanelRules.decide(inputs([blocked, finished])) == .attention)
        #expect(PanelRules.decide(inputs([finished])) == nil, "a finished agent never brings the panel down by itself")
        #expect(PanelRules.decide(inputs([])) == nil)
    }

    @Test func notAgainForWhatYouSaw() {
        #expect(PanelRules.decide(inputs([blocked], seen: ["b"])) == nil)
        let another = AttentionItem(id: "c", kind: .blocked, title: "Copilot has a question for you")
        #expect(PanelRules.decide(inputs([blocked, another], seen: ["b"])) == .attention)
    }

    @Test func handsOffToTheChatLikeEveryPanel() {
        #expect(PanelRules.decide(inputs([blocked], chat: front)) == nil)
        #expect(PanelRules.decide(inputs([blocked], chat: front, lounge: false)) == .attention, "the Agents tab doesn't show the queue")
        var counting = inputs([blocked])
        counting.countdown = Countdown(endsAt: t0.addingTimeInterval(20), total: 30)
        #expect(PanelRules.decide(counting) == .countdown)
    }

    @Test func theQueueReplacesTheRequestPanel() {
        var i = inputs([])
        i.request = CopilotRequest(sid: "s", title: "Copilot needs you", message: "go?")
        #expect(PanelRules.decide(i) == nil, "with a queue, a request is a blocked item")
        i.attention = nil
        #expect(PanelRules.decide(i) == .request, "without one (an older daemon), the request panel as before")
    }
}
