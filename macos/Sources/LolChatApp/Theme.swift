import AppKit
import LolChatCore
import SwiftUI

extension HandleColor {
    /// Handle colors come from a palette tuned for dark terminals; darken them in light mode
    /// so they stay legible on a white background.
    var nsColor: NSColor {
        let c = components
        let base = NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1)
        let darker = base.blended(withFraction: 0.38, of: .black) ?? base
        return NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? base : darker
        }
    }

    var color: Color { Color(nsColor: nsColor) }
}

enum Theme {
    static let countdown = Color.orange
    static let panelWidth: CGFloat = 344
    static let panelCorner: CGFloat = 18
}

extension Optional where Wrapped == HandleColor {
    var color: Color { self?.color ?? .primary }
}

/// SF Symbol names used by the status item, with fallbacks for older systems.
enum Symbols {
    static func image(_ names: String..., description: String) -> NSImage? {
        for name in names {
            if let image = NSImage(systemSymbolName: name, accessibilityDescription: description) { return image }
        }
        return nil
    }
}
