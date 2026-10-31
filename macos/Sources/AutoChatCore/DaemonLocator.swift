import Darwin
import Foundation

/// Where the `autochat` CLI lives, plus a PATH that lets its `#!/usr/bin/env node` shebang
/// resolve (GUI apps start with a bare launchd PATH, so nvm/Homebrew nodes are invisible).
public struct AutochatBinary: Sendable, Equatable {
    public var path: String
    public var searchPath: String

    public init(path: String, searchPath: String) {
        self.path = path
        self.searchPath = searchPath
    }

    /// Environment for spawning the CLI: inherits ours, with the resolved PATH.
    public func environment(base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var env = base
        env["PATH"] = searchPath
        return env
    }
}

public enum DaemonLocator {
    public static let installCommand = "npm i -g github:bnookala/autochat"
    public static let overrideDefaultsKey = "autochatPath"

    /// Resolution order: explicit override (settings), `AUTOCHAT_BIN` (or `LOLCHAT_BIN`), a login shell's
    /// `command -v autochat`, then an interactive login shell (for nvm set up in .zshrc),
    /// then well-known install locations.
    public static func locate(
        override: String? = UserDefaults.standard.string(forKey: overrideDefaultsKey),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        shellTimeout: TimeInterval = 6
    ) -> AutochatBinary? {
        let basePath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        for candidate in [override, AutochatEnvironment.value("BIN", in: environment)] {
            if let raw = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
                let path = (raw as NSString).expandingTildeInPath
                if isExecutable(path) {
                    let shellPath = loginShellLookup(interactive: false, timeout: shellTimeout)?.searchPath
                    return AutochatBinary(path: path, searchPath: mergedPath(binary: path, shellPath: shellPath, basePath: basePath))
                }
            }
        }
        for interactive in [false, true] {
            if let found = loginShellLookup(interactive: interactive, timeout: shellTimeout),
               let bin = found.binary, isExecutable(bin) {
                return AutochatBinary(path: bin, searchPath: mergedPath(binary: bin, shellPath: found.searchPath, basePath: basePath))
            }
        }
        let home = environment["HOME"] ?? NSHomeDirectory()
        var candidates = [
            "/opt/homebrew/bin/autochat", "/usr/local/bin/autochat",
            "\(home)/.npm-global/bin/autochat", "\(home)/.volta/bin/autochat", "\(home)/.local/bin/autochat"
        ]
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            candidates += versions.sorted().reversed().map { "\(nvm)/\($0)/bin/autochat" }
        }
        for path in candidates where isExecutable(path) {
            return AutochatBinary(path: path, searchPath: mergedPath(binary: path, shellPath: nil, basePath: basePath))
        }
        return nil
    }

    static func isExecutable(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
            && FileManager.default.isExecutableFile(atPath: path)
    }

    static func mergedPath(binary: String, shellPath: String?, basePath: String) -> String {
        var parts: [String] = []
        for p in [(binary as NSString).deletingLastPathComponent] + (shellPath ?? "").split(separator: ":").map(String.init)
            + ["/opt/homebrew/bin", "/usr/local/bin"] + basePath.split(separator: ":").map(String.init)
        where !p.isEmpty && !parts.contains(p) {
            parts.append(p)
        }
        return parts.joined(separator: ":")
    }

    struct ShellResult {
        var binary: String?
        var searchPath: String?
    }

    /// `/bin/zsh -lc 'command -v autochat'` (or `-ilc`), with markers so shell banners are ignored.
    static func loginShellLookup(interactive: Bool, timeout: TimeInterval) -> ShellResult? {
        let script = #"printf '\n__AUTOCHAT_BIN__%s\n__AUTOCHAT_PATH__%s\n' "$(command -v autochat 2>/dev/null)" "$PATH""#
        guard let out = run("/bin/zsh", [interactive ? "-ilc" : "-lc", script], timeout: timeout) else { return nil }
        var result = ShellResult()
        for line in out.split(separator: "\n") {
            if line.hasPrefix("__AUTOCHAT_BIN__") {
                let v = String(line.dropFirst("__AUTOCHAT_BIN__".count))
                if v.hasPrefix("/") { result.binary = v }
            } else if line.hasPrefix("__AUTOCHAT_PATH__") {
                let v = String(line.dropFirst("__AUTOCHAT_PATH__".count))
                if !v.isEmpty { result.searchPath = v }
            }
        }
        return result
    }

    /// Runs a short-lived tool and returns its stdout, or nil on failure/timeout.
    public static func run(_ executable: String, _ arguments: [String], environment: [String: String]? = nil, timeout: TimeInterval) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let environment { process.environment = environment }
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        do { try process.run() } catch { return nil }
        let reader = pipe.fileHandleForReading
        let output = OutputBox()
        let readDone = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            output.data = reader.readDataToEndOfFile()
            readDone.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            if done.wait(timeout: .now() + 1) == .timedOut { kill(process.processIdentifier, SIGKILL) }
            _ = readDone.wait(timeout: .now() + 1)
            return nil
        }
        _ = readDone.wait(timeout: .now() + 2)
        guard process.terminationStatus == 0 else { return nil }
        return String(decoding: output.data, as: UTF8.self)
    }

    private final class OutputBox: @unchecked Sendable {
        var data = Data()
    }
}
