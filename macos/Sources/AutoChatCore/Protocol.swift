import Foundation

/// Client → daemon commands on a subscribed connection. The `agents.*` commands only work on
/// an agents-stream connection (`DaemonClient(stream: .agents)`).
public enum Command: Sendable, Equatable {
    case say(String)
    case returnNow
    case leaveRoom
    case jumpToCopilot
    case dismissRequest
    case joinNow
    /// The human read the intervention warning (persisted by the daemon).
    case agentsAck
    /// A human intervention in the agent room: `thread` nil is the main stream.
    case agentsSay(text: String, thread: String?, to: [String])
    /// Focus the terminal of the agent behind an attention item (its `id`).
    case jumpTo(String)
    /// Drop an attention item from the queue.
    case dismissAttention(String)
    /// What Connect agents… would do for each harness (issue #65): `result: {plans}`.
    case agentsSetupPlan
    /// Connect these harnesses (their ids) to the agent room: `result: {applied, failed}`.
    case agentsSetup(harnesses: [String])

    public var name: String {
        switch self {
        case .say: "say"
        case .returnNow: "returnNow"
        case .leaveRoom: "leaveRoom"
        case .jumpToCopilot: "jumpToCopilot"
        case .dismissRequest: "dismissRequest"
        case .joinNow: "joinNow"
        case .agentsAck: "agents.ack"
        case .agentsSay: "agents.say"
        case .jumpTo: "jumpTo"
        case .dismissAttention: "dismissAttention"
        case .agentsSetupPlan: "agents.setupPlan"
        case .agentsSetup: "agents.setup"
        }
    }

    /// `{"type":"cmd","id":7,"cmd":"say","text":"lol same"}`, for an intervention
    /// `{"type":"cmd","id":2,"cmd":"agents.say","text":"…","thread":null,"to":[]}`, for the
    /// attention queue `{"type":"cmd","id":3,"cmd":"jumpTo","item":"7"}` (`id` is the command's),
    /// and for Connect agents… `{"type":"cmd","id":4,"cmd":"agents.setup","harnesses":["codex"]}`.
    public func encodedLine(id: Int) -> Data {
        struct Envelope: Encodable {
            let type = "cmd"
            let id: Int
            let cmd: String
            let text: String?
            var item: String?
            var harnesses: [String]?
        }
        struct SayEnvelope: Encodable {
            let id: Int
            let cmd: String
            let text: String
            let thread: String?
            let to: [String]

            enum CodingKeys: String, CodingKey { case type, id, cmd, text, thread, to }

            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode("cmd", forKey: .type)
                try c.encode(id, forKey: .id)
                try c.encode(cmd, forKey: .cmd)
                try c.encode(text, forKey: .text)
                // An explicit null: the main stream.
                try c.encode(thread, forKey: .thread)
                try c.encode(to, forKey: .to)
            }
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data: Data
        switch self {
        case let .agentsSay(text, thread, to):
            data = (try? encoder.encode(SayEnvelope(id: id, cmd: name, text: text, thread: thread, to: to))) ?? Data()
        case let .say(text):
            data = (try? encoder.encode(Envelope(id: id, cmd: name, text: text))) ?? Data()
        case let .jumpTo(item), let .dismissAttention(item):
            data = (try? encoder.encode(Envelope(id: id, cmd: name, text: nil, item: item))) ?? Data()
        case let .agentsSetup(harnesses):
            data = (try? encoder.encode(Envelope(id: id, cmd: name, text: nil, harnesses: harnesses))) ?? Data()
        default:
            data = (try? encoder.encode(Envelope(id: id, cmd: name, text: nil))) ?? Data()
        }
        data.append(0x0A)
        return data
    }
}

/// `{"type":"reply","id":7,"ok":true}` or `{"type":"reply","id":7,"ok":false,"error":"…"}`,
/// with the command's `result` when it returns one.
public struct Reply: Sendable, Equatable {
    public var id: Int
    public var ok: Bool
    public var error: String?
    /// What the command returned (`agents.setupPlan`'s plans, say), to decode with `decode`.
    public var result: JSONValue?

    public init(id: Int, ok: Bool, error: String? = nil, result: JSONValue? = nil) {
        self.id = id
        self.ok = ok
        self.error = error
        self.result = result
    }
}

