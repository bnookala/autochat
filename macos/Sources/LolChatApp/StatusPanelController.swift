import AppKit
import LolChatCore
import SwiftUI

/// Borderless, non-activating panel that hangs under the status item. It never becomes key,
/// so it can't steal focus from whatever the user is doing.
final class DescendingPanel: NSPanel {
    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: Theme.panelWidth, height: 80), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isFloatingPanel = true
        level = .statusBar
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        isMovable = false
        animationBehavior = .none
        isReleasedWhenClosed = false
        setAccessibilitySubrole(.floatingWindow)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Lets the first click on a non-key panel hit SwiftUI buttons.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@Observable
@MainActor
final class PanelDisplay {
    var kind: PanelKind = .autopilot
}

/// Shows/hides the descending panel according to `PanelRules.decide` (via `model.panelKind`),
/// so it hands off to the chat window whenever that window becomes visible-and-key.
@MainActor
final class StatusPanelController {
    private let model: AppModel
    private let anchor: () -> NSRect?
    private let openChat: () -> Void
    private let panel = DescendingPanel()
    private let display = PanelDisplay()
    private var hosting: FirstMouseHostingView<PanelRoot>!
    private(set) var shownKind: PanelKind?
    private var hideGeneration = 0

    init(model: AppModel, anchor: @escaping () -> NSRect?, openChat: @escaping () -> Void) {
        self.model = model
        self.anchor = anchor
        self.openChat = openChat

        let effect = NSVisualEffectView()
        effect.material = .popover
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = Theme.panelCorner
        effect.layer?.cornerCurve = .continuous
        effect.layer?.masksToBounds = true

        hosting = FirstMouseHostingView(rootView: PanelRoot(model: model, display: display, onOpenChat: openChat))
        hosting.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(hosting)
        NSLayoutConstraint.activate([
            hosting.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            hosting.topAnchor.constraint(equalTo: effect.topAnchor),
            hosting.bottomAnchor.constraint(equalTo: effect.bottomAnchor)
        ])
        panel.contentView = effect

        observeChanges { [weak self] in self?.update() }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reposition(animated: false) }
        }
    }

    private func update() {
        let kind = model.panelKind
        // Read what the panel displays so a content change (e.g. the countdown second) resizes it.
        _ = (model.now, model.snapshot?.request, model.countdown)
        guard kind != shownKind else {
            if kind != nil { reposition(animated: false) }
            return
        }
        if let kind {
            show(kind)
        } else {
            hide()
        }
    }

    private func show(_ kind: PanelKind) {
        let wasVisible = shownKind != nil && panel.isVisible
        DebugLog.log("panel ↓ \(kind) (chat \(model.chatWindow))")
        shownKind = kind
        hideGeneration += 1
        display.kind = kind
        if kind == .autopilot || kind == .request {
            NSAccessibility.post(element: panel, notification: .announcementRequested, userInfo: [.announcement: kind == .autopilot ? "Autopilot is on" : "Copilot needs you", .priority: NSAccessibilityPriorityLevel.medium.rawValue])
        }
        let target = targetFrame()
        if wasVisible {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.2
                panel.animator().setFrame(target, display: true)
                panel.animator().alphaValue = 1
            }
            return
        }
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        panel.setFrame(reduceMotion ? target : target.offsetBy(dx: 0, dy: 14), display: false)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        panel.invalidateShadow()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = reduceMotion ? 0.15 : 0.32
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1)
            panel.animator().setFrame(target, display: true)
            panel.animator().alphaValue = 1
        }
    }

    private func hide() {
        guard shownKind != nil else { return }
        DebugLog.log("panel ↑ (chat \(model.chatWindow))")
        shownKind = nil
        hideGeneration += 1
        let generation = hideGeneration
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.22
            ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
            if !reduceMotion { panel.animator().setFrame(panel.frame.offsetBy(dx: 0, dy: 10), display: true) }
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.hideGeneration == generation else { return }
                self.panel.orderOut(nil)
            }
        })
    }

    private func reposition(animated: Bool) {
        guard shownKind != nil else { return }
        let target = targetFrame()
        guard target != panel.frame else { return }
        if animated {
            panel.animator().setFrame(target, display: true)
        } else {
            panel.setFrame(target, display: true)
        }
        panel.invalidateShadow()
    }

    /// Centered under the status item, top edge just below the menu bar, kept on screen.
    private func targetFrame() -> NSRect {
        hosting.layoutSubtreeIfNeeded()
        let size = NSSize(width: Theme.panelWidth, height: ceil(hosting.fittingSize.height))
        let anchorRect = anchor()
        let screen = anchorRect.flatMap { a in NSScreen.screens.first { $0.frame.intersects(a) } } ?? NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let midX = anchorRect?.midX ?? (visible.maxX - size.width / 2 - 12)
        let top = min(anchorRect.map { $0.minY - 6 } ?? visible.maxY - 6, visible.maxY - 6)
        var x = midX - size.width / 2
        x = min(max(x, visible.minX + 8), visible.maxX - size.width - 8)
        return NSRect(x: x, y: top - size.height, width: size.width, height: size.height)
    }
}

struct PanelRoot: View {
    let model: AppModel
    let display: PanelDisplay
    let onOpenChat: () -> Void

    var body: some View {
        StatusPanelView(model: model, kind: display.kind, onOpenChat: onOpenChat)
    }
}
