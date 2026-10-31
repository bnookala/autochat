import Foundation
import Testing
@testable import AutoChatCore

@Suite("Snapshot decoding")
struct SnapshotDecodingTests {
    private func decode(_ json: String) throws -> Snapshot {
        guard case let .state(s) = Inbound.parse(Data(json.utf8)) else {
            throw CommandError.rejected("not a state line")
        }
        return s
    }

    @Test func decodesTheIssueExample() throws {
        let s = try decode(Fixtures.issueExampleJSON.replacingOccurrences(of: "\n", with: ""))
        #expect(s.version == 1)
        #expect(s.phase == .room)
        #expect(s.room?.display == "#lobby")
        #expect(s.room?.activeCount == 3)
        #expect(s.room?.isHost == false)
        #expect(s.me?.handle == "stormy-newt-59")
        #expect(s.me?.color == .xterm(39))
        #expect(s.members.count == 1)
        #expect(s.members[0].isHost)
        #expect(!s.members[0].isYou)
        #expect(s.members[0].status == .active)
        #expect(s.messages.first?.text == "lol same")
        #expect(s.messages.first?.from == "jade-lynx-0c")
        #expect(s.messages.first?.ts == Date(timeIntervalSince1970: 1_730_400_000))
        #expect(s.request?.title == "Copilot needs you")
        #expect(s.request?.resolved == false)
        #expect(s.sessions.first?.state == "running")
        #expect(s.countdown?.endsAt == Date(timeIntervalSince1970: 1_730_400_030))
        #expect(s.countdown?.total == 30)
        #expect(s.countdown?.reason == "complete")
        #expect(s.banner == nil)
        #expect(s.hostHandle == "jade-lynx-0c")
    }

