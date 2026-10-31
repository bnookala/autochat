import Darwin
import Foundation

/// Persistent subscription to `lolchat daemon` over its unix socket (protocol v1, issue #2).
///
/// Connects, sends `subscribe`, decodes `state` snapshots, sends `cmd`s with ids and matches
/// `reply`s. Reconnects with backoff until `stop()`. Callbacks run on `callbackQueue`.
public final class DaemonClient: @unchecked Sendable {
    public enum State: Sendable, Equatable {
        case idle
        case connecting
        case connected
        case disconnected(String?)
        /// Something answered on the socket but doesn't speak the subscribe protocol
        /// (e.g. a terminal `lolchat ui`, or a CLI older than the daemon).
        case incompatible(String)
    }

    public struct Backoff: Sendable, Equatable {
        public var initial: TimeInterval
        public var maximum: TimeInterval
        public var multiplier: Double

        public init(initial: TimeInterval = 0.25, maximum: TimeInterval = 5, multiplier: Double = 2) {
            self.initial = initial
            self.maximum = maximum
            self.multiplier = multiplier
        }

        public func delay(attempt: Int) -> TimeInterval {
            min(maximum, initial * pow(multiplier, Double(max(0, attempt))))
        }
    }

    public let socketPath: String
    public let backoff: Backoff
    public let commandTimeout: TimeInterval
    static let maxLine = 16 * 1024 * 1024

    private let callbackQueue: DispatchQueue
    private let writeQueue = DispatchQueue(label: "com.bnookala.lolchat.daemon-client.write")
    private let lock = NSLock()
    private let wake = NSCondition()

