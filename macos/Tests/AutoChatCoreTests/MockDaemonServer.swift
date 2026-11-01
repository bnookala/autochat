import Darwin
import Foundation
@testable import AutoChatCore

/// Per-test AUTOCHAT_HOME inside the package's .build directory (no system temp dirs).
/// The resulting socket path is longer than `sun_path`, which also exercises `connectat`.
/// `minSockPathBytes` pads the home directory name so the socket path is at least that long,
/// independent of where the checkout lives (CI checkouts have much shorter paths than local ones).
func makeTestHome(_ name: String = #function, minSockPathBytes: Int = 0) throws -> AutochatPaths {
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    var id = String(UUID().uuidString.prefix(8))
    let base = package.appendingPathComponent(".build/test-homes")
    let unpadded = AutochatPaths(home: base.appendingPathComponent(id).path).sockPath.utf8.count
    if unpadded < minSockPathBytes { id += String(repeating: "x", count: minSockPathBytes - unpadded) }
    let dir = base.appendingPathComponent(id)
    try FileManager.default.createDirectory(at: dir.appendingPathComponent("run"), withIntermediateDirectories: true)
    return AutochatPaths(home: dir.path)
}

func removeTestHome(_ paths: AutochatPaths) {
    try? FileManager.default.removeItem(atPath: paths.home)
}

/// Waits (polling) until `condition` holds or `timeout` passes.
func eventually(timeout: TimeInterval = 5, _ condition: @Sendable () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return await condition()
}

final class Box<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T
    init(_ value: T) { _value = value }
    var value: T {
        get { lock.withLock { _value } }
        set { lock.withLock { _value = newValue } }
    }
    func mutate(_ f: (inout T) -> Void) { lock.withLock { f(&_value) } }
}

/// In-process stand-in for `autochat daemon`, speaking protocol v1 over a real unix socket.
final class MockDaemonServer: @unchecked Sendable {
    let path: String
    private let lock = NSLock()
    private var listenFD: Int32 = -1
    private var stopped = false
    private var subscribers: [Int32] = []
    private var agentSubscribers: [Int32] = []
    private var messages: [[String: Any]] = []
    private var agentMessages: [[String: Any]] = []
    private var phase = "room"
    private var ack = false
    private(set) var receivedCommands: [[String: Any]] = []
    /// When true, commands are recorded but never answered (to test timeouts).
    var silent = false
    /// When true, behave like a terminal UI / old CLI: one-shot reply then close.
    var oneShotOnly = false
    /// When true, behave like a daemon from before agent rooms: `stream` is ignored.
    var ignoresStream = false

    init(path: String) {
        self.path = path
    }

    func start() throws {
        unlink(path)
        let fd = try UnixSocket.listen(path: path)
        lock.withLock { listenFD = fd }
        let t = Thread { [self] in acceptLoop(fd) }
        t.start()
    }

    func stop() {
        let (fd, subs): (Int32, [Int32]) = lock.withLock {
            stopped = true
            let r = (listenFD, subscribers + agentSubscribers)
            listenFD = -1
            subscribers = []
            agentSubscribers = []
            return r
        }
        for s in subs { Darwin.shutdown(s, SHUT_RDWR) }
        if fd >= 0 { Darwin.close(fd) }
        unlink(path)
    }

    var subscriberCount: Int { lock.withLock { subscribers.count } }
    var agentSubscriberCount: Int { lock.withLock { agentSubscribers.count } }
    var commandNames: [String] { lock.withLock { receivedCommands.compactMap { $0["cmd"] as? String } } }

    func setPhase(_ p: String) {
        lock.withLock { phase = p }
        broadcast()
    }

    func snapshotLine() -> Data {
        let obj: [String: Any] = lock.withLock {
            [
                "type": "state", "v": 1, "phase": phase, "extraTopLevel": ["future": true],
                "room": ["display": "#lobby", "isHost": false, "activeCount": 2],
                "me": ["handle": "stormy-newt-59", "color": 39],
                "members": [
                    ["handle": "jade-lynx-0c", "color": 213, "status": "active", "isHost": true, "you": false],
                    ["handle": "stormy-newt-59", "color": 39, "status": "active", "isHost": false, "you": true]
                ],
                "messages": messages,
                "request": NSNull(), "countdown": NSNull(), "banner": NSNull(), "sessions": []
            ]
        }
        var data = try! JSONSerialization.data(withJSONObject: obj)
        data.append(0x0A)
        return data
    }

    func broadcast() {
        let line = snapshotLine()
        let subs = lock.withLock { subscribers }
        for s in subs { try? UnixSocket.writeAll(s, line) }
    }

