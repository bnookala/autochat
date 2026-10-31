import Foundation
import LolChatCore
import ServiceManagement

/// "Launch at login" via SMAppService (only meaningful when running from the .app bundle).
enum LoginItem {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static var isAvailable: Bool {
        Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app"
    }

    static func set(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }
}

/// Reads and writes the CLI's own config, so "Pause lolchat" is the same switch as
/// `lolchat config launch off`.
enum LolchatConfig {
    private static let resumeKey = "resumeLaunchValue"

    static func launch(paths: LolchatPaths) -> String? {
        guard let data = FileManager.default.contents(atPath: paths.configPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["launch"] as? String
    }

    static func isPaused(paths: LolchatPaths) -> Bool {
        launch(paths: paths) == "off"
    }

    /// Runs `lolchat config launch off`, or restores the previous value when resuming.
    static func setPaused(_ paused: Bool, paths: LolchatPaths, binary: LolchatBinary) async -> Bool {
        let value: String
        if paused {
            let current = launch(paths: paths) ?? "auto"
            if current != "off" { UserDefaults.standard.set(current, forKey: resumeKey) }
            value = "off"
        } else {
            value = UserDefaults.standard.string(forKey: resumeKey) ?? "auto"
        }
        let env = binary.environment()
        return await Task.detached {
            DaemonLocator.run(binary.path, ["config", "launch", value], environment: env, timeout: 10) != nil
        }.value
    }
}
