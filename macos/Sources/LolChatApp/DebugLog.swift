import Foundation

/// `LOLCHAT_APP_DEBUG=1` prints state transitions to stderr (handy with the mock daemon).
enum DebugLog {
    static let enabled = ProcessInfo.processInfo.environment["LOLCHAT_APP_DEBUG"].map { !$0.isEmpty && $0 != "0" } ?? false

    static func log(_ message: @autoclosure () -> String) {
        guard enabled else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        FileHandle.standardError.write(Data("[LolChat \(stamp)] \(message())\n".utf8))
    }
}