    /// An `agents` snapshot: two agents, one thread, and whatever humans said.
    func agentsLine() -> Data {
        let obj: [String: Any] = lock.withLock {
            [
                "type": "agents", "v": 1, "now": 1_730_400_000_000, "tier": "local", "human": "stormy-newt-59", "ack": ack, "future": 1,
                "agents": [
                    ["id": "a1", "name": "copilot-x", "display": "stormy-newt-59/copilot-x", "human": "stormy-newt-59", "harness": "copilot",
                     "repo": "owner/repo", "branch": "feat-x", "state": "editing", "summary": "Refactoring the room", "present": true, "overlaps": ["claude-web"]],
                    ["id": "b2", "name": "claude-web", "display": "stormy-newt-59/claude-web", "human": "stormy-newt-59", "harness": "claude",
                     "repo": "owner/repo", "branch": "main", "state": "testing", "present": false, "overlaps": ["copilot-x"]]
                ],
                "threads": [["id": "t1", "title": "auth token refresh", "opener": "copilot-x", "participants": ["copilot-x", "claude-web"],
                             "status": "open", "outcome": NSNull(), "messages": 1, "openedAt": 1_730_400_000_000, "lastAt": 1_730_400_000_000]],
                "messages": [["seq": 1, "id": "m1", "ts": 1_730_400_000_000, "kind": "question", "thread": "t1", "to": ["claude-web"], "text": "hi?",
                              "from": ["name": "copilot-x", "display": "stormy-newt-59/copilot-x", "human": "stormy-newt-59", "harness": "copilot", "repo": "owner/repo"]]]
                    + agentMessages
            ]
        }
        var data = try! JSONSerialization.data(withJSONObject: obj)
        data.append(0x0A)
        return data
    }

    func broadcastAgents() {
        let line = agentsLine()
        let subs = lock.withLock { agentSubscribers }
        for s in subs { try? UnixSocket.writeAll(s, line) }
    }

    private func acceptLoop(_ fd: Int32) {
        while true {
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let r = poll(&pfd, 1, 50)
            if lock.withLock({ stopped }) { return }
            if r <= 0 { continue }
            let conn = accept(fd, nil, nil)
            if conn < 0 { continue }
            var on: Int32 = 1
            setsockopt(conn, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            Thread { [self] in serve(conn) }.start()
        }
    }

    private func serve(_ conn: Int32) {
        defer {
            lock.withLock {
                subscribers.removeAll { $0 == conn }
                agentSubscribers.removeAll { $0 == conn }
            }
            Darwin.close(conn)
        }
        var lines = LineBuffer(maxLine: 1 << 20)
        var buf = [UInt8](repeating: 0, count: 4096)
        var subscribed = false
        var agentsStream = false
        while true {
            let n = read(conn, &buf, buf.count)
            if n <= 0 { return }
            guard let got = lines.append(Data(buf[0..<n])) else { return }
            for line in got {
                guard let msg = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
                let type = msg["type"] as? String
                if !subscribed {
                    if type == "subscribe", !oneShotOnly {
                        subscribed = true
                        if msg["stream"] as? String == "agents", !ignoresStream {
                            agentsStream = true
                            lock.withLock { agentSubscribers.append(conn) }
                            try? UnixSocket.writeAll(conn, agentsLine())
                            continue
                        }
                        lock.withLock { subscribers.append(conn) }
                        try? UnixSocket.writeAll(conn, snapshotLine())
                        continue
                    }
                    let reply: [String: Any] = type == "ping"
                        ? ["ok": true, "pong": true, "phase": lock.withLock { phase }, "daemon": !oneShotOnly]
                        : ["ok": false]
                    var data = try! JSONSerialization.data(withJSONObject: reply)
                    data.append(0x0A)
                    try? UnixSocket.writeAll(conn, data)
                    return
                }
                guard type == "cmd" else { continue }
                lock.withLock { receivedCommands.append(msg) }
                if silent { continue }
                let id = msg["id"] as? Int ?? -1
                var reply: [String: Any] = ["type": "reply", "id": id, "ok": true]
                var changed = false
                if agentsStream {
                    switch msg["cmd"] as? String {
                    case "agents.ack":
                        lock.withLock { ack = true }
                        reply["result"] = ["ack": true]
                    case "agents.say" where !lock.withLock({ ack }):
                        reply = ["type": "reply", "id": id, "ok": false, "error": "ack-required"]
                    case "agents.say":
                        let human: [String: Any] = ["name": NSNull(), "display": "stormy-newt-59 (human)", "human": "stormy-newt-59", "harness": NSNull(), "repo": NSNull()]
                        lock.withLock {
                            agentMessages.append([
                                "seq": 100 + agentMessages.count, "kind": "human", "intervention": true, "from": human,
                                "thread": msg["thread"] ?? NSNull(), "to": msg["to"] ?? [], "text": msg["text"] as? String ?? ""
                            ])
                        }
                    default:
                        reply = ["type": "reply", "id": id, "ok": false, "error": "unknown command"]
                    }
                    var data = try! JSONSerialization.data(withJSONObject: reply)
                    data.append(0x0A)
                    try? UnixSocket.writeAll(conn, data)
                    broadcastAgents()
                    continue
                }
                switch msg["cmd"] as? String {
                case "say":
                    let text = msg["text"] as? String ?? ""
                    lock.withLock {
                        messages.append(["kind": "chat", "from": "stormy-newt-59", "text": text, "ts": 1_730_400_000_000, "color": 39, "self": true])
                    }
                    changed = true
                case "leaveRoom":
                    reply = ["type": "reply", "id": id, "ok": false, "error": "nope"]
                case "returnNow", "jumpToCopilot", "dismissRequest", "joinNow":
                    break
                default:
                    reply = ["type": "reply", "id": id, "ok": false, "error": "unknown command"]
                }
                var data = try! JSONSerialization.data(withJSONObject: reply)
                data.append(0x0A)
                try? UnixSocket.writeAll(conn, data)
                if changed { broadcast() }
            }
        }
    }
}
