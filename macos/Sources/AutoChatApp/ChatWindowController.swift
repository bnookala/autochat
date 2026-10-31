import AppKit
import AutoChatCore
import SwiftUI

/// The chat window. Draws as key for snapshot rendering, otherwise a normal titled window.
final class ChatWindow: NSWindow {
    var forceKeyAppearance = false
    override var isKeyWindow: Bool { forceKeyAppearance || super.isKeyWindow }
    override var isMainWindow: Bool { forceKeyAppearance || super.isMainWindow }
}

/// Single-instance chat window. Closing only hides it; it remembers its frame; it reports
/// its visible/key state to the model so the descending panel can hand off to it.
@MainActor
final class ChatWindowController: NSObject, NSWindowDelegate, NSToolbarDelegate {
    private let model: AppModel
    private var observers: [NSObjectProtocol] = []
    private var _window: ChatWindow?
    var window: ChatWindow {
        if let _window { return _window }
        let w = makeWindow()
        _window = w
        observeChanges { [weak self] in self?.syncChrome() }
        return w
    }
    private var meItem: NSToolbarItem?
    private var leaveItem: NSToolbarItem?
    private var wasCloseout = false

    private static let meID = NSToolbarItem.Identifier("me")
    private static let leaveID = NSToolbarItem.Identifier("leave")

    init(model: AppModel) {
        self.model = model
        super.init()
        model.onCloseoutElapsed = { [weak self] in self?.hide() }
    }

    func show() {
        model.dismissAutopilotNotice()
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
        reportState()
    }

    func hide() {
        guard let window = _window, window.isVisible else { return }
        window.orderOut(nil)
        reportState()
    }

    // MARK: Window

    private func makeWindow() -> ChatWindow {
        let window = ChatWindow(
            contentRect: NSRect(x: 0, y: 0, width: 540, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 420, height: 420)
        window.title = "AutoChat"
        window.titlebarSeparatorStyle = .automatic
        window.delegate = self
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenNone)
        window.contentViewController = NSHostingController(rootView: ChatView(model: model))
        let toolbar = NSToolbar(identifier: "AutoChatToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        window.setContentSize(NSSize(width: 540, height: 620))
        window.center()
        window.setFrameAutosaveName("AutoChatChatWindow")

        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
            NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification,
            NSWindow.didChangeOcclusionStateNotification, NSWindow.didChangeScreenNotification
        ]
        for name in names {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.reportState() }
            })
        }
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification, NSApplication.didHideNotification, NSApplication.didUnhideNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.reportState() }
            })
        }
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reportState() }
        })
        return window
    }

    /// Mirrors AppKit's view of the window into the model (input to the visible-and-key rule).
    func reportState() {
        guard let w = _window else { return }
        let state = ChatWindowState(
            isVisible: w.isVisible,
            isMiniaturized: w.isMiniaturized,
            isKey: w.isKeyWindow,
            appIsActive: NSApp.isActive && !NSApp.isHidden,
            isOccluded: !w.occlusionState.contains(.visible) || !w.isOnActiveSpace
        )
        if model.chatWindow != state {
            DebugLog.log("chat window visible-and-key=\(chatWindowIsVisibleAndKey(state))")
            model.chatWindow = state
        }
    }

    /// Title/subtitle/toolbar follow the snapshot; start the closeout timer at zero.
    private func syncChrome() {
        let p = model.presentation
        window.title = p.title
        window.subtitle = p.subtitle
        leaveItem?.isEnabled = p.canLeave
        if let meItem, let handle = p.myHandle {
            (meItem.view as? NSHostingView<MeChip>)?.rootView = MeChip(handle: handle, color: model.snapshot?.me?.color)
        }
        meItem?.view?.isHidden = p.myHandle == nil
        let isCloseout = p.closeout != nil
        if isCloseout, !wasCloseout, window.isVisible {
            model.beginCloseout()
        } else if !isCloseout, wasCloseout {
            model.cancelCloseout()
        }
        wasCloseout = isCloseout
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()
        return false
    }

    // MARK: Leave room

    func confirmLeave() {
        guard model.presentation.canLeave else { return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Leave \(model.presentation.title)?"
        alert.informativeText = "You won't be pulled back in for the rest of this autopilot run."
        let leave = alert.addButton(withTitle: "Leave Room")
        leave.hasDestructiveAction = true
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            MainActor.assumeIsolated { self?.model.perform(.leaveRoom) }
        }
    }

    @objc private func leaveClicked(_ sender: Any?) {
        confirmLeave()
    }

    // MARK: Toolbar

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.meID, Self.leaveID]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.meID, Self.leaveID]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        switch id {
        case Self.meID:
            let item = NSToolbarItem(itemIdentifier: id)
            let p = model.presentation
            let view = NSHostingView(rootView: MeChip(handle: p.myHandle ?? "", color: model.snapshot?.me?.color))
            item.view = view
            item.label = "You"
            item.isBordered = false
            item.visibilityPriority = .low
            meItem = item
            return item
        case Self.leaveID:
            let item = NSToolbarItem(itemIdentifier: id)
            item.image = NSImage(systemSymbolName: "rectangle.portrait.and.arrow.right", accessibilityDescription: "Leave Room")
            item.label = "Leave Room"
            item.toolTip = "Leave the room for the rest of this autopilot run"
            item.target = self
            item.action = #selector(leaveClicked(_:))
            item.isBordered = true
            item.autovalidates = false
            item.isEnabled = model.presentation.canLeave
            leaveItem = item
            return item
        default:
            return nil
        }
    }

    // MARK: Snapshot rendering

    /// The real window, configured for an offscreen PNG render.
    static func makeForSnapshot(model: AppModel, size: NSSize, appearance: NSAppearance.Name) -> (ChatWindowController, ChatWindow) {
        let controller = ChatWindowController(model: model)
        let window = controller.window
        window.setFrameAutosaveName("")
        window.forceKeyAppearance = true
        window.appearance = NSAppearance(named: appearance)
        window.setFrame(NSRect(origin: NSPoint(x: -20000, y: -20000), size: size), display: false)
        return (controller, window)
    }
}

/// "you: stormy-newt-59" chip in the toolbar.
struct MeChip: View {
    let handle: String
    let color: HandleColor?

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color.color)
                .frame(width: 8, height: 8)
            Text(verbatim: handle)
                .font(.callout.weight(.medium))
                .foregroundStyle(color.color)
            Text("(you)")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You are \(handle)")
    }
}
