import Foundation
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

    /// Set once the first launch has turned the login item on.
    static let enabledOnceKey = "openAtLoginEnabledOnce"

    /// AutoChat opens at login by default, so it's always running: its first launch turns the
    /// login item on, once. Turned off later (in the menu, or System Settings), it stays off.
    /// Only from the .app bundle, so never in tests or snapshot rendering.
    static func enableOnFirstLaunch(
        defaults: UserDefaults = .standard, available: Bool = LoginItem.isAvailable,
        enable: () throws -> Void = { if !LoginItem.isEnabled { try LoginItem.set(true) } }
    ) {
        guard available, !defaults.bool(forKey: enabledOnceKey) else { return }
        defaults.set(true, forKey: enabledOnceKey)
        do {
            try enable()
        } catch {
            DebugLog.log("open at login: \(error)")
        }
    }
}