    /// The example from docs/protocol.md on core/daemon-countdown (the real daemon's shape).
    @Test func decodesTheProtocolDocExample() throws {
        let s = try decode(##"""
        {"type":"state","v":1,"now":1730400005000,
         "phase":"room",
         "room":{"display":"#lobby","isHost":false,"activeCount":3,"hostHandle":"jade-lynx-0c","peers":2},
         "me":{"handle":"stormy-newt-59","color":"#00afff"},
         "members":[{"handle":"jade-lynx-0c","color":"#5fd787","status":"active","isHost":true,"you":false,"needed":false},
                    {"handle":"stormy-newt-59","color":"#00afff","status":"active","isHost":false,"you":true,"needed":true}],
         "messages":[{"id":12,"kind":"chat","from":"jade-lynx-0c","text":"lol same","ts":1730400000000,"color":"#5fd787","you":false},
                     {"id":13,"kind":"sys","from":null,"text":"x joined","ts":1730400000001,"color":null,"you":false}],
         "request":{"sid":"5d0c","cwd":"/Users/me/code/x","title":"Permission needed","message":"Run tests?","resolved":false},
         "sessions":[{"sid":"5d0c","state":"running","cwd":"/Users/me/code/x"}],
         "countdown":{"endsAt":1730400030000,"total":30,"reason":"complete","summary":"Shipped it.","cwd":"/Users/me/code/x","remaining":23},
         "banner":null}
        """##.replacingOccurrences(of: "\n", with: ""))
        #expect(s.now == Date(timeIntervalSince1970: 1_730_400_005))
        #expect(s.room?.host == "jade-lynx-0c")
        #expect(s.room?.mates == 2)
        #expect(s.me?.color == .rgb(0x00, 0xaf, 0xff))
        #expect(s.members[0].status == .active)
        #expect(s.members[1].status == .needed)
        #expect(s.members[1].isYou)
        #expect(s.messages.map(\.mid) == ["12", "13"])
        #expect(s.messages[1].from == nil)
        #expect(s.messages[1].color == nil)
        #expect(s.countdown?.total == 30)
        #expect(s.request?.title == "Permission needed")
        // The countdown is re-based onto the local clock using the daemon's `now`.
        let local = Date(timeIntervalSince1970: 1_730_400_007)
        let aligned = s.alignedToLocalClock(receivedAt: local)
        #expect(aligned.countdown?.endsAt == Date(timeIntervalSince1970: 1_730_400_032))
        #expect(CountdownClock.remainingSeconds(until: aligned.countdown!.endsAt, now: local) == 25)
    }

    @Test func missingOptionalsAreNil() throws {
        let s = try decode(#"{"type":"state","v":1,"phase":"lounge"}"#)
        #expect(s.phase == .lounge)
        #expect(s.room == nil)
        #expect(s.me == nil)
        #expect(s.members.isEmpty)
        #expect(s.messages.isEmpty)
        #expect(s.request == nil)
        #expect(s.countdown == nil)
        #expect(s.banner == nil)
        #expect(s.sessions.isEmpty)
    }

    @Test func nullsAreNil() throws {
        let s = try decode(#"{"type":"state","v":1,"phase":"room","room":null,"me":null,"members":null,"messages":null,"request":null,"sessions":null,"countdown":null,"banner":null}"#)
        #expect(s.room == nil)
        #expect(s.members.isEmpty)
        #expect(s.countdown == nil)
    }

    @Test func unknownAndExtraFieldsAreIgnored() throws {
        let s = try decode(#"""
        {"type":"state","v":2,"phase":"warp","future":{"x":[1,2]},
         "room":{"display":"#x","weird":true,"activeCount":"nope"},
         "members":[{"handle":"a","status":"teleporting","color":"#ff8800","extra":1},{"nohandle":true},42,{"handle":"b","host":true,"self":true}],
         "messages":[{"kind":"emote","text":"waves","ts":"1730400000000"},{"kind":"sys","text":"hi","ts":1.73040000e12},"garbage",{"kind":"chat","from":"abcd","handle":"jade","text":"yo","you":true}],
         "countdown":{"total":30},
         "banner":{"kind":"party","summary":"s"},
         "request":{"title":7,"resolved":"maybe"}}
        """#)
        #expect(s.version == 2)
        #expect(s.phase == .unknown("warp"))
        #expect(s.room?.display == "#x")
        #expect(s.room?.activeCount == nil)
        #expect(s.members.map(\.handle) == ["a", "b"])
        #expect(s.members[0].status == .unknown("teleporting"))
        #expect(s.members[0].color == .rgb(255, 136, 0))
        #expect(s.members[1].isHost)
        #expect(s.members[1].isYou)
        #expect(s.messages.count == 3)
        #expect(s.messages[0].kind == .unknown("emote"))
        #expect(s.messages[0].ts == Date(timeIntervalSince1970: 1_730_400_000))
        #expect(s.messages[1].kind == .sys)
        #expect(s.messages[2].from == "jade")
        #expect(s.messages[2].isSelf)
        // A countdown without endsAt can't be shown; it decodes as absent rather than failing.
        #expect(s.countdown == nil)
        #expect(s.banner?.kind == .unknown("party"))
        #expect(s.request?.title == nil)
        #expect(s.request?.resolved == false)
    }

    @Test func colorsDecodeFromNumbersAndStrings() throws {
        let s = try decode(##"{"type":"state","members":[{"handle":"a","color":203},{"handle":"b","color":"203"},{"handle":"c","color":"#abc"},{"handle":"d","color":"blue"}]}"##)
        #expect(s.members.map(\.color) == [.xterm(203), .xterm(203), .rgb(0xaa, 0xbb, 0xcc), nil])
    }

    @Test func xtermPaletteMapping() {
        #expect(HandleColor.xterm256(16) == (0, 0, 0))
        #expect(HandleColor.xterm256(39) == (0, 175, 255))
        #expect(HandleColor.xterm256(213) == (255, 135, 255))
        #expect(HandleColor.xterm256(244) == (128, 128, 128))
        #expect(HandleColor.xterm256(999) == (238, 238, 238))
    }

    @Test func parsesRepliesAndOtherLines() {
        #expect(Inbound.parse(Data(#"{"type":"reply","id":7,"ok":true}"#.utf8)) == .reply(Reply(id: 7, ok: true)))
        #expect(Inbound.parse(Data(#"{"type":"reply","id":8,"ok":false,"error":"not in a room"}"#.utf8)) == .reply(Reply(id: 8, ok: false, error: "not in a room")))
        #expect(Inbound.parse(Data(#"{"type":"reply","id":9}"#.utf8)) == .reply(Reply(id: 9, ok: true)))
        #expect(Inbound.parse(Data(#"{"type":"hello"}"#.utf8)) == .other("hello"))
        #expect(Inbound.parse(Data(#"{"type":"error","v":1,"error":"too many subscribers"}"#.utf8)) == .refused("too many subscribers"))
        #expect(Inbound.parse(Data(#"{"ok":false}"#.utf8)) == .oneShot(ok: false, error: nil))
        #expect(Inbound.parse(Data("not json".utf8)) == .invalid)
        #expect(Inbound.parsePing(Data(#"{"ok":true,"pong":true,"phase":"room","daemon":true}"#.utf8)) == PingReply(phase: .room, isDaemon: true))
        #expect(Inbound.parsePing(Data(#"{"ok":true,"pong":true,"phase":"lounge"}"#.utf8)) == PingReply(phase: .lounge, isDaemon: false))
        #expect(Inbound.parsePing(Data(#"{"ok":false}"#.utf8)) == nil)
    }

    @Test func encodesCommands() throws {
        let say = try JSONSerialization.jsonObject(with: Command.say("lol \"same\"").encodedLine(id: 7)) as? [String: Any]
        #expect(say?["type"] as? String == "cmd")
        #expect(say?["id"] as? Int == 7)
        #expect(say?["cmd"] as? String == "say")
        #expect(say?["text"] as? String == "lol \"same\"")
        let line = Command.returnNow.encodedLine(id: 8)
        #expect(line.last == 0x0A)
        #expect(String(decoding: line, as: UTF8.self) == "{\"cmd\":\"returnNow\",\"id\":8,\"type\":\"cmd\"}\n")
        let names = [Command.leaveRoom, .jumpToCopilot, .dismissRequest, .joinNow].map(\.name)
        #expect(names == ["leaveRoom", "jumpToCopilot", "dismissRequest", "joinNow"])
    }

    @Test func lineBufferSplitsAndCaps() {
        var b = LineBuffer(maxLine: 8)
        #expect(b.append(Data("ab\ncd".utf8)) == [Data("ab".utf8)])
        #expect(b.append(Data("e\n\nf".utf8)) == [Data("cde".utf8)])
        #expect(b.append(Data("123456789".utf8)) == nil)
    }
}

@Suite("Paths")
struct PathsTests {
    @Test func defaultMatchesNodeSockPath() {
        let p = AutochatPaths.current(environment: ["HOME": "/Users/someone"])
        #expect(p.home == "/Users/someone/.autochat")
        #expect(p.sockPath == "/Users/someone/.autochat/run/ui.sock")
        #expect(p.configPath == "/Users/someone/.autochat/config.json")
    }

    @Test func respectsAutochatHome() {
        let p = AutochatPaths.current(environment: ["HOME": "/Users/someone", "AUTOCHAT_HOME": "/srv/lc/./x/../home/"])
        #expect(p.home == "/srv/lc/home")
        #expect(p.sockPath == "/srv/lc/home/run/ui.sock")
    }

    @Test func emptyAutochatHomeFallsBack() {
        let p = AutochatPaths.current(environment: ["HOME": "/h", "AUTOCHAT_HOME": ""])
        #expect(p.sockPath == "/h/.autochat/run/ui.sock")
    }

    @Test func legacyLolchatHomeIsAFallback() {
        let legacy = AutochatPaths.current(environment: ["HOME": "/h", "LOLCHAT_HOME": "/srv/old"])
        #expect(legacy.home == "/srv/old")
        let both = AutochatPaths.current(environment: ["HOME": "/h", "LOLCHAT_HOME": "/srv/old", "AUTOCHAT_HOME": "/srv/new"])
        #expect(both.home == "/srv/new")
        #expect(AutochatEnvironment.value("BIN", in: ["LOLCHAT_BIN": "/old"]) == "/old")
        #expect(AutochatEnvironment.value("BIN", in: ["LOLCHAT_BIN": "/old", "AUTOCHAT_BIN": ""]) == "")
    }

    @Test func migratesTheLegacyHomeOnce() throws {
        let user = try makeTestHome().home
        defer { try? FileManager.default.removeItem(atPath: user) }
        let fm = FileManager.default
        let legacy = (user as NSString).appendingPathComponent(".lolchat")
        try fm.createDirectory(atPath: legacy, withIntermediateDirectories: true)
        try Data("{\"publicKey\":\"ab\"}\n".utf8).write(to: URL(fileURLWithPath: legacy).appendingPathComponent("identity.json"))

        #expect(!AutochatPaths.migrateLegacyHome(environment: ["HOME": user, "AUTOCHAT_HOME": "/elsewhere"]), "custom home: leave it")
        #expect(fm.fileExists(atPath: legacy))

        #expect(AutochatPaths.migrateLegacyHome(environment: ["HOME": user]))
        let home = AutochatPaths.current(environment: ["HOME": user]).home
        #expect(!fm.fileExists(atPath: legacy))
        #expect(fm.contents(atPath: (home as NSString).appendingPathComponent("identity.json")) == Data("{\"publicKey\":\"ab\"}\n".utf8))

        // Never clobbers an existing ~/.autochat.
        try fm.createDirectory(atPath: legacy, withIntermediateDirectories: true)
        #expect(!AutochatPaths.migrateLegacyHome(environment: ["HOME": user]))
        #expect(fm.fileExists(atPath: legacy))
    }
}
