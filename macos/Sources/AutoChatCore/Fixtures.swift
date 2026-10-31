import Foundation

/// Canned snapshots for the `--render-snapshots` dev mode, previews and tests.
public enum Fixtures {
    public static let me = Me(handle: "stormy-newt-59", color: .xterm(39))

    public static func members(needed: Bool = false) -> [Member] {
        [
            Member(handle: "jade-lynx-0c", color: .xterm(213), status: .active, isHost: true),
            Member(handle: "stormy-newt-59", color: .xterm(39), status: needed ? .needed : .active, isYou: true),
            Member(handle: "brisk-otter-7a", color: .xterm(114), status: .active),
            Member(handle: "quiet-heron-d1", color: .xterm(179), status: .away)
        ]
    }

    public static func messages(start: Date) -> [ChatMessage] {
        func at(_ s: TimeInterval) -> Date { start.addingTimeInterval(s) }
        return [
            ChatMessage(kind: .sys, text: "entering #lobby, looking for other autopiloters…", ts: at(0)),
            ChatMessage(kind: .sys, text: "joined a live room hosted by jade-lynx-0c", ts: at(4)),
            ChatMessage(kind: .chat, from: "jade-lynx-0c", text: "anyone else's copilot rewriting their whole test suite rn", ts: at(20), color: .xterm(213)),
            ChatMessage(kind: .chat, from: "brisk-otter-7a", text: "mine is 40 tool calls deep into a yaml file", ts: at(34), color: .xterm(114)),
            ChatMessage(kind: .chat, from: "stormy-newt-59", text: "lol same. it keeps renaming things back and forth", ts: at(51), color: .xterm(39), isSelf: true),
            ChatMessage(kind: .sys, text: "quiet-heron-d1 is here (spectating)", ts: at(63), color: .xterm(179)),
            ChatMessage(kind: .chat, from: "jade-lynx-0c", text: "**not bold** and https://example.com stay plain text, as they should", ts: at(80), color: .xterm(213)),
            ChatMessage(kind: .chat, from: "brisk-otter-7a", text: "say ping and I pong. scientifically proven", ts: at(96), color: .xterm(114)),
            ChatMessage(kind: .chat, from: "stormy-newt-59", text: "ping", ts: at(110), color: .xterm(39), isSelf: true),
            ChatMessage(kind: .chat, from: "brisk-otter-7a", text: "pong", ts: at(111), color: .xterm(114)),
            ChatMessage(kind: .chat, from: "jade-lynx-0c", text: "my copilot just wrote a haiku in a commit message. leaving it", ts: at(128), color: .xterm(213))
        ]
    }

    public static let summary = "Refactored the API client onto the new retry helper and updated 14 tests. All tests pass."

    public static func room(now: Date) -> Snapshot {
        Snapshot(
            phase: .room,
            room: RoomInfo(display: "#lobby", code: "lobby", isHost: false, activeCount: 3, host: "jade-lynx-0c"),
            me: me,
            members: members(),
            messages: messages(start: now.addingTimeInterval(-180)),
            sessions: [SessionInfo(sid: "a1b2c3", state: "running", cwd: "~/code/api-server")]
        )
    }

    public static func request(now: Date) -> Snapshot {
        var s = room(now: now)
        s.members = members(needed: true)
        s.request = CopilotRequest(
            sid: "a1b2c3", cwd: "~/code/api-server", title: "Copilot needs you",
            message: "Run the database migrations against staging before continuing? (yes / no / skip)", resolved: false
        )
        s.sessions = [SessionInfo(sid: "a1b2c3", state: "needed", cwd: "~/code/api-server")]
        return s
    }

    public static func countdown(now: Date, remaining: TimeInterval = 23) -> Snapshot {
        var s = room(now: now)
        s.sessions = []
        s.messages.append(ChatMessage(kind: .sys, text: "your copilot finished. back to reality in 30s (keep chatting)", ts: now.addingTimeInterval(remaining - 30)))
        s.messages.append(ChatMessage(kind: .chat, from: "jade-lynx-0c", text: "see you on the other side", ts: now.addingTimeInterval(remaining - 27), color: .xterm(213)))
        s.countdown = Countdown(endsAt: now.addingTimeInterval(remaining), total: 30, reason: "complete", summary: summary, cwd: "~/code/api-server")
        return s
    }

    public static func reality(now: Date) -> Snapshot {
        var s = room(now: now)
        s.phase = .reality
        s.room = nil
        s.members = []
        s.banner = Banner(kind: .reality, reason: "complete", summary: summary, cwd: "~/code/api-server")
        return s
    }

    public static func lounge() -> Snapshot {
        Snapshot(phase: .lounge, room: RoomInfo(display: "#lobby"), me: me)
    }

    /// The example snapshot from issue #2, as JSON.
    public static let issueExampleJSON = #"""
    {"type":"state","v":1,
     "phase":"room",
     "room":{"display":"#lobby","isHost":false,"activeCount":3},
     "me":{"handle":"stormy-newt-59","color":"39"},
     "members":[{"handle":"jade-lynx-0c","color":"213","status":"active","isHost":true,"you":false}],
     "messages":[{"kind":"chat","from":"jade-lynx-0c","text":"lol same","ts":1730400000000,"color":"213"}],
     "request":{"sid":"abc","cwd":"~/code/x","title":"Copilot needs you","message":"Pick one","resolved":false} ,
     "sessions":[{"sid":"abc","state":"running","cwd":"~/code/x"}],
     "countdown":{"endsAt":1730400030000,"total":30,"reason":"complete","summary":"done","cwd":"~/code/x"},
     "banner":null}
    """#
}
