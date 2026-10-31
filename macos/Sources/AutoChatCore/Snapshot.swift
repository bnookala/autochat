import Foundation

// Models for the v1 daemon protocol (issue #2, docs/protocol.md). Decoding is deliberately
// lenient: unknown fields are ignored, missing or malformed optional fields become nil, and a
// bad element in a list is skipped instead of failing the whole snapshot.

public enum Phase: Sendable, Equatable, Hashable {
    case lounge, room, spectating, reality, dead, left
    case unknown(String)

    public init(raw: String?) {
        switch raw {
        case "lounge", nil: self = .lounge
        case "room": self = .room
        case "spectating": self = .spectating
        case "reality": self = .reality
        case "dead": self = .dead
        case "left": self = .left
        case let other?: self = .unknown(other)
        }
    }

    /// In a room (autopilot, or spectating as host).
    public var isInRoom: Bool { self == .room || self == .spectating }
    /// Showing a closeout banner.
    public var isCloseout: Bool { self == .reality || self == .dead || self == .left }
}

/// A handle color: the core uses xterm-256 palette indices; also accept `#rrggbb` strings.
public enum HandleColor: Sendable, Equatable, Hashable, Decodable {
    case xterm(Int)
    case rgb(UInt8, UInt8, UInt8)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Int.self) {
            self = .xterm(n)
            return
        }
        if let d = try? c.decode(Double.self), d.isFinite {
            self = .xterm(Int(d))
            return
        }
        let s = try c.decode(String.self)
        guard let parsed = HandleColor(string: s) else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "unrecognized color \(s)")
        }
        self = parsed
    }

    public init?(string: String) {
        let t = string.trimmingCharacters(in: .whitespaces)
        if let n = Int(t) {
            self = .xterm(n)
            return
        }
        var hex = Substring(t)
        if hex.hasPrefix("#") { hex = hex.dropFirst() }
        if hex.count == 3 { hex = Substring(hex.map { "\($0)\($0)" }.joined()) }
        guard hex.count == 6, let v = UInt32(hex, radix: 16) else { return nil }
        self = .rgb(UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff))
    }

    /// sRGB components in 0...1.
    public var components: (r: Double, g: Double, b: Double) {
        switch self {
        case let .rgb(r, g, b):
            return (Double(r) / 255, Double(g) / 255, Double(b) / 255)
        case let .xterm(i):
            let (r, g, b) = HandleColor.xterm256(i)
            return (Double(r) / 255, Double(g) / 255, Double(b) / 255)
        }
    }

    static func xterm256(_ index: Int) -> (Int, Int, Int) {
        let i = min(max(index, 0), 255)
        let base: [(Int, Int, Int)] = [
            (0, 0, 0), (205, 49, 49), (13, 188, 121), (229, 229, 16), (36, 114, 200), (188, 63, 188), (17, 168, 205), (229, 229, 229),
            (102, 102, 102), (241, 76, 76), (35, 209, 139), (245, 245, 67), (59, 142, 234), (214, 112, 214), (41, 184, 219), (255, 255, 255)
        ]
        if i < 16 { return base[i] }
        if i >= 232 {
            let v = 8 + (i - 232) * 10
            return (v, v, v)
        }
        let levels = [0, 95, 135, 175, 215, 255]
        let n = i - 16
        return (levels[n / 36], levels[(n / 6) % 6], levels[n % 6])
    }
}

public struct RoomInfo: Sendable, Equatable, Decodable {
    public var display: String?
    public var code: String?
    public var isHost: Bool?
    public var activeCount: Int?
    public var host: String?
    public var mates: Int?

    public init(display: String? = nil, code: String? = nil, isHost: Bool? = nil, activeCount: Int? = nil, host: String? = nil, mates: Int? = nil) {
        self.display = display
        self.code = code
        self.isHost = isHost
        self.activeCount = activeCount
        self.host = host
        self.mates = mates
    }

