import Foundation

/// Mirrors `src/paths.js` so the app finds the same socket and config as the Node core.
public struct LolchatPaths: Sendable, Equatable {
    public var home: String

    public init(home: String) {
        self.home = home
    }

    /// `process.env.LOLCHAT_HOME || path.join(os.homedir(), '.lolchat')`, where Node's
    /// `os.homedir()` prefers `$HOME`.
    public static func current(environment: [String: String] = ProcessInfo.processInfo.environment) -> LolchatPaths {
        if let custom = environment["LOLCHAT_HOME"], !custom.isEmpty {
            return LolchatPaths(home: normalize(custom))
        }
        let userHome = environment["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
        return LolchatPaths(home: normalize((userHome as NSString).appendingPathComponent(".lolchat")))
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