    // Guarded by `lock`.
    private var fd: Int32 = -1
    private var running = false
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<Reply, Error>] = [:]
    private var state: State = .idle
    private var onSnapshot: (@Sendable (Snapshot) -> Void)?
    private var onState: (@Sendable (State) -> Void)?

    public init(
        socketPath: String,
        callbackQueue: DispatchQueue = .main,
        backoff: Backoff = Backoff(),
        commandTimeout: TimeInterval = 5
    ) {
        self.socketPath = socketPath
        self.callbackQueue = callbackQueue
        self.backoff = backoff
        self.commandTimeout = commandTimeout
    }

    deinit {
        stop()
    }

    public func setHandlers(
        onSnapshot: (@Sendable (Snapshot) -> Void)?,
        onState: (@Sendable (State) -> Void)? = nil
    ) {
        lock.withLock {
            self.onSnapshot = onSnapshot
            self.onState = onState
        }
    }

    public var currentState: State { lock.withLock { state } }

    public func start() {
        let shouldStart: Bool = lock.withLock {
            if running { return false }
            running = true
            return true
        }
        guard shouldStart else { return }
        let thread = Thread { [weak self] in self?.run() }
        thread.name = "lolchat-daemon-client"
        thread.start()
    }

    /// Stops reconnecting, closes the connection and fails pending commands.
    public func stop() {
        let current: Int32 = lock.withLock {
            running = false
            return fd
        }
        if current >= 0 { Darwin.shutdown(current, SHUT_RDWR) }
        wake.lock()
        wake.broadcast()
        wake.unlock()
    }

    /// Nudges a client that is waiting out its backoff to retry now.
    public func reconnectNow() {
        wake.lock()
        wake.broadcast()
        wake.unlock()
    }

    /// Sends a command and waits for its `reply`. Throws only for transport problems;
    /// a daemon refusal comes back as `Reply(ok: false, error: …)`.
    public func send(_ command: Command, timeout: TimeInterval? = nil) async throws -> Reply {
        let (id, connected): (Int, Bool) = lock.withLock {
            let id = nextID
            nextID += 1
            return (id, fd >= 0 && state == .connected)
        }
        guard connected else { throw CommandError.notConnected }
        let line = command.encodedLine(id: id)
        let wait = timeout ?? commandTimeout
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Reply, Error>) in
            lock.withLock { pending[id] = cont }
            writeQueue.async { [weak self] in
                guard let self else { return }
                let ok: Bool = self.lock.withLock {
                    guard self.fd >= 0 else { return false }
                    return (try? UnixSocket.writeAll(self.fd, line)) != nil
                }
                if !ok { self.resolve(id, .failure(CommandError.disconnected)) }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + wait) { [weak self] in
                self?.resolve(id, .failure(CommandError.timedOut))
            }
        }
    }

    /// One-shot `{"type":"ping"}`. Returns nil when nothing answers on the socket.
    public static func ping(socketPath: String, timeout: TimeInterval = 0.5) async -> PingReply? {
        await withCheckedContinuation { cont in
            DispatchQueue.global().async {
                cont.resume(returning: pingSync(socketPath: socketPath, timeout: timeout))
            }
        }
    }

    public static func pingSync(socketPath: String, timeout: TimeInterval = 0.5) -> PingReply? {
        guard let fd = try? UnixSocket.connect(path: socketPath) else { return nil }
        defer { Darwin.close(fd) }
        UnixSocket.setTimeouts(fd, seconds: timeout)
        guard (try? UnixSocket.writeAll(fd, Wire.ping)) != nil else { return nil }
        var lines = LineBuffer(maxLine: 64 * 1024)
        var buf = [UInt8](repeating: 0, count: 4096)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let n = Darwin.read(fd, &buf, buf.count)
            if n < 0, errno == EINTR { continue }
            if n <= 0 { return nil }
            guard let got = lines.append(Data(buf[0..<n])) else { return nil }
            if let first = got.first { return Inbound.parsePing(first) }
        }
        return nil
    }

    // MARK: - Connection loop (dedicated thread)

    private func run() {
        var attempt = 0
        while isRunning {
            setState(.connecting)
            let conn: Int32
            do {
                conn = try UnixSocket.connect(path: socketPath)
            } catch {
                setState(.disconnected(String(describing: error)))
                sleep(backoff.delay(attempt: attempt))
                attempt += 1
                continue
            }
            let accepted: Bool = lock.withLock {
                guard running else { return false }
                fd = conn
                return true
            }
            guard accepted else {
                Darwin.close(conn)
                break
            }
            let outcome = readLoop(conn) { attempt = 0 }
            lock.withLock { fd = -1 }
            Darwin.close(conn)
            failPending(CommandError.disconnected)
            guard isRunning else { break }
            switch outcome {
            case let .incompatible(why):
                setState(.incompatible(why))
                sleep(max(backoff.maximum, 2))
            case let .closed(why):
                setState(.disconnected(why))
                sleep(backoff.delay(attempt: attempt))
                attempt += 1
            }
        }
        failPending(CommandError.disconnected)
        setState(.idle)
    }

    private enum Outcome {
        case closed(String?)
        case incompatible(String)
    }

    private func readLoop(_ conn: Int32, onSubscribed: () -> Void) -> Outcome {
        let subscribed = lock.withLock { (try? UnixSocket.writeAll(conn, Wire.subscribe)) != nil }
        guard subscribed else { return .closed("couldn't subscribe") }
        var lines = LineBuffer(maxLine: Self.maxLine)
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        var gotState = false
        while true {
            let n = Darwin.read(conn, &buf, buf.count)
            if n < 0, errno == EINTR { continue }
            if n <= 0 {
                return .closed(n == 0 ? "daemon closed the connection" : String(cString: strerror(errno)))
            }
            guard let got = lines.append(Data(buf[0..<n])) else { return .closed("line too long") }
            for line in got {
                switch Inbound.parse(line) {
                case let .state(snapshot):
                    if !gotState {
                        gotState = true
                        onSubscribed()
                        setState(.connected)
                    }
                    deliver(snapshot)
                case let .reply(reply):
                    resolve(reply.id, .success(reply))
                case let .oneShot(_, error) where !gotState:
                    return .incompatible(error ?? "lolchat on this socket doesn't support the app (is it a terminal UI or an older CLI?)")
                case let .refused(why) where !gotState:
                    return .incompatible("lolchat refused the subscription: \(why)")
                case .oneShot, .refused, .other, .invalid:
                    continue
                }
            }
        }
    }

    // MARK: - Helpers

    private var isRunning: Bool { lock.withLock { running } }

    private func sleep(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        wake.lock()
        defer { wake.unlock() }
        if isRunning, Date() < until {
            _ = wake.wait(until: until)
        }
    }

    private func setState(_ next: State) {
        let handler: (@Sendable (State) -> Void)? = lock.withLock {
            guard state != next else { return nil }
            state = next
            return onState
        }
        guard let handler else { return }
        callbackQueue.async { handler(next) }
    }

    private func deliver(_ snapshot: Snapshot) {
        guard let handler = lock.withLock({ onSnapshot }) else { return }
        callbackQueue.async { handler(snapshot) }
    }

    private func resolve(_ id: Int, _ result: Result<Reply, Error>) {
        guard let cont = lock.withLock({ pending.removeValue(forKey: id) }) else { return }
        cont.resume(with: result)
    }

    private func failPending(_ error: CommandError) {
        let all: [CheckedContinuation<Reply, Error>] = lock.withLock {
            let values = Array(pending.values)
            pending.removeAll()
            return values
        }
        for cont in all { cont.resume(throwing: error) }
    }
}