    enum CodingKeys: String, CodingKey { case display, code, name, isHost, host, hostHandle, activeCount, active, mates, peers }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        display = c.lenient(String.self, .display) ?? c.lenient(String.self, .name)
        code = c.lenient(String.self, .code)
        isHost = c.lenient(Bool.self, .isHost)
        activeCount = c.lenientInt(.activeCount) ?? c.lenientInt(.active)
        host = c.lenient(String.self, .hostHandle) ?? c.lenient(String.self, .host)
        mates = c.lenientInt(.mates) ?? c.lenientInt(.peers)
    }
}

public struct Me: Sendable, Equatable, Decodable {
    public var handle: String?
    public var color: HandleColor?

    public init(handle: String? = nil, color: HandleColor? = nil) {
        self.handle = handle
        self.color = color
    }

    enum CodingKeys: String, CodingKey { case handle, color }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = c.lenient(String.self, .handle)
        color = c.lenient(HandleColor.self, .color)
    }
}

public enum MemberStatus: Sendable, Equatable, Hashable {
    case active, needed, away
    case unknown(String)

    public init(raw: String?) {
        switch raw {
        case "active", nil: self = .active
        case "needed": self = .needed
        case "away", "spectating": self = .away
        case let other?: self = .unknown(other)
        }
    }
}

public struct Member: Sendable, Equatable, Decodable {
    public var handle: String
    public var color: HandleColor?
    public var status: MemberStatus
    public var isHost: Bool
    public var isYou: Bool

    public init(handle: String, color: HandleColor? = nil, status: MemberStatus = .active, isHost: Bool = false, isYou: Bool = false) {
        self.handle = handle
        self.color = color
        self.status = status
        self.isHost = isHost
        self.isYou = isYou
    }

    enum CodingKeys: String, CodingKey { case handle, color, status, needed, isHost, host, you, isYou, `self` }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let handle = c.lenient(String.self, .handle), !handle.isEmpty else {
            throw DecodingError.keyNotFound(CodingKeys.handle, .init(codingPath: c.codingPath, debugDescription: "member without handle"))
        }
        self.handle = handle
        color = c.lenient(HandleColor.self, .color)
        status = MemberStatus(raw: c.lenient(String.self, .status))
        // The core keeps `status: active` and flags a pending Copilot question separately.
        if c.lenient(Bool.self, .needed) == true, status != .away { status = .needed }
        isHost = c.lenient(Bool.self, .isHost) ?? c.lenient(Bool.self, .host) ?? false
        isYou = c.lenient(Bool.self, .you) ?? c.lenient(Bool.self, .isYou) ?? c.lenient(Bool.self, .`self`) ?? false
    }
}

public enum MessageKind: Sendable, Equatable, Hashable {
    case chat, sys
    case unknown(String)

    public init(raw: String?) {
        switch raw {
        case "chat", nil: self = .chat
        case "sys": self = .sys
        case let other?: self = .unknown(other)
        }
    }
}

public struct ChatMessage: Sendable, Equatable, Decodable {
    public var kind: MessageKind
    public var from: String?
    public var text: String
    public var ts: Date?
    public var color: HandleColor?
    public var isSelf: Bool
    public var mid: String?

    public init(kind: MessageKind = .chat, from: String? = nil, text: String, ts: Date? = nil, color: HandleColor? = nil, isSelf: Bool = false, mid: String? = nil) {
        self.kind = kind
        self.from = from
        self.text = text
        self.ts = ts
        self.color = color
        self.isSelf = isSelf
        self.mid = mid
    }

