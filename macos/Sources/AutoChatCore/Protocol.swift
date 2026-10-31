import Foundation

/// Client → daemon commands on a subscribed connection.
public enum Command: Sendable, Equatable {
    case say(String)
    case returnNow
    case leaveRoom
    case jumpToCopilot
    case dismissRequest
    case joinNow

    public var name: String {
        switch self {
        case .say: "say"
        case .returnNow: "returnNow"
        case .leaveRoom: "leaveRoom"
        case .jumpToCopilot: "jumpToCopilot"
        case .dismissRequest: "dismissRequest"
        case .joinNow: "joinNow"
        }
    }

    /// `{"type":"cmd","id":7,"cmd":"say","text":"lol same"}`
    public func encodedLine(id: Int) -> Data {
        struct Envelope: Encodable {
            let type = "cmd"
            let id: Int
            let cmd: String
            let text: String?
        }
        var text: String?
        if case let .say(t) = self { text = t }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = (try? encoder.encode(Envelope(id: id, cmd: name, text: text))) ?? Data()
        data.append(0x0A)
        return data
    }
}

/// `{"type":"reply","id":7,"ok":true}` or `{"type":"reply","id":7,"ok":false,"error":"…"}`.
public struct Reply: Sendable, Equatable {
    public var id: Int
    public var ok: Bool
    public var error: String?

    public init(id: Int, ok: Bool, error: String? = nil) {
        self.id = id
        self.ok = ok
        self.error = error
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
        case "reply":
            guard let id = head.id else { return .invalid }
            return .reply(Reply(id: id, ok: head.ok ?? (head.error == nil), error: head.error))
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

enum Wire {
    static let subscribe: Data = line(["type": "subscribe", "v": 1, "client": "macos-app"])
    static let ping: Data = line(["type": "ping"])

    private static func line(_ object: [String: Any]) -> Data {
        var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        data.append(0x0A)
        return data
    }
}
