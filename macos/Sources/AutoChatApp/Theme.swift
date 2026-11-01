import AppKit
import AutoChatCore
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
    static let active = Color.green
    static let panelWidth: CGFloat = 344
    static let panelCorner: CGFloat = 18
    /// Human interventions in the agent room.
    static let intervene = Palette.orange
    static let overlap = Palette.amber
    static let cardCorner: CGFloat = 10
    /// Cards on the agents board: white-ish in light mode, a raised gray in dark mode.
    static let cardFill = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.065)
            : NSColor(white: 1, alpha: 0.85)
    })
    static let cardStroke = Color.primary.opacity(0.09)
    static let sidebarFill = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(white: 0, alpha: 0.16)
            : NSColor(white: 0, alpha: 0.035)
    })
}

/// Tints for badges and pills: darker in light mode so small text stays legible on light
/// backgrounds, brighter in dark mode.
enum Palette {
    static func dynamic(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let c = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }

    static let blue = dynamic(light: (0.08, 0.40, 0.86), dark: (0.42, 0.67, 1.00))
    static let teal = dynamic(light: (0.03, 0.47, 0.53), dark: (0.36, 0.80, 0.86))
    static let purple = dynamic(light: (0.49, 0.29, 0.80), dark: (0.76, 0.61, 1.00))
    static let green = dynamic(light: (0.12, 0.52, 0.24), dark: (0.42, 0.84, 0.50))
    static let indigo = dynamic(light: (0.30, 0.31, 0.82), dark: (0.62, 0.63, 1.00))
    static let orange = dynamic(light: (0.82, 0.40, 0.00), dark: (1.00, 0.62, 0.24))
    static let red = dynamic(light: (0.80, 0.16, 0.16), dark: (1.00, 0.46, 0.43))
    static let amber = dynamic(light: (0.60, 0.42, 0.00), dark: (1.00, 0.80, 0.26))
    static let pink = dynamic(light: (0.78, 0.18, 0.48), dark: (1.00, 0.52, 0.76))
    static let gray = dynamic(light: (0.42, 0.42, 0.45), dark: (0.68, 0.68, 0.71))
    static let claude = dynamic(light: (0.74, 0.36, 0.22), dark: (0.94, 0.58, 0.44))
}

extension Optional where Wrapped == HandleColor {
    var color: Color { self?.color ?? .primary }
}

/// SF Symbol names used by the status item, with fallbacks for older systems.
enum Symbols {
    static func image(_ names: String..., description: String) -> NSImage? {
        image(names, description: description)
    }

    static func image(_ names: [String], description: String) -> NSImage? {
        for name in names {
            if let image = NSImage(systemSymbolName: name, accessibilityDescription: description) { return image }
        }
        return nil
    }
}
