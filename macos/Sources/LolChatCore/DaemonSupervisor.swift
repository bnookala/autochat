import Darwin
import Foundation

/// Owns the `lolchat daemon` process lifecycle for the app:
/// attach to a running daemon if one answers `ping`, otherwise spawn one; restart a spawned
/// daemon that crashes (with backoff); on quit, SIGTERM only a daemon we spawned and give it
/// time to leave the room cleanly. A daemon we merely attached to is never signalled.
@MainActor
public final class DaemonSupervisor {
    public enum Status: Sendable, Equatable {
        case idle
        case starting
        case attached
        case spawned(pid: Int32)
        case restarting(after: TimeInterval, exitCode: Int32)
        case cliMissing
        case failed(String)
        case stopping
        case stopped
    }

    public struct Restart: Sendable, Equatable {
        public var initial: TimeInterval = 1
        public var maximum: TimeInterval = 30
        /// A daemon that ran at least this long resets the backoff.
        public var healthyAfter: TimeInterval = 30

        public init(initial: TimeInterval = 1, maximum: TimeInterval = 30, healthyAfter: TimeInterval = 30) {
            self.initial = initial
            self.maximum = maximum
            self.healthyAfter = healthyAfter
        }

        public func delay(failures: Int) -> TimeInterval {
            min(maximum, initial * pow(2, Double(max(0, failures - 1))))
        }
    }

    public private(set) var status: Status = .idle {
        didSet { if status != oldValue { onStatus?(status) } }
    }
    public var onStatus: ((Status) -> Void)?
    public private(set) var binary: LolchatBinary?

    public let socketPath: String
    public let restart: Restart
    private let locate: @Sendable () -> LolchatBinary?
    private let ping: @Sendable (String) async -> PingReply?
    private let logURL: URL?
    private let spawnEnvironment: [String: String]
    private var child: Process?
    private var spawnedAt = Date.distantPast
    private var failures = 0
    private var stopping = false
    private var ensuring = false
    private var restartTask: Task<Void, Never>?

    public init(
        socketPath: String,
        restart: Restart = Restart(),
        logURL: URL? = nil,
        spawnEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        locate: @escaping @Sendable () -> LolchatBinary? = { DaemonLocator.locate() },
        ping: @escaping @Sendable (String) async -> PingReply? = { await DaemonClient.ping(socketPath: $0) }
    ) {
        self.socketPath = socketPath
        self.restart = restart
        self.logURL = logURL
        self.spawnEnvironment = spawnEnvironment
        self.locate = locate
        self.ping = ping
    }

    /// PID of the daemon this app spawned (nil when attached or not running).
    public var spawnedPID: Int32? {
        guard let child, child.isRunning else { return nil }
        return child.processIdentifier
    }

    public func start() {
        stopping = false
        Task { await ensureDaemon() }
    }

    /// Attach if something answers `ping`; otherwise locate the CLI and spawn `lolchat daemon`.
    public func ensureDaemon() async {
        guard !stopping, !ensuring, spawnedPID == nil else { return }
        ensuring = true
        defer { ensuring = false }
        if case .idle = status { status = .starting }
        if await ping(socketPath) != nil {
            guard !stopping else { return }
            status = .attached
            return
        }
        let locate = self.locate
        let found = await Task.detached { locate() }.value
        guard !stopping else { return }
        guard let found else {
            binary = nil
            status = .cliMissing
            return
        }
        binary = found
        spawn(found)
    }

    /// Call when the app's subscription dropped. If we were attached to someone else's daemon
    /// and it's gone, take over by spawning our own.
    public func connectionLost() {
        guard !stopping, spawnedPID == nil, status == .attached else { return }
        Task {
            try? await Task.sleep(for: .seconds(1))
            if await ping(socketPath) == nil { status = .starting; await ensureDaemon() }
        }
    }

    /// Re-runs discovery (e.g. after the user installed the CLI or set an override).
    public func retry() {
        restartTask?.cancel()
        failures = 0
        if spawnedPID == nil { status = .starting }
        Task { await ensureDaemon() }
    }

    private func spawn(_ bin: LolchatBinary) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: bin.path)
        process.arguments = ["daemon"]
        process.environment = bin.environment(base: spawnEnvironment)
        process.standardInput = FileHandle.nullDevice
        let log = openLog()
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] p in
            let pid = p.processIdentifier
            let code = p.terminationStatus
            let signaled = p.terminationReason == .uncaughtSignal
            Task { @MainActor in self?.childExited(pid: pid, code: code, signaled: signaled) }
        }
        do {
            try process.run()
        } catch {
            status = .failed("Couldn't start \(bin.path): \(error.localizedDescription)")
            scheduleRestart(exitCode: -1)
            return
        }
        child = process
        spawnedAt = Date()
        status = .spawned(pid: process.processIdentifier)
    }

    private func childExited(pid: Int32, code: Int32, signaled: Bool) {
        guard child?.processIdentifier == pid else { return }
        child = nil
        if stopping { return }
        scheduleRestart(exitCode: signaled ? -code : code)
    }

    private func scheduleRestart(exitCode: Int32) {
        if Date().timeIntervalSince(spawnedAt) >= restart.healthyAfter { failures = 0 }
        failures += 1
        let delay = restart.delay(failures: failures)
        status = .restarting(after: delay, exitCode: exitCode)
        restartTask?.cancel()
        restartTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.ensureDaemon()
        }
    }

    /// Clean closeout: SIGTERM a daemon we spawned and wait up to `timeout` for it to leave
    /// the room and exit. Returns true if it exited (or there was nothing to stop).
    @discardableResult
    public func shutdown(timeout: TimeInterval = 3) async -> Bool {
        stopping = true
        restartTask?.cancel()
        guard let child, child.isRunning else {
            status = .stopped
            return true
        }
        status = .stopping
        child.terminate()
        let deadline = Date().addingTimeInterval(timeout)
        while child.isRunning, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        let exited = !child.isRunning
        self.child = nil
        status = .stopped
        return exited
    }

    private func openLog() -> FileHandle {
        guard let logURL else { return FileHandle.nullDevice }
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        guard let handle = try? FileHandle(forWritingTo: logURL) else { return FileHandle.nullDevice }
        handle.seekToEndOfFile()
        handle.write(Data("\n--- \(Date()) lolchat daemon started by LolChat.app ---\n".utf8))
        return handle
    }
}
