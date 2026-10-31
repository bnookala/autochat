import Foundation

/// Mirrors `src/env.js`: `AUTOCHAT_<name>`, falling back to `LOLCHAT_<name>` from before the
/// lolchat → autochat rename. A set `AUTOCHAT_` variable (even an empty one) always wins.
public enum AutochatEnvironment {
    public static func value(_ name: String, in environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        environment["AUTOCHAT_" + name] ?? environment["LOLCHAT_" + name]
    }
}

/// Mirrors `src/paths.js` so the app finds the same socket and config as the Node core.
public struct AutochatPaths: Sendable, Equatable {
    public var home: String

    public init(home: String) {
        self.home = home
    }

    /// `envVar('HOME') || path.join(os.homedir(), '.autochat')`, where Node's
    /// `os.homedir()` prefers `$HOME`.
    public static func current(environment: [String: String] = ProcessInfo.processInfo.environment) -> AutochatPaths {
        if let custom = AutochatEnvironment.value("HOME", in: environment), !custom.isEmpty {
            return AutochatPaths(home: normalize(custom))
        }
        return AutochatPaths(home: normalize((userHome(environment) as NSString).appendingPathComponent(".autochat")))
    }

    /// Same one-time move as `src/paths.js`: if `~/.autochat` doesn't exist yet and the
    /// pre-rename `~/.lolchat` does, rename it so the identity (and the handle) carry over.
    /// Must run before the app writes anything under `home` (e.g. the daemon log).
    @discardableResult
    public static func migrateLegacyHome(environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        if let custom = AutochatEnvironment.value("HOME", in: environment), !custom.isEmpty { return false }
        let base = userHome(environment) as NSString
        let from = normalize(base.appendingPathComponent(".lolchat"))
        let to = normalize(base.appendingPathComponent(".autochat"))
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard !fm.fileExists(atPath: to), fm.fileExists(atPath: from, isDirectory: &isDir), isDir.boolValue else { return false }
        return (try? fm.moveItem(atPath: from, toPath: to)) != nil
    }

    private static func userHome(_ environment: [String: String]) -> String {
        environment["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
    }

    public var runDir: String { (home as NSString).appendingPathComponent("run") }
    public var sockPath: String { (runDir as NSString).appendingPathComponent("ui.sock") }
    public var configPath: String { (home as NSString).appendingPathComponent("config.json") }

    private static func normalize(_ path: String) -> String {
        let absolute = path.hasPrefix("/") ? path : (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent(path)
        var parts: [Substring] = []
        for part in absolute.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." { _ = parts.popLast(); continue }
            parts.append(part)
        }
        return "/" + parts.joined(separator: "/")
    }
}
