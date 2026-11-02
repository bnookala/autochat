import AppKit
import Testing
@testable import AutoChatApp

/// The chat's text field needs these key equivalents, and they come only from the main menu.
@MainActor
@Suite struct MainMenuTests {
    @Test func standardShortcutsReachTheResponderChain() {
        _ = NSApplication.shared
        let menu = MainMenu.make()
        let items = menu.items.flatMap { $0.submenu?.items ?? [] }
        func shortcut(_ action: String) -> String? {
            items.first { $0.action.map(NSStringFromSelector) == action }.map { item in
                (item.keyEquivalentModifierMask.contains(.shift) ? "⇧" : "") + (item.keyEquivalentModifierMask.contains(.option) ? "⌥" : "") + "⌘" + item.keyEquivalent
            }
        }
        #expect(menu.items.map(\.title) == ["AutoChat", "Edit", "Window"])
        #expect(shortcut("copy:") == "⌘c")
        #expect(shortcut("paste:") == "⌘v")
        #expect(shortcut("cut:") == "⌘x")
        #expect(shortcut("selectAll:") == "⌘a")
        #expect(shortcut("undo:") == "⌘z")
        #expect(shortcut("redo:") == "⇧⌘z")
        #expect(shortcut("performClose:") == "⌘w")
        #expect(shortcut("performMiniaturize:") == "⌘m")
        #expect(shortcut("terminate:") == "⌘q")
        #expect(shortcut("hideOtherApplications:") == "⌥⌘h")
    }
}
