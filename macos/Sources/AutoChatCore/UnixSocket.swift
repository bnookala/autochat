import Darwin
import Foundation

/// Minimal blocking unix-domain stream socket helpers.
public enum UnixSocket {
    public struct Failure: Error, Sendable, Equatable, CustomStringConvertible {
        public var op: String
        public var code: Int32
        public var description: String { "\(op): \(String(cString: strerror(code)))" }
    }

    /// Longest path that fits in `sockaddr_un.sun_path` (with its NUL terminator).
    static let maxPathBytes = MemoryLayout.size(ofValue: sockaddr_un().sun_path) - 1

    /// Connects to `path`. Paths longer than `sun_path` are reached relative to their
    /// directory with `connectat(2)`, so deep `AUTOCHAT_HOME`s (e.g. in tests) still work.
    public static func connect(path: String) throws -> Int32 {
        let fd = try makeSocket()
        do {
            try withAddress(path) { dirfd, addr, len in
                atCall("connectat", dirfd, fd, addr, len) == 0 ? nil : Failure(op: "connect", code: errno)
            }
            return fd
        } catch {
            Darwin.close(fd)
            throw error
        }
    }

    /// Binds and listens on `path` (used by tests' in-process mock daemon).
    public static func listen(path: String, backlog: Int32 = 16) throws -> Int32 {
        let fd = try makeSocket()
        do {
            try withAddress(path) { dirfd, addr, len in
                atCall("bindat", dirfd, fd, addr, len) == 0 ? nil : Failure(op: "bind", code: errno)
            }
            guard Darwin.listen(fd, backlog) == 0 else { throw Failure(op: "listen", code: errno) }
            return fd
        } catch {
            Darwin.close(fd)
            throw error
        }
    }

    /// Writes all of `data`, retrying on short writes and EINTR.
    public static func writeAll(_ fd: Int32, _ data: Data) throws {
        try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard var p = raw.baseAddress else { return }
            var left = raw.count
            while left > 0 {
                let n = Darwin.write(fd, p, left)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw Failure(op: "write", code: errno)
                }
                left -= n
                p += n
            }
        }
    }

    public static func setTimeouts(_ fd: Int32, seconds: Double) {
        var tv = timeval(tv_sec: Int(seconds), tv_usec: Int32((seconds - floor(seconds)) * 1_000_000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    private typealias ThreadChdir = @convention(c) (Int32) -> Int32

    /// `bindat`/`connectat` aren't exported on macOS, so long paths are reached relative to a
    /// per-thread working directory (`pthread_fchdir_np`), which never touches the process cwd.
    private static func atCall(_ name: String, _ dirfd: Int32, _ fd: Int32, _ addr: UnsafePointer<sockaddr>, _ len: socklen_t) -> Int32 {
        let call = { name == "bindat" ? Darwin.bind(fd, addr, len) : Darwin.connect(fd, addr, len) }
        if dirfd == AT_FDCWD { return call() }
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "pthread_fchdir_np") else {
            errno = ENAMETOOLONG
            return -1
        }
        let fchdir = unsafeBitCast(sym, to: ThreadChdir.self)
        guard fchdir(dirfd) == 0 else { return -1 }
        let result = call()
        let saved = errno
        _ = fchdir(-1)
        errno = saved
        return result
    }

    private static func makeSocket() throws -> Int32 {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure(op: "socket", code: errno) }
        var on: Int32 = 1
        // Never die of SIGPIPE when the daemon goes away mid-write.
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        return fd
    }

    private static func withAddress(
        _ path: String,
        _ body: (Int32, UnsafePointer<sockaddr>, socklen_t) -> Failure?
    ) throws {
        var dirfd = AT_FDCWD
        var target = path
        if path.utf8.count > maxPathBytes {
            let dir = (path as NSString).deletingLastPathComponent
            dirfd = Darwin.open(dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
            guard dirfd >= 0 else { throw Failure(op: "open \(dir)", code: errno) }
            target = (path as NSString).lastPathComponent
        }
        defer { if dirfd != AT_FDCWD { Darwin.close(dirfd) } }
        let bytes = Array(target.utf8)
        guard bytes.count <= maxPathBytes else { throw Failure(op: "socket path", code: ENAMETOOLONG) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            buf.copyBytes(from: bytes)
            buf[bytes.count] = 0
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.offset(of: \.sun_path)! + bytes.count + 1)
        addr.sun_len = UInt8(len)
        let failure = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body(dirfd, $0, len) }
        }
        if let failure { throw failure }
    }
}

/// Splits a byte stream into newline-terminated lines.
struct LineBuffer {
    private var pending = Data()
    let maxLine: Int

    init(maxLine: Int) {
        self.maxLine = maxLine
    }

    /// Appends bytes and returns complete lines. Returns nil if a line exceeds `maxLine`.
    mutating func append(_ chunk: Data) -> [Data]? {
        pending.append(chunk)
        var lines: [Data] = []
        while let nl = pending.firstIndex(of: 0x0A) {
            let line = pending[pending.startIndex..<nl]
            if !line.isEmpty { lines.append(Data(line)) }
            pending = Data(pending[pending.index(after: nl)...])
        }
        if pending.count > maxLine { return nil }
        return lines
    }
}