    enum CodingKeys: String, CodingKey { case kind, from, handle, text, ts, color, you, isSelf, `self`, mid, id }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = MessageKind(raw: c.lenient(String.self, .kind))
        // The core's room events carry `from` as a public key and `handle` as the display name.
        from = c.lenient(String.self, .handle) ?? c.lenient(String.self, .from)
        text = c.lenient(String.self, .text) ?? ""
        ts = c.lenientDouble(.ts).map { Date(timeIntervalSince1970: $0 / 1000) }
        color = c.lenient(HandleColor.self, .color)
        isSelf = c.lenient(Bool.self, .you) ?? c.lenient(Bool.self, .isSelf) ?? c.lenient(Bool.self, .`self`) ?? false
        mid = c.lenient(String.self, .mid) ?? c.lenientInt(.id).map(String.init) ?? c.lenient(String.self, .id)
    }
}

public struct CopilotRequest: Sendable, Equatable, Decodable {
    public var sid: String?
    public var cwd: String?
    public var title: String?
    public var message: String?
    public var resolved: Bool

    public init(sid: String? = nil, cwd: String? = nil, title: String? = nil, message: String? = nil, resolved: Bool = false) {
        self.sid = sid
        self.cwd = cwd
        self.title = title
        self.message = message
        self.resolved = resolved
    }

    enum CodingKeys: String, CodingKey { case sid, cwd, title, message, resolved }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sid = c.lenient(String.self, .sid)
        cwd = c.lenient(String.self, .cwd)
        title = c.lenient(String.self, .title)
        message = c.lenient(String.self, .message)
        resolved = c.lenient(Bool.self, .resolved) ?? false
    }

    /// Identifies "the same question" so a dismissal sticks until a new one arrives.
    public var key: String { "\(sid ?? "")|\(title ?? "")|\(message ?? "")" }
}

public struct SessionInfo: Sendable, Equatable, Decodable {
    public var sid: String?
    public var state: String?
    public var cwd: String?

    public init(sid: String? = nil, state: String? = nil, cwd: String? = nil) {
        self.sid = sid
        self.state = state
        self.cwd = cwd
    }

    enum CodingKeys: String, CodingKey { case sid, state, cwd }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sid = c.lenient(String.self, .sid)
        state = c.lenient(String.self, .state)
        cwd = c.lenient(String.self, .cwd)
    }
}

public struct Countdown: Sendable, Equatable, Decodable {
    public var endsAt: Date
    public var total: Int?
    public var reason: String?
    public var summary: String?
    public var cwd: String?

    public init(endsAt: Date, total: Int? = nil, reason: String? = nil, summary: String? = nil, cwd: String? = nil) {
        self.endsAt = endsAt
        self.total = total
        self.reason = reason
        self.summary = summary
        self.cwd = cwd
    }

    enum CodingKeys: String, CodingKey { case endsAt, total, reason, summary, cwd }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let ms = c.lenientDouble(.endsAt) else {
            throw DecodingError.keyNotFound(CodingKeys.endsAt, .init(codingPath: c.codingPath, debugDescription: "countdown without endsAt"))
        }
        endsAt = Date(timeIntervalSince1970: ms / 1000)
        total = c.lenientInt(.total)
        reason = c.lenient(String.self, .reason)
        summary = c.lenient(String.self, .summary)
        cwd = c.lenient(String.self, .cwd)
    }
}

public enum BannerKind: Sendable, Equatable, Hashable {
    case reality, dead, left
    case unknown(String)

    public init(raw: String?) {
        switch raw {
        case "reality", nil: self = .reality
        case "dead": self = .dead
        case "left": self = .left
        case let other?: self = .unknown(other)
        }
    }
}

public struct Banner: Sendable, Equatable, Decodable {
    public var kind: BannerKind
    public var reason: String?
    public var summary: String?
    public var cwd: String?

    public init(kind: BannerKind, reason: String? = nil, summary: String? = nil, cwd: String? = nil) {
        self.kind = kind
        self.reason = reason
        self.summary = summary
        self.cwd = cwd
    }

    enum CodingKeys: String, CodingKey { case kind, reason, summary, cwd }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = BannerKind(raw: c.lenient(String.self, .kind))
        reason = c.lenient(String.self, .reason)
        summary = c.lenient(String.self, .summary)
        cwd = c.lenient(String.self, .cwd)
    }
}

