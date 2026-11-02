import AutoChatCore
import Foundation
import os

/// State transitions, for diagnosing the app. Always in the unified log at debug level
/// (`log stream --level debug --predicate 'subsystem == "com.bnookala.autochat"'`), and on
/// stderr with `AUTOCHAT_APP_DEBUG=1` (handy with the mock daemon).
enum DebugLog {
    static let enabled = AutochatEnvironment.value("APP_DEBUG").map { !$0.isEmpty && $0 != "0" } ?? false
    private static let logger = Logger(subsystem: "com.bnookala.autochat", category: "app")

    static func log(_ message: @autoclosure () -> String) {
        let text = message()
        logger.debug("\(text, privacy: .public)")
        guard enabled else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        FileHandle.standardError.write(Data("[AutoChat \(stamp)] \(text)\n".utf8))
    }
}
