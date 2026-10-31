import AppKit

/// Draws the app icon (used by scripts/build-app.sh via `--render-icon`), so the repo
/// doesn't carry binary icon assets.
enum IconRenderer {
    static func writeIconset(to dir: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
                let pixels = points * scale
                let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
                guard let png = render(pixels: pixels) else { return false }
                try png.write(to: dir.appendingPathComponent(name))
            }
            return true
        } catch {
            FileHandle.standardError.write(Data("render-icon: \(error)\n".utf8))
            return false
        }
    }

    static func render(pixels: Int) -> Data? {
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { return nil }
        rep.size = NSSize(width: pixels, height: pixels)
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.current = ctx
        draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
        ctx.flushGraphics()
        return rep.representation(using: .png, properties: [:])
    }

    /// macOS icon grid: an 824/1024 rounded square with a soft shadow.
    static func draw(in rect: NSRect) {
        let s = rect.width / 1024
        let body = NSRect(x: rect.minX + 100 * s, y: rect.minY + 100 * s, width: 824 * s, height: 824 * s)
        let path = NSBezierPath(roundedRect: body, xRadius: 185 * s, yRadius: 185 * s)

        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
        shadow.shadowBlurRadius = 24 * s
        shadow.shadowOffset = NSSize(width: 0, height: -10 * s)
        shadow.set()
        NSColor(srgbRed: 0.33, green: 0.36, blue: 0.98, alpha: 1).setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()

        let gradient = NSGradient(colors: [
            NSColor(srgbRed: 0.30, green: 0.45, blue: 1.00, alpha: 1),
            NSColor(srgbRed: 0.52, green: 0.36, blue: 0.98, alpha: 1),
            NSColor(srgbRed: 0.86, green: 0.36, blue: 0.80, alpha: 1)
        ])
        gradient?.draw(in: path, angle: -60)

        NSGraphicsContext.saveGraphicsState()
        path.addClip()
        let gloss = NSGradient(colors: [NSColor.white.withAlphaComponent(0.22), NSColor.white.withAlphaComponent(0)])
        gloss?.draw(in: NSRect(x: body.minX, y: body.midY, width: body.width, height: body.height / 2), angle: -90)
        NSGraphicsContext.restoreGraphicsState()

        let config = NSImage.SymbolConfiguration(pointSize: 430 * s, weight: .semibold)
            .applying(.init(paletteColors: [.white]))
        if let symbol = NSImage(systemSymbolName: "bubble.left.and.bubble.right.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(config) {
            let size = symbol.size
            let scale = min(560 * s / size.width, 560 * s / size.height)
            let w = size.width * scale
            let h = size.height * scale
            let target = NSRect(x: body.midX - w / 2, y: body.midY - h / 2 - 6 * s, width: w, height: h)
            NSGraphicsContext.saveGraphicsState()
            let glyphShadow = NSShadow()
            glyphShadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
            glyphShadow.shadowBlurRadius = 14 * s
            glyphShadow.shadowOffset = NSSize(width: 0, height: -6 * s)
            glyphShadow.set()
            symbol.draw(in: target)
            NSGraphicsContext.restoreGraphicsState()
        }
    }
}