/// One `{"type":"state"}` line from the daemon.
public struct Snapshot: Sendable, Equatable, Decodable {
    public var version: Int?
    /// The daemon's clock when it built the snapshot.
    public var now: Date?
    public var phase: Phase
    public var room: RoomInfo?
    public var me: Me?
    public var members: [Member]
    public var messages: [ChatMessage]
    public var request: CopilotRequest?
    public var sessions: [SessionInfo]
    public var countdown: Countdown?
    public var banner: Banner?

    public init(
        version: Int? = 1, now: Date? = nil, phase: Phase = .lounge, room: RoomInfo? = nil, me: Me? = nil, members: [Member] = [],
        messages: [ChatMessage] = [], request: CopilotRequest? = nil, sessions: [SessionInfo] = [],
        countdown: Countdown? = nil, banner: Banner? = nil
    ) {
        self.version = version
        self.now = now
        self.phase = phase
        self.room = room
        self.me = me
        self.members = members
        self.messages = messages
        self.request = request
        self.sessions = sessions
        self.countdown = countdown
        self.banner = banner
    }

    enum CodingKeys: String, CodingKey { case v, now, phase, room, me, members, messages, request, sessions, countdown, banner }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.lenientInt(.v)
        now = c.lenientDouble(.now).map { Date(timeIntervalSince1970: $0 / 1000) }
        phase = Phase(raw: c.lenient(String.self, .phase))
        room = c.lenient(RoomInfo.self, .room)
        me = c.lenient(Me.self, .me)
        members = c.lenient(LossyList<Member>.self, .members)?.items ?? []
        messages = c.lenient(LossyList<ChatMessage>.self, .messages)?.items ?? []
        request = c.lenient(CopilotRequest.self, .request)
        sessions = c.lenient(LossyList<SessionInfo>.self, .sessions)?.items ?? []
        countdown = c.lenient(Countdown.self, .countdown)
        banner = c.lenient(Banner.self, .banner)
    }

    /// Host handle from the room info, else from the member flagged as host.
    public var hostHandle: String? {
        room?.host ?? members.first(where: { $0.isHost })?.handle
    }

    public var isHost: Bool {
        room?.isHost ?? members.first(where: { $0.isYou })?.isHost ?? false
    }

    public var activeCount: Int {
        room?.activeCount ?? members.filter { $0.status != .away }.count
    }

    /// The same snapshot with the countdown moved onto the local clock, using the daemon's
    /// `now` (the protocol's advice for avoiding clock skew).
    public func alignedToLocalClock(receivedAt local: Date) -> Snapshot {
        guard let daemonNow = now, var c = countdown else { return self }
        var copy = self
        c.endsAt = c.endsAt.addingTimeInterval(local.timeIntervalSince(daemonNow))
        copy.countdown = c
        return copy
    }
}

// MARK: - Lenient decoding helpers

struct LossyList<Element: Decodable>: Decodable {
    var items: [Element]

    private struct Skip: Decodable {
        init(from decoder: Decoder) throws {}
    }

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !c.isAtEnd {
            if let v = try? c.decode(Element.self) {
                out.append(v)
            } else if (try? c.decode(Skip.self)) == nil {
                break
            }
        }
        items = out
    }
}

extension KeyedDecodingContainer {
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        guard contains(key) else { return nil }
        return (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    func lenientDouble(_ key: Key) -> Double? {
        if let d = lenient(Double.self, key), d.isFinite { return d }
        if let s = lenient(String.self, key), let d = Double(s), d.isFinite { return d }
        return nil
    }

    func lenientInt(_ key: Key) -> Int? {
        if let i = lenient(Int.self, key) { return i }
        if let d = lenientDouble(key), d >= Double(Int.min), d <= Double(Int.max) { return Int(d) }
        return nil
    }
}
