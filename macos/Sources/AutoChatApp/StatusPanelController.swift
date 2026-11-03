import AppKit
import AutoChatCore
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

/// Shows/hides the descending panel (the attention queue) according to `PanelRules.showsPanel`
/// (via `model.showsPanel`), so it hands off to the chat window whenever that window becomes
/// visible-and-key.
@MainActor
final class StatusPanelController {
    private let model: AppModel
    private let anchor: () -> NSRect?
    private let openChat: () -> Void
    private let panel = DescendingPanel()
    private var hosting: FirstMouseHostingView<StatusPanelView>!
    private(set) var shown = false
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

        hosting = FirstMouseHostingView(rootView: StatusPanelView(model: model, onOpenChat: openChat))
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
        let shows = model.showsPanel
        // Read what the panel displays so a content change resizes it.
        _ = model.snapshot?.attention
        guard shows != shown else {
            if shows { reposition(animated: false) }
            return
        }
        if shows {
            show()
        } else {
            hide()
        }
    }

    private func show() {
        DebugLog.log("panel ↓ (chat \(model.chatWindow))")
        shown = true
        hideGeneration += 1
        let announcement = AttentionRules.headline(model.attention)
        NSAccessibility.post(element: panel, notification: .announcementRequested, userInfo: [.announcement: announcement, .priority: NSAccessibilityPriorityLevel.medium.rawValue])
        let target = targetFrame()
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
        guard shown else { return }
        DebugLog.log("panel ↑ (chat \(model.chatWindow))")
        shown = false
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
        guard shown else { return }
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
