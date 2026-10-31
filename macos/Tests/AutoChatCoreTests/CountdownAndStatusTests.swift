import Foundation
import Testing
@testable import AutoChatCore

private let t0 = Date(timeIntervalSince1970: 1_730_400_000)

@Suite("Countdown clock")
struct CountdownClockTests {
    @Test func remainingRoundsUpFromEndsAt() {
        let ends = t0.addingTimeInterval(30)
        #expect(CountdownClock.remainingSeconds(until: ends, now: t0) == 30)
        #expect(CountdownClock.remainingSeconds(until: ends, now: t0.addingTimeInterval(0.001)) == 30)
        #expect(CountdownClock.remainingSeconds(until: ends, now: t0.addingTimeInterval(7)) == 23)
        #expect(CountdownClock.remainingSeconds(until: ends, now: t0.addingTimeInterval(6.2)) == 24)
        #expect(CountdownClock.remainingSeconds(until: ends, now: t0.addingTimeInterval(29.99)) == 1)
        #expect(CountdownClock.remainingSeconds(until: ends, now: ends) == 0)
        #expect(CountdownClock.remainingSeconds(until: ends, now: ends.addingTimeInterval(5)) == 0)
    }

    @Test func ticksLandOnSecondBoundariesOfEndsAt() {
        let ends = t0.addingTimeInterval(30)
        #expect(CountdownClock.nextTick(endsAt: ends, now: t0.addingTimeInterval(6.2)) == t0.addingTimeInterval(7))
        #expect(CountdownClock.nextTick(endsAt: ends, now: t0) == t0.addingTimeInterval(1))
        #expect(CountdownClock.nextTick(endsAt: ends, now: t0.addingTimeInterval(29.5)) == ends)
        #expect(CountdownClock.nextTick(endsAt: ends, now: ends) == nil)
    }

    @Test func ticksEverySecondDownToZero() {
        let ends = t0.addingTimeInterval(30)
        var now = t0.addingTimeInterval(0.4)
        var shown: [Int] = [CountdownClock.remainingSeconds(until: ends, now: now)]
        while let next = CountdownClock.nextTick(endsAt: ends, now: now) {
            now = next
            shown.append(CountdownClock.remainingSeconds(until: ends, now: now))
        }
        #expect(shown == Array((0...30).reversed()))
    }

    @Test func formatting() {
        #expect(CountdownClock.format(23) == "23s")
        #expect(CountdownClock.format(0) == "0s")
        #expect(CountdownClock.format(-3) == "0s")
        #expect(CountdownClock.format(65) == "1:05")
        #expect(CountdownClock.title(remaining: 23) == "Back to reality in 23s")
        #expect(CountdownClock.title(remaining: 0) == "Back to reality now")
        #expect(CountdownClock.reasonPhrase("complete") == "your copilot finished")
        #expect(CountdownClock.reasonPhrase("abort") == "you interrupted your copilot")
        #expect(CountdownClock.reasonPhrase(nil) == "your autopilot run is over")
    }

    @Test func fractionLeft() {
        let ends = t0.addingTimeInterval(30)
        #expect(CountdownClock.fractionLeft(endsAt: ends, total: 30, now: t0) == 1)
        #expect(CountdownClock.fractionLeft(endsAt: ends, total: 30, now: t0.addingTimeInterval(15)) == 0.5)
        #expect(CountdownClock.fractionLeft(endsAt: ends, total: 30, now: ends.addingTimeInterval(1)) == 0)
        #expect(CountdownClock.fractionLeft(endsAt: ends, total: nil, now: t0.addingTimeInterval(-10)) == 1)
    }
}

@Suite("Status icon states")
struct StatusIconTests {
    @Test func states() {
        #expect(StatusIconState.from(connected: false, snapshot: Fixtures.room(now: t0), countdown: nil, now: t0) == .disconnected)
        #expect(StatusIconState.from(connected: true, snapshot: Fixtures.lounge(), countdown: nil, now: t0) == .lounge)
        #expect(StatusIconState.from(connected: true, snapshot: Fixtures.room(now: t0), countdown: nil, now: t0) == .autopilot)
        #expect(StatusIconState.from(connected: true, snapshot: Fixtures.request(now: t0), countdown: nil, now: t0) == .needsYou)
        let c = Fixtures.countdown(now: t0)
        #expect(StatusIconState.from(connected: true, snapshot: c, countdown: c.countdown, now: t0) == .countdown(23))
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
