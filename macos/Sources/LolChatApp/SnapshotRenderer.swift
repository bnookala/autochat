import AppKit
import LolChatCore
import SwiftUI

/// `LolChat --render-snapshots <dir>`: renders the descending panel from fixture snapshots to
/// PNGs, without screen-recording permission (NSView bitmap caching of offscreen windows).
/// Writes light-mode files with the canonical names plus `-dark` variants.
@MainActor
enum SnapshotRenderer {
    static func renderAll(to dir: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write(Data("render-snapshots: \(error)\n".utf8))
            return false
        }
        let now = referenceNow()
        var ok = true
        for (appearance, suffix) in [(NSAppearance.Name.aqua, ""), (.darkAqua, "-dark")] {
            ok = renderPanel(.autopilot, snapshot: Fixtures.room(now: now), now: now, appearance: appearance, to: dir.appendingPathComponent("status-panel-autopilot\(suffix).png")) && ok
            ok = renderPanel(.countdown, snapshot: Fixtures.countdown(now: now, remaining: 22.6), now: now, appearance: appearance, to: dir.appendingPathComponent("status-panel-countdown\(suffix).png")) && ok
            ok = renderPanel(.request, snapshot: Fixtures.request(now: now), now: now, appearance: appearance, to: dir.appendingPathComponent("status-panel-request\(suffix).png")) && ok
        }
        return ok
    }

    /// A fixed afternoon so timestamps in the PNGs are stable.
    private static func referenceNow() -> Date {
        var c = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        c.hour = 14
        c.minute = 32
        c.second = 0
        return Calendar.current.date(from: c) ?? Date()
    }

    // MARK: Panel (shown hanging from a mock menu bar so the "descending" placement is visible)

    private static func renderPanel(_ kind: PanelKind, snapshot: Snapshot, now: Date, appearance: NSAppearance.Name, to url: URL) -> Bool {
        let model = AppModel(fixture: snapshot, now: now)
        let scene = PanelScene(model: model, kind: kind, dark: appearance == .darkAqua)
        return render(scene, size: NSSize(width: 600, height: kind == .autopilot ? 200 : 250), appearance: appearance, to: url)
    }

    private static func render<V: View>(_ view: V, size: NSSize, appearance: NSAppearance.Name, to url: URL) -> Bool {
        let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -20000, y: -20000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: appearance)
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        window.contentView = host
        window.orderFrontRegardless()
        settle()
        defer { window.orderOut(nil) }
        return write(host, to: url)
    }

    // MARK: Helpers

    private static func settle() {
        for _ in 0..<6 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.08))
        }
    }

    private static func write(_ view: NSView, to url: URL) -> Bool {
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        do {
            try png.write(to: url)
            print("wrote \(url.path) (\(rep.pixelsWide)×\(rep.pixelsHigh))")
            return true
        } catch {
            FileHandle.standardError.write(Data("render-snapshots: \(error)\n".utf8))
            return false
        }
    }
}

/// Desktop + menu bar backdrop with the panel hanging under the LolChat status item.
private struct PanelScene: View {
    let model: AppModel
    let kind: PanelKind
    let dark: Bool

    private let menuBarHeight: CGFloat = 30
    private let iconCenterX: CGFloat = 392

    var body: some View {
        ZStack(alignment: .topLeading) {
            wallpaper
            menuBar
            StatusPanelView(model: model, kind: kind, opaqueBackground: true)
                .clipShape(RoundedRectangle(cornerRadius: Theme.panelCorner, style: .continuous))
                .shadow(color: .black.opacity(dark ? 0.5 : 0.22), radius: 18, y: 8)
                .offset(x: iconCenterX - Theme.panelWidth / 2, y: menuBarHeight + 6)
        }
    }

    private var wallpaper: some View {
        ZStack {
            LinearGradient(
                colors: dark
                    ? [Color(red: 0.10, green: 0.12, blue: 0.24), Color(red: 0.22, green: 0.12, blue: 0.30)]
                    : [Color(red: 0.55, green: 0.70, blue: 0.98), Color(red: 0.86, green: 0.70, blue: 0.95)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            Circle()
                .fill(dark ? Color(red: 0.25, green: 0.30, blue: 0.70).opacity(0.6) : Color.white.opacity(0.45))
                .frame(width: 360)
                .blur(radius: 60)
                .offset(x: -170, y: 60)
        }
    }

    private var menuBar: some View {
        let status: StatusIconState = kind == .countdown ? .countdown(model.countdownRemaining ?? 0) : kind == .request ? .needsYou : .autopilot
        return HStack(spacing: 18) {
            Image(systemName: "apple.logo").font(.system(size: 14, weight: .medium))
            Text("Terminal").font(.system(size: 13, weight: .bold))
            Text("Shell").font(.system(size: 13))
            Text("Edit").font(.system(size: 13))
            Text("View").font(.system(size: 13))
            Spacer()
            Color.clear.frame(width: 60, height: 1)
            Image(systemName: "wifi").font(.system(size: 13, weight: .medium))
            Image(systemName: "battery.75percent").font(.system(size: 14))
            Text("Fri 2:32 PM").font(.system(size: 13, weight: .medium))
        }
        .foregroundStyle(dark ? Color.white : Color.black.opacity(0.85))
        .padding(.horizontal, 14)
        .frame(height: menuBarHeight)
        .frame(maxWidth: .infinity)
        .background(dark ? Color.black.opacity(0.35) : Color.white.opacity(0.45))
        .overlay(alignment: .topLeading) {
            statusItem(status)
                .position(x: iconCenterX, y: menuBarHeight / 2)
        }
    }

    private func statusItem(_ status: StatusIconState) -> some View {
        HStack(spacing: 3) {
            Image(systemName: status == .needsYou ? "bubble.left.and.exclamationmark.bubble.right.fill" : "bubble.left.and.bubble.right.fill")
                .font(.system(size: 13, weight: .medium))
            if case let .countdown(n) = status {
                Text(verbatim: "\(n)").font(.system(size: 13, weight: .semibold)).monospacedDigit()
            }
        }
        .foregroundStyle(dark ? Color.white : Color.black.opacity(0.85))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill((dark ? Color.white : Color.black).opacity(0.14)))
    }
}