/// Any JSON value: a reply's `result`, kept as it came until someone knows what it is.
public enum JSONValue: Sendable, Equatable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case let .bool(b): try c.encode(b)
        case let .number(n): try c.encode(n)
        case let .string(s): try c.encode(s)
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
        }
    }

    /// This value as a `T` (types here decode leniently), or nil.
    public func decode<T: Decodable>(_ type: T.Type) -> T? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

/// One-shot `{"type":"ping"}` answer: `{"ok":true,"pong":true,"phase":…,"daemon":true}`.
public struct PingReply: Sendable, Equatable {
    public var phase: Phase
    /// `true` for `autochat daemon`; a terminal UI answers without it.
    public var isDaemon: Bool

    public init(phase: Phase, isDaemon: Bool) {
        self.phase = phase
        self.isDaemon = isDaemon
    }
}

public enum CommandError: Error, Sendable, Equatable, LocalizedError {
    case notConnected
    case timedOut
    case disconnected
    case rejected(String)

    public var errorDescription: String? {
        switch self {
        case .notConnected: "Not connected to autochat"
        case .timedOut: "autochat didn't answer in time"
        case .disconnected: "Lost the connection to autochat"
        case let .rejected(why): why
        }
    }
}

/// A decoded daemon → client line.
public enum Inbound: Sendable, Equatable {
    case state(Snapshot)
    /// A snapshot of the local agent room (agents-stream subscriptions only).
    case agents(AgentsSnapshot)
    case reply(Reply)
    /// A line without `type`: a one-shot answer (e.g. an older UI that doesn't support subscribe).
    case oneShot(ok: Bool, error: String?)
    /// `{"type":"error","error":"too many subscribers"}`: a refused subscription.
    case refused(String)
    case other(String)
    case invalid

    public static func parse(_ line: Data) -> Inbound {
        struct Head: Decodable {
            var type: String?
            var id: Int?
            var ok: Bool?
            var error: String?

            enum CodingKeys: String, CodingKey { case type, id, ok, error }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                type = c.lenient(String.self, .type)
                id = c.lenientInt(.id)
                ok = c.lenient(Bool.self, .ok)
                error = c.lenient(String.self, .error)
            }
        }
        let decoder = JSONDecoder()
        guard let head = try? decoder.decode(Head.self, from: line) else { return .invalid }
        switch head.type {
        case "state":
            guard let snap = try? decoder.decode(Snapshot.self, from: line) else { return .invalid }
            return .state(snap)
        case "agents":
            guard let snap = try? decoder.decode(AgentsSnapshot.self, from: line) else { return .invalid }
            return .agents(snap)
        case "reply":
            guard let id = head.id else { return .invalid }
            let result = (try? decoder.decode(ReplyResult.self, from: line))?.result
            return .reply(Reply(id: id, ok: head.ok ?? (head.error == nil), error: head.error, result: result))
        case nil:
            return .oneShot(ok: head.ok ?? false, error: head.error)
        case "error":
            return .refused(head.error ?? "refused")
        case let other?:
            return .other(other)
        }
    }

    static func parsePing(_ line: Data) -> PingReply? {
        struct Pong: Decodable {
            var pong: Bool?
            var phase: String?
            var daemon: Bool?

            enum CodingKeys: String, CodingKey { case pong, phase, daemon }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                pong = c.lenient(Bool.self, .pong)
                phase = c.lenient(String.self, .phase)
                daemon = c.lenient(Bool.self, .daemon)
            }
        }
        guard let p = try? JSONDecoder().decode(Pong.self, from: line), p.pong == true else { return nil }
        return PingReply(phase: Phase(raw: p.phase), isDaemon: p.daemon ?? false)
    }
}

/// A reply's `result`, if any.
private struct ReplyResult: Decodable {
    var result: JSONValue?

    enum CodingKeys: String, CodingKey { case result }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        result = c.lenient(JSONValue.self, .result)
    }
}

enum Wire {
    static let subscribe: Data = line(["type": "subscribe", "v": 1, "client": "macos-app"])
    static let subscribeAgents: Data = line(["type": "subscribe", "v": 1, "client": "macos-app", "stream": "agents"])
    static let ping: Data = line(["type": "ping"])

    /// The lounge subscription stays exactly as before (no `stream`), so older daemons accept it.
    static func subscribe(_ stream: DaemonClient.Stream) -> Data {
        stream == .agents ? subscribeAgents : subscribe
    }

    private static func line(_ object: [String: Any]) -> Data {
        var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        data.append(0x0A)
        return data
    }
}
