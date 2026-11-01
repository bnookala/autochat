import AppKit
import AutoChatCore
import SwiftUI

/// `AutoChat --render-snapshots <dir>`: renders the descending panel, the chat window and its
/// Agents tab, the attention queue and the status item's badge from fixture snapshots to PNGs,
/// without screen-recording permission (NSView bitmap caching of offscreen windows). Writes
/// light-mode files with the canonical names plus `-dark` variants.
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
            ok = renderChat(
                Fixtures.countdown(now: now, remaining: 22.6), now: now, draft: "brb, mine just finished. same time tomorrow?",
                appearance: appearance, to: dir.appendingPathComponent("chat-window-countdown\(suffix).png")
            ) && ok
            ok = renderChat(Fixtures.request(now: now), now: now, draft: "", appearance: appearance, to: dir.appendingPathComponent("chat-window-request\(suffix).png")) && ok
            ok = renderChat(Fixtures.reality(now: now), now: now, draft: "", appearance: appearance, to: dir.appendingPathComponent("chat-window-closeout\(suffix).png"), closeoutSeconds: 4) && ok
            // The Lounge tab once there's an agent room (the toolbar gains Lounge | Agents).
            var tabs = Fixtures.request(now: now)
            tabs.agents = LoungeAgents(present: 2, openThreads: 1)
            ok = renderChat(tabs, now: now, draft: "", appearance: appearance, to: dir.appendingPathComponent("chat-window-tabs\(suffix).png")) && ok
            // The Agents tab: the board with the main stream, a resolved thread, intervening in
            // an open thread, and the one-time acknowledgement sheet.
            ok = renderAgents(AgentsModel(fixture: Fixtures.agents(now: now)), now: now, appearance: appearance, to: dir.appendingPathComponent("agents-board\(suffix).png")) && ok
            ok = renderAgents(
                AgentsModel(fixture: Fixtures.agents(now: now), selection: .thread(Fixtures.authThread)),
                now: now, appearance: appearance, to: dir.appendingPathComponent("agents-thread\(suffix).png")
            ) && ok
            ok = renderAgents(
                AgentsModel(
                    fixture: Fixtures.agents(now: now, ack: true), selection: .thread(Fixtures.budgetThread), intervening: true,
                    draft: "Keep the budget at 3 for now: our alerting assumes three attempts."
                ),
                now: now, appearance: appearance, to: dir.appendingPathComponent("agents-intervene\(suffix).png")
            ) && ok
            ok = renderAgents(
                AgentsModel(fixture: Fixtures.agents(now: now), intervening: true),
                now: now, appearance: appearance, to: dir.appendingPathComponent("agents-ack\(suffix).png")
            ) && ok
            // The attention queue: the badge, the panel when agents are blocked on you, the
            // countdown with several agents, and the strip in the chat (collapsed, expanded, and
            // back in the lounge).
            ok = render(BadgeScene(dark: appearance == .darkAqua), size: NSSize(width: 600, height: 150), appearance: appearance, to: dir.appendingPathComponent("status-item-badge\(suffix).png")) && ok
            ok = renderPanel(.attention, snapshot: Fixtures.attention(now: now), now: now, appearance: appearance, to: dir.appendingPathComponent("status-panel-attention\(suffix).png"), height: 520) && ok
            ok = renderPanel(
                .countdown, snapshot: Fixtures.attentionCountdown(now: now, remaining: 22.6), now: now, appearance: appearance,
                to: dir.appendingPathComponent("status-panel-countdown-queue\(suffix).png"), height: 430
            ) && ok
            ok = renderChat(Fixtures.attention(now: now), now: now, draft: "", appearance: appearance, to: dir.appendingPathComponent("chat-window-attention\(suffix).png")) && ok
            ok = renderChat(
                Fixtures.attention(now: now), now: now, draft: "", appearance: appearance,
                to: dir.appendingPathComponent("chat-window-attention-expanded\(suffix).png"), attentionExpanded: true
            ) && ok
            ok = renderChat(Fixtures.attentionLounge(now: now), now: now, draft: "", appearance: appearance, to: dir.appendingPathComponent("chat-window-lounge-attention\(suffix).png")) && ok
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

    private static func renderPanel(_ kind: PanelKind, snapshot: Snapshot, now: Date, appearance: NSAppearance.Name, to url: URL, height: CGFloat? = nil) -> Bool {
        let model = AppModel(fixture: snapshot, now: now)
        let scene = PanelScene(model: model, kind: kind, dark: appearance == .darkAqua)
        return render(scene, size: NSSize(width: 600, height: height ?? (kind == .autopilot ? 200 : 250)), appearance: appearance, to: url)
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

    // MARK: Chat window (the real window and toolbar, drawn as key)

    private static func renderChat(
        _ snapshot: Snapshot, now: Date, draft: String, appearance: NSAppearance.Name, to url: URL, closeoutSeconds: TimeInterval? = nil, attentionExpanded: Bool = false
    ) -> Bool {
        let model = AppModel(fixture: snapshot, now: now, chatWindow: ChatWindowState(isVisible: true, isKey: true, appIsActive: true), draft: draft)
        if let closeoutSeconds { model.showCloseoutTimerForSnapshot(closesAt: now.addingTimeInterval(closeoutSeconds)) }
        model.attentionExpanded = attentionExpanded
        let (controller, window) = ChatWindowController.makeForSnapshot(model: model, size: NSSize(width: 560, height: 600), appearance: appearance)
        window.orderFrontRegardless()
        settle()
        // Show a caret at the end of the draft rather than a select-all highlight.
        if let editor = window.firstResponder as? NSTextView {
            editor.selectedRange = NSRange(location: (editor.string as NSString).length, length: 0)
            settle()
        }
        defer {
            window.orderOut(nil)
            withExtendedLifetime(controller) {}
        }
        guard let frame = window.contentView?.superview else { return false }
        return write(frame, to: url)
    }

    // MARK: Agents tab (the real window and toolbar; a presented sheet is composited on top)

    static let agentsSize = NSSize(width: 960, height: 760)

    private static func renderAgents(_ agents: AgentsModel, now: Date, appearance: NSAppearance.Name, to url: URL) -> Bool {
        let model = AppModel(
            fixture: Fixtures.agentsLounge(), now: now, chatWindow: ChatWindowState(isVisible: true, isKey: true, appIsActive: true),
            agents: agents, tab: .agents
        )
        let (controller, window) = ChatWindowController.makeForSnapshot(model: model, size: agentsSize, appearance: appearance)
        window.orderFrontRegardless()
        settle()
        if let editor = window.firstResponder as? NSTextView {
            editor.selectedRange = NSRange(location: (editor.string as NSString).length, length: 0)
            settle()
        }
        defer {
            if let sheet = window.attachedSheet { window.endSheet(sheet) }
            window.orderOut(nil)
            withExtendedLifetime(controller) {}
        }
        guard let frame = window.contentView?.superview else { return false }
        guard agents.gate.sheetShown else { return write(frame, to: url) }
        guard let sheet = window.attachedSheet, let sheetFrame = sheet.contentView?.superview else {
            FileHandle.standardError.write(Data("render-snapshots: the acknowledgement sheet didn't appear\n".utf8))
            return false
        }
        sheet.appearance = NSAppearance(named: appearance)
        settle()
        guard let base = bitmap(frame), let overlay = bitmap(sheetFrame) else { return false }
        let offset = NSPoint(x: sheet.frame.minX - window.frame.minX, y: sheet.frame.minY - window.frame.minY)
        return write(composite(base, overlay, at: offset, scale: CGFloat(base.pixelsWide) / frame.bounds.width), to: url)
    }

    /// Draws a sheet over its window like the window server would: same place, rounded
    /// corners, soft shadow (the window server's shape and shadow aren't in the bitmaps).
    private static func composite(_ base: NSBitmapImageRep, _ sheet: NSBitmapImageRep, at offset: NSPoint, scale: CGFloat) -> NSBitmapImageRep {
        guard let out = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: base.pixelsWide, pixelsHigh: base.pixelsHigh, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: out), let baseImage = base.cgImage, let sheetImage = sheet.cgImage else { return base }
        let cg = context.cgContext
        cg.draw(baseImage, in: CGRect(x: 0, y: 0, width: base.pixelsWide, height: base.pixelsHigh))
        let rect = CGRect(x: offset.x * scale, y: offset.y * scale, width: CGFloat(sheet.pixelsWide), height: CGFloat(sheet.pixelsHigh))
        let shape = CGPath(roundedRect: rect, cornerWidth: 18 * scale, cornerHeight: 18 * scale, transform: nil)
        cg.saveGState()
        cg.setShadow(offset: CGSize(width: 0, height: -8 * scale), blur: 30 * scale, color: NSColor.black.withAlphaComponent(0.3).cgColor)
        cg.addPath(shape)
        cg.setFillColor(NSColor.black.cgColor)
        cg.fillPath()
        cg.restoreGState()
        cg.saveGState()
        cg.addPath(shape)
        cg.clip()
        cg.draw(sheetImage, in: rect)
        cg.restoreGState()
        cg.addPath(shape)
        cg.setStrokeColor(NSColor.black.withAlphaComponent(0.12).cgColor)
        cg.setLineWidth(scale)
        cg.strokePath()
        return out
    }

    // MARK: Helpers

    private static func settle() {
        for _ in 0..<6 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.08))
        }
    }

    private static func bitmap(_ view: NSView) -> NSBitmapImageRep? {
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep
    }

    private static func write(_ view: NSView, to url: URL) -> Bool {
        guard let rep = bitmap(view) else { return false }
        return write(rep, to: url)
    }

    private static func write(_ rep: NSBitmapImageRep, to url: URL) -> Bool {
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

/// Desktop + menu bar backdrop with the panel hanging under the AutoChat status item.
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
        let status = model.iconState
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
        StatusItemMock(status: status, badge: model.badgeCount, dark: dark)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill((dark ? Color.white : Color.black).opacity(0.14)))
    }
}

