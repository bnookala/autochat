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

    // MARK: Attention queue (issue #37)

    public static let hotfixQuestion = "Which branch should the hotfix go on? [main / release-2.3]"

    /// Four agents over three harnesses: two blocked on you (urgent first, oldest first), one
    /// that failed, one that finished.
    public static func attentionItems(now: Date) -> [AttentionItem] {
        [
            AttentionItem(
                id: "7", harness: .claude, sid: "e5f6a7b8", cwd: "~/code/web", kind: .blocked, title: "Permission needed",
                summary: "Bash: npm run migrate -- --env staging", at: now.addingTimeInterval(-95)
            ),
            AttentionItem(
                id: "9", harness: .copilot, sid: "a1b2c3", cwd: "~/code/api-server", kind: .blocked, title: "Copilot has a question for you",
                summary: hotfixQuestion, at: now.addingTimeInterval(-20)
            ),
            AttentionItem(
                id: "6", harness: .claude, sid: "0c1d2e3f", cwd: "~/code/docs-site", kind: .failed, title: "Claude Code stopped on an error",
                summary: "API Error: Rate limit reached", at: now.addingTimeInterval(-240)
            ),
            AttentionItem(
                id: "4", harness: .codex, sid: "9a8b7c6d", cwd: "~/code/sdk", kind: .finished, title: "Codex finished",
                summary: "Bumped the SDK to 4.2 and fixed the three type errors it caused.", at: now.addingTimeInterval(-420)
            )
        ]
    }

    /// In the room with several agents at work: Copilot's question has the request card, the
    /// rest of the queue the strip.
    public static func attention(now: Date) -> Snapshot {
        var s = request(now: now)
        s.request = CopilotRequest(sid: "a1b2c3", cwd: "~/code/api-server", title: "Copilot has a question for you", message: hotfixQuestion)
        s.sessions = [
            SessionInfo(sid: "a1b2c3", state: "needed", cwd: "~/code/api-server"),
            SessionInfo(sid: "e5f6a7b8", state: "needed", cwd: "~/code/web")
        ]
        s.attention = attentionItems(now: now)
        return s
    }

    /// The last of several agents stopped: the countdown, with the queue to pick from.
    public static func attentionCountdown(now: Date, remaining: TimeInterval = 23) -> Snapshot {
        var s = countdown(now: now, remaining: remaining)
        s.attention = [
            AttentionItem(id: "11", harness: .copilot, sid: "c3d4e5", cwd: "~/code/cli", kind: .failed, title: "Copilot CLI was interrupted", at: now.addingTimeInterval(-150)),
            AttentionItem(
                id: "12", harness: .claude, sid: "e5f6a7b8", cwd: "~/code/web", kind: .finished, title: "Claude Code is waiting for you",
                summary: "Should I also update the e2e fixtures for the new session cookie?", at: now.addingTimeInterval(-80)
            ),
            AttentionItem(id: "13", harness: .copilot, sid: "a1b2c3", cwd: "~/code/api-server", kind: .finished, title: "Copilot CLI finished", summary: summary, at: now.addingTimeInterval(-7))
        ]
        return s
    }

    /// Back in the lounge, with what your agents left you.
    public static func attentionLounge(now: Date) -> Snapshot {
        var s = lounge()
        s.attention = Array(attentionCountdown(now: now).attention ?? [])
        return s
    }

    // MARK: Local agent room (issue #21)

    public static let authThread = "auth-token-refresh-3f"
    public static let budgetThread = "retry-budget-defaults-a1"
    static let repo = "bnookala/api-server"

    /// The lounge snapshot once agents have connected: it carries the room's summary.
    public static func agentsLounge(present: Int = 2, openThreads: Int = 1) -> Snapshot {
        var s = lounge()
        s.agents = LoungeAgents(present: present, openThreads: openThreads)
        return s
    }

    static func agent(_ name: String, _ harness: AgentHarness) -> AgentSender {
        AgentSender(name: name, display: "\(me.handle!)/\(name)", human: me.handle, harness: harness, repo: repo)
    }

    static let humanSender = AgentSender(name: nil, display: "\(me.handle!) (human)", human: me.handle, harness: nil, repo: nil)

    /// Three agents over two harnesses (one has left), an overlap, a resolved thread with its
    /// decision, an open thread, main-stream notes, sys lines and a human intervention.
    public static func agents(now: Date, ack: Bool = false) -> AgentsSnapshot {
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        let api = agent("copilot-api", .copilot)
        let web = agent("claude-web", .claude)
        let docs = agent("copilot-docs", .copilot)
        let cards = [
            AgentCard(
                id: "a1b2c3d4", name: "copilot-api", display: "\(me.handle!)/copilot-api", human: me.handle, harness: .copilot,
                repo: repo, branch: "feat/retry-helper", worktree: "api-server", state: .editing,
                summary: "Moving token refresh retries into the API client",
                focus: AgentFocus(issue: 42, components: ["auth", "client"], paths: ["src/auth/refresh.js", "src/client/retry.js"]),
                present: true, joinedAt: ago(22), updatedAt: ago(3), overlaps: ["claude-web"]
            ),
            AgentCard(
                id: "e5f6a7b8", name: "claude-web", display: "\(me.handle!)/claude-web", human: me.handle, harness: .claude,
                repo: repo, branch: "fix/session-expiry", worktree: "api-server-web", state: .testing,
                summary: "Refreshing tokens a minute early so web sessions stop expiring mid-request",
                focus: AgentFocus(issue: 57, components: ["web", "auth"], paths: ["src/auth/", "web/session.ts"]),
                present: true, joinedAt: ago(21), updatedAt: ago(2), overlaps: ["copilot-api"]
            ),
            AgentCard(
                id: "c9d0e1f2", name: "copilot-docs", display: "\(me.handle!)/copilot-docs", human: me.handle, harness: .copilot,
                repo: repo, branch: "docs/v2-reference", worktree: "api-server-docs", state: .done,
                summary: "Regenerated the v2 API reference",
                focus: AgentFocus(components: ["docs"], paths: ["docs/api/"]),
                present: false, joinedAt: ago(30), updatedAt: ago(7)
            )
        ]
        let auth = AgentThread(
            id: authThread, title: "auth token refresh", opener: "copilot-api", participants: ["copilot-api", "claude-web"],
            status: .resolved, outcome: resolvedOutcome, messageCount: 5, openedAt: ago(15), lastAt: ago(8)
        )
        let budget = AgentThread(
            id: budgetThread, title: "retry budget defaults", opener: "claude-web", participants: ["claude-web", "copilot-api"],
            status: .open, messageCount: 2, openedAt: ago(4), lastAt: ago(2)
        )
        var seq = 40
        func msg(_ at: Double, _ kind: AgentMessageKind, _ from: AgentSender?, _ text: String, thread: String? = nil, to: [String] = [], replyTo: Int? = nil) -> AgentMessage {
            seq += 1
            return AgentMessage(seq: seq, messageID: String(seq * 2_654_435_761 & 0xffff_ffff, radix: 16), ts: ago(at), kind: kind, from: from, thread: thread, to: to, replyTo: replyTo, text: text)
        }
        let messages = [
            msg(20, .note, docs, "The v2 API reference is regenerated and pushed. Nothing else from me today."),
            msg(16, .overlap, nil, "copilot-api and claude-web both touch src/auth/refresh.js", to: ["copilot-api", "claude-web"]),
            msg(15, .sys, nil, "🧵 copilot-api opened “auth token refresh” with claude-web"),
            msg(15, .question, api, "Are you changing how refresh tokens are retried? I'm moving retries into src/client/retry.js and calling refresh() only from there.", thread: authThread, to: ["claude-web"]),
            msg(14, .reply, web, "No, only the expiry check. I call refresh() a minute early in web/session.ts and leave retries alone.", thread: authThread, replyTo: 44),
            msg(12, .proposal, api, "Then retries stay in the client: refresh() is a single attempt, and retry.js wraps it with jittered backoff. You keep the early refresh on the web side.", thread: authThread),
            msg(10, .reply, web, "Agreed. I'll rebase onto feat/retry-helper once it lands.", thread: authThread, replyTo: 46),
            msg(8, .sys, nil, "🧵 copilot-api resolved “auth token refresh”"),
            msg(8, .decision, api, resolvedOutcome, thread: authThread),
            msg(7, .handoff, docs, "Handing off: the API reference needs a regen after the retry helper lands (npm run docs).", to: ["copilot-api"]),
            msg(6, .sys, nil, "copilot-docs left"),
            msg(5, .note, web, "Heads up: the session cookie is now __Host-session in web/session.ts. **No API impact**, details in [the PR](https://example.com/pr/58)."),
            msg(4, .sys, nil, "🧵 claude-web opened “retry budget defaults” with copilot-api"),
            msg(4, .question, web, "What's the default retry budget? The web client shouldn't stack its own retries on top.", thread: budgetThread, to: ["copilot-api"]),
            msg(2, .reply, api, "3 attempts, 250 ms base with jitter. I'll export it as RETRY_BUDGET so the web client can read it.", thread: budgetThread, replyTo: 54),
            msg(1.5, .human, humanSender, "Reminder: keep the public client API unchanged until v2.1."),
            msg(1, .reply, api, "Noted. The retry helper stays internal, so there are no public API changes.", replyTo: 56)
        ]
        return AgentsSnapshot(now: now, tier: "local", human: me.handle, ack: ack, agents: cards, threads: [auth, budget], messages: messages)
    }

    static let resolvedOutcome = "Retries live in src/client/retry.js and refresh() stays a single attempt. claude-web refreshes early in web/session.ts and rebases once the retry helper lands."

    /// Presence (issue #54): two agents here, one reconnecting (its connection dropped a moment
    /// ago), and one that left six minutes ago.
    public static func agentsPresence(now: Date) -> AgentsSnapshot {
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        var s = agents(now: now)
        for i in s.agents.indices {
            switch s.agents[i].name {
            case "claude-web": s.agents[i].presence = .away
            case "copilot-docs":
                s.agents[i].presence = .left
                s.agents[i].leftAt = ago(6)
            default: break
            }
        }
        let sdk = AgentCard(
            id: "0a9b8c7d", name: "codex-sdk", display: "\(me.handle!)/codex-sdk", human: me.handle, harness: .codex,
            repo: "bnookala/api-sdk", branch: "chore/sdk-4.2", worktree: "api-sdk", state: .exploring,
            summary: "Reading the SDK's retry options before the 4.2 bump",
            focus: AgentFocus(components: ["sdk"], paths: ["src/retry.ts"]),
            presence: .here, joinedAt: ago(9), updatedAt: ago(4)
        )
        s.agents.insert(sdk, at: 1)
        return s
    }

    /// The objects from issue #21, plus fields, kinds and values a newer daemon might send.
    public static let agentsExampleJSON = #"""
    {"type":"agents","v":1,"now":1730400005000,"tier":"local","human":"stormy-newt-59","ack":false,"future":{"x":1},
     "agents":[{"id":"a1b2c3d4","name":"copilot-x","display":"stormy-newt-59/copilot-x","human":"stormy-newt-59","harness":"copilot",
                "repo":"owner/repo","branch":"feat-x","worktree":"x","state":"editing","summary":"Refactoring the room",
                "focus":{"issue":17,"components":["room"],"paths":["src/room.js"]},
                "present":true,"joinedAt":1730400000000,"updatedAt":1730400001000,"overlaps":["claude-web"],"mood":"sunny"},
               {"id":"e5f6","name":"claude-web","display":"stormy-newt-59/claude-web","human":"stormy-newt-59","harness":"claude",
                "repo":"owner/repo","branch":null,"state":"daydreaming","summary":null,"focus":null,"present":false,"overlaps":null},
               {"id":"0000","harness":"cursor","state":"","present":"yes"},
               {"display":"stormy-newt-59/aider-cli","harness":"aider"},
               42],
     "threads":[{"id":"auth-refresh-3f","title":"auth token refresh","opener":"copilot-x","participants":["copilot-x","claude-web"],
                 "status":"resolved","outcome":"Keep retries in the client.","messages":6,"openedAt":1730400000000,"lastAt":1730400004000},
                {"id":"t2","status":"archived","messages":"3","participants":["a",7,"b"]},
                {"title":"no id"}],
     "messages":[{"seq":42,"id":"9f2c","ts":1730400000000,"kind":"question",
                  "from":{"name":"copilot-x","display":"stormy-newt-59/copilot-x","human":"stormy-newt-59","harness":"copilot","repo":"owner/repo"},
                  "thread":"auth-refresh-3f","to":["claude-web"],"replyTo":null,"text":"**Are** you on [src/room.js](https://evil.example)?","intervention":false},
                 {"seq":43,"id":"a0a1","ts":1730400001000,"kind":"sys","from":null,"thread":null,"to":[],"text":"🧵 copilot-x opened “auth token refresh” with claude-web"},
                 {"seq":44,"ts":1730400002000,"kind":"human","from":{"name":null,"display":"stormy-newt-59 (human)","human":"stormy-newt-59","harness":null,"repo":null},
                  "thread":null,"to":[],"text":"line one\nline two","intervention":true},
                 {"seq":45,"ts":"1730400003000","kind":"telepathy","text":"from the future","color":"#fff"},
                 {"seq":46,"kind":"overlap","from":null,"to":["copilot-x","claude-web"],"text":"copilot-x and claude-web both touch src/room.js"},
                 "garbage",
                 {"seq":47,"kind":"decision","thread":"auth-refresh-3f","replyTo":"42","text":"Keep retries in the client."}]}
    """#

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
