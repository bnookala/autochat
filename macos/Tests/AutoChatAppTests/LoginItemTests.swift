import Foundation
import Testing
@testable import AutoChatApp

/// Defaults that stay in memory: nothing lands in ~/Library/Preferences.
private final class MemoryDefaults: UserDefaults, @unchecked Sendable {
    private var flags: [String: Bool] = [:]
    override func bool(forKey key: String) -> Bool { flags[key] ?? false }
    override func set(_ value: Bool, forKey key: String) { flags[key] = value }
}

@Suite("Open at login")
struct LoginItemTests {
    @Test func theFirstLaunchTurnsItOnOnce() {
        let defaults = MemoryDefaults()
        var enabled = 0
        LoginItem.enableOnFirstLaunch(defaults: defaults, available: true) { enabled += 1 }
        #expect(enabled == 1)
        #expect(defaults.bool(forKey: LoginItem.enabledOnceKey))
        // Turned off later, it stays off: later launches leave it alone.
        LoginItem.enableOnFirstLaunch(defaults: defaults, available: true) { enabled += 1 }
        #expect(enabled == 1)
    }

    @Test func aFailureIsNotRetriedEveryLaunch() {
        let defaults = MemoryDefaults()
        var tries = 0
        LoginItem.enableOnFirstLaunch(defaults: defaults, available: true) {
            tries += 1
            throw CocoaError(.featureUnsupported)
        }
        LoginItem.enableOnFirstLaunch(defaults: defaults, available: true) { tries += 1 }
        #expect(tries == 1)
    }

    @Test func neverOutsideTheAppBundle() {
        #expect(!LoginItem.isAvailable, "tests don't run from AutoChat.app")
        let defaults = MemoryDefaults()
        LoginItem.enableOnFirstLaunch(defaults: defaults) { Issue.record("turned the login item on outside the app") }
        #expect(!defaults.bool(forKey: LoginItem.enabledOnceKey))
        var enabled = 0
        LoginItem.enableOnFirstLaunch(defaults: defaults, available: true) { enabled += 1 }
        #expect(enabled == 1, "the first launch of the app itself still does")
    }
}