/// The status item as the menu bar draws it: the same template image as the real one.
private struct StatusItemMock: View {
    let status: StatusIconState
    let badge: Int
    let dark: Bool
    var scale: CGFloat = 1

    var body: some View {
        HStack(spacing: 3 * scale) {
            if let image = StatusIcon.image(for: status, badge: badge, description: "AutoChat") {
                Image(nsImage: image)
                    .renderingMode(.template)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: image.size.width * scale, height: image.size.height * scale)
            }
            if case let .countdown(n) = status {
                Text(verbatim: "\(n)").font(.system(size: 13 * scale, weight: .semibold)).monospacedDigit()
            }
        }
        .foregroundStyle(dark ? Color.white : Color.black.opacity(0.85))
    }
}

/// The badge up close: the menu bar at its real size, then each state magnified.
private struct BadgeScene: View {
    let dark: Bool

    private let cases: [(StatusIconState, Int, String)] = [
        (.autopilot, 0, "no one waiting"), (.autopilot, 1, "1 blocked"), (.autopilot, 2, "2 blocked"), (.autopilot, 12, "12 blocked"), (.lounge, 1, "in the lounge")
    ]

    var body: some View {
        let ink = dark ? Color.white : Color.black.opacity(0.85)
        ZStack(alignment: .top) {
            LinearGradient(
                colors: dark
                    ? [Color(red: 0.10, green: 0.12, blue: 0.24), Color(red: 0.22, green: 0.12, blue: 0.30)]
                    : [Color(red: 0.55, green: 0.70, blue: 0.98), Color(red: 0.86, green: 0.70, blue: 0.95)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            VStack(spacing: 18) {
                HStack(spacing: 18) {
                    Spacer()
                    StatusItemMock(status: .autopilot, badge: 2, dark: dark)
                    Image(systemName: "wifi").font(.system(size: 13, weight: .medium))
                    Image(systemName: "battery.75percent").font(.system(size: 14))
                    Text("Fri 2:32 PM").font(.system(size: 13, weight: .medium))
                }
                .foregroundStyle(ink)
                .padding(.horizontal, 14)
                .frame(height: 30)
                .background(dark ? Color.black.opacity(0.35) : Color.white.opacity(0.45))
                HStack(alignment: .top, spacing: 26) {
                    ForEach(Array(cases.enumerated()), id: \.offset) { _, c in
                        VStack(spacing: 10) {
                            StatusItemMock(status: c.0, badge: c.1, dark: dark, scale: 3)
                                .frame(height: 60)
                            Text(verbatim: c.2)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(ink.opacity(0.8))
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Live check against a running daemon

extension SnapshotRenderer {
    /// `AutoChat --render-live <dir> [--say <text>]`: attaches to the daemon at $AUTOCHAT_HOME
    /// (never spawns one), opens the Agents tab offscreen and renders it from live snapshots.
    /// With `--say` it then goes through Intervene… → the acknowledgement sheet → `agents.say`
    /// with the same calls the buttons make, and renders each step. For checking the app
    /// against a real daemon without screen recording or UI scripting.
    static func renderLive(to dir: URL, say: String?) -> Bool {
        func log(_ message: String) { print("render-live: \(message)") }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            log("\(error)")
            return false
        }
        let paths = AutochatPaths.current()
        let client = DaemonClient(socketPath: paths.sockPath)
        let supervisor = DaemonSupervisor(socketPath: paths.sockPath, locate: { nil })
        let model = AppModel(client: client, supervisor: supervisor)
        model.start()
        defer { client.stop() }

        guard pump(seconds: 15, until: { model.connected && model.showsAgentsTab }) else {
            log("no agent room on \(paths.sockPath) (connection: \(model.connection), daemon: \(model.daemon))")
            return false
        }
        let summary = model.snapshot?.agents
        log("connected; lounge snapshot reports \(summary?.present ?? 0) active, \(summary?.openThreads ?? 0) open threads")
        if let summary { log("menu line: \(AgentsRules.menuLine(summary))") }

        model.selectTab(.agents)
        let (controller, window) = ChatWindowController.makeForSnapshot(model: model, size: agentsSize, appearance: .aqua)
        defer {
            if let sheet = window.attachedSheet { window.endSheet(sheet) }
            window.orderOut(nil)
            withExtendedLifetime(controller) {}
        }
        window.orderFrontRegardless()
        model.chatWindow = ChatWindowState(isVisible: true, isKey: true, appIsActive: true)
        guard pump(seconds: 10, until: { model.agents.snapshot != nil }) else {
            log("no agents snapshot (agents connection: \(model.agents.connection))")
            return false
        }
        settle()
        let agents = model.agents
        if let s = agents.snapshot {
            log("agents snapshot: tier \(s.tier ?? "?"), human \(s.human ?? "?"), ack \(s.ack), \(s.agents.count) cards, \(s.threads.count) threads, \(s.messages.count) messages")
            for card in s.agents {
                log("  card \(card.display ?? card.name) [\(card.harness.label)] \(AgentsRules.location(card) ?? "-") \(card.state?.label ?? "-") present=\(card.present) overlaps=\(card.overlaps)")
            }
            for thread in s.threads { log("  thread “\(thread.title)” \(AgentsRules.threadMeta(thread))") }
        }
        log("window: \(window.title) — \(window.subtitle)")
        guard write(window.contentView!.superview!, to: dir.appendingPathComponent("live-agents-board.png")) else { return false }
        guard let say else { return true }

        // Intervene… → (sheet → Intervene) → type → ⏎, as a person would.
        agents.intervene()
        if agents.gate.sheetShown {
            settle()
            if let sheet = window.attachedSheet, let frame = window.contentView?.superview, let sheetFrame = sheet.contentView?.superview,
               let base = bitmap(frame), let overlay = bitmap(sheetFrame) {
                let offset = NSPoint(x: sheet.frame.minX - window.frame.minX, y: sheet.frame.minY - window.frame.minY)
                _ = write(composite(base, overlay, at: offset, scale: CGFloat(base.pixelsWide) / frame.bounds.width), to: dir.appendingPathComponent("live-agents-ack.png"))
            }
            log("acknowledgement sheet shown; confirming (agents.ack)")
            guard run({ await agents.confirmAck() }), agents.gate.inputVisible else {
                log("acknowledgement failed: \(agents.ackError ?? "no answer")")
                return false
            }
        } else {
            log("already acknowledged: no sheet")
        }
        guard agents.gate.inputVisible else {
            log("the input didn't appear")
            return false
        }
        agents.draft = say
        let target = agents.stream
        guard run({ await agents.submit() }) else { return false }
        if let error = agents.lastError {
            log("agents.say failed: \(error)")
            return false
        }
        let posted = pump(seconds: 10, until: {
            agents.snapshot?.messages.contains { $0.kind == .human && $0.text == say && $0.thread == target.threadID } == true
        })
        log(posted ? "agents.say ok: the intervention is in the \(target == .main ? "main stream" : "thread")" : "the intervention never showed up")
        // Give agents a moment to answer, then render.
        _ = pump(seconds: 3, until: { agents.snapshot?.messages.last?.kind != .human })
        settle()
        return write(window.contentView!.superview!, to: dir.appendingPathComponent("live-agents-intervene.png")) && posted
    }

    private static func pump(seconds: TimeInterval, until condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() >= deadline { return false }
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        return true
    }

    /// Runs async model work to completion from this synchronous dev mode.
    private static func run(_ work: @escaping @MainActor () async -> Void) -> Bool {
        var done = false
        Task { @MainActor in
            await work()
            done = true
        }
        return pump(seconds: 10, until: { done })
    }
}
