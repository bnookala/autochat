import AppKit
import AutoChatCore

/// The status item's image. With agents blocked on you it gets a count badge in its top-right
/// corner, cut out of the glyph. It stays a template image, so the menu bar draws it in its
/// own color in light and dark mode, and when highlighted.
enum StatusIcon {
    static let pointSize: CGFloat = 14

    static func symbolName(for state: StatusIconState) -> [String] {
        switch state {
        case .disconnected, .lounge: ["bubble.left.and.bubble.right"]
        case .autopilot, .countdown: ["bubble.left.and.bubble.right.fill"]
        case .needsYou: ["bubble.left.and.exclamationmark.bubble.right.fill", "exclamationmark.bubble.fill"]
        }
    }

    static func image(for state: StatusIconState, badge: Int, description: String) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .medium)
        guard let symbol = Symbols.image(symbolName(for: state), description: description)?.withSymbolConfiguration(config) else { return nil }
        guard badge > 0 else {
            symbol.isTemplate = true
            return symbol
        }
        let image = badged(symbol, text: AttentionRules.badgeText(badge))
        image.accessibilityDescription = description
        return image
    }

    /// The glyph with a pill-shaped count over its top-right corner, separated from it by a
    /// transparent gap, the digits knocked out of the pill.
    static func badged(_ symbol: NSImage, text: String) -> NSImage {
        let font = NSFont.systemFont(ofSize: 8.5, weight: .heavy)
        let label = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor.black])
        let textSize = label.size()
        let height: CGFloat = 10.5
        let width = max(height, ceil(textSize.width) + 5)
        let glyph = symbol.size
        let size = NSSize(width: ceil(glyph.width + width * 0.45), height: ceil(max(glyph.height + 1.5, height)))
        let glyphRect = NSRect(x: 0, y: 0, width: glyph.width, height: glyph.height)
        let pill = NSRect(x: size.width - width, y: size.height - height, width: width, height: height)
        let image = NSImage(size: size, flipped: false) { _ in
            guard let cg = NSGraphicsContext.current?.cgContext else { return false }
            symbol.draw(in: glyphRect)
            cg.setBlendMode(.clear)
            NSBezierPath(roundedRect: pill.insetBy(dx: -1.5, dy: -1.5), xRadius: height / 2 + 1.5, yRadius: height / 2 + 1.5).fill()
            cg.setBlendMode(.normal)
            NSColor.black.setFill()
            NSBezierPath(roundedRect: pill, xRadius: height / 2, yRadius: height / 2).fill()
            cg.setBlendMode(.destinationOut)
            label.draw(at: NSPoint(x: pill.midX - textSize.width / 2, y: pill.midY - textSize.height / 2 + 0.25))
            cg.setBlendMode(.normal)
            return true
        }
        image.isTemplate = true
        return image
    }
}
