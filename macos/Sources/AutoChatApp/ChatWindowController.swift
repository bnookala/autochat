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
/// its visible/key state to the model so the descending panel can hand off to it. Once the
/// daemon hosts an agent room, the window has two tabs (Lounge | Agents), each with its size.
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
    private var loungeItem: NSToolbarItem?
    /// The tab the window is sized for, and each tab's last size.
    private var sizedTab: ChatTab?
    private var tabSizes: [ChatTab: NSSize] = [:]
    private var animateResize = true
    /// Off for snapshot rendering, which mustn't touch the user's defaults.
    private var persistsTabSizes = true

    private static let meID = NSToolbarItem.Identifier("me")
    private static let loungeID = NSToolbarItem.Identifier("lounge")
    static let loungeMinSize = NSSize(width: 420, height: 420)
    static let agentsMinSize = NSSize(width: 800, height: 500)
    static let agentsDefaultSize = NSSize(width: 960, height: 740)

    init(model: AppModel) {
        self.model = model
        super.init()
    }

    func show() {
        // Size the window for the tab before it appears, rather than animating afterwards.
        let wasVisible = window.isVisible
        animateResize = wasVisible
        syncChrome()
        animateResize = true
        if !wasVisible { DebugLog.log("chat window shows \(model.effectiveTab)") }
        if window.isMiniaturized { window.deminiaturize(nil) }
        // While the chat is open, AutoChat is a regular app: in the Dock and ⌘-Tab, with its
        // menus. Closing the chat puts it back in the menu bar only.
        if NSApp.activationPolicy() == .accessory { NSApp.setActivationPolicy(.regular) }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
        // macOS can decline that activation: since macOS 26 it does for a menu bar click while
        // another app is in front, which left the window behind that app. Bring it up anyway.
        window.orderFrontRegardless()
        reportState()
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            self?.insistOnActivation()
        }
    }

    /// Every way to open the chat is a click (the icon, its menu, the panel), so if macOS still
    /// hasn't activated the app, insist: what the user types next belongs in the chat.
    private func insistOnActivation() {
        guard let window = _window, window.isVisible, !NSApp.isActive else { return }
        DebugLog.log("activation declined; activating anyway")
        (NSApp as LegacyActivation).activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        reportState()
    }

    func hide() {
        guard let window = _window, window.isVisible else { return }
        window.orderOut(nil)
        if NSApp.activationPolicy() == .regular { NSApp.setActivationPolicy(.accessory) }
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
        let hosting = NSHostingController(rootView: ChatView(model: model, onSelectTab: { [weak self] tab in self?.select(tab) }))
        // The controller sizes the window per tab (`syncSize`), so SwiftUI mustn't fight it.
        hosting.sizingOptions = []
        window.contentViewController = hosting
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

    /// Title/subtitle/toolbar follow the snapshot and the tab.
    private func syncChrome() {
        let p = model.presentation
        let tab = model.effectiveTab
        syncSize(for: tab)
        if tab == .agents {
            window.title = "Agents"
            window.subtitle = AgentsRules.subtitle(snapshot: model.agents.snapshot, lounge: model.snapshot?.agents)
        } else {
            window.title = p.title
            window.subtitle = p.subtitle
        }
        if let loungeItem { sync(loungeItem, p) }
        if let meItem, let handle = p.myHandle {
            (meItem.view as? NSHostingView<MeChip>)?.rootView = MeChip(handle: handle, color: model.snapshot?.me?.color)
        }
        meItem?.view?.isHidden = p.myHandle == nil
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()
        return false
    }

    // MARK: Tabs

    /// The tab strip: switch, and size the window for it right away (before SwiftUI lays the
    /// new tab out at the old size).
    func select(_ tab: ChatTab) {
        model.selectTab(tab)
        animateResize = false
        syncChrome()
        animateResize = true
    }

    /// Each tab keeps its own window size: the agents view needs more room than the chat.
    private func syncSize(for tab: ChatTab) {
        window.minSize = tab == .agents ? Self.agentsMinSize : Self.loungeMinSize
        let frame = window.frame
        guard tab != sizedTab else {
            if frame.width < window.minSize.width || frame.height < window.minSize.height { resize(to: frame.size, animate: false) }
            return
        }
        let previous = sizedTab
        sizedTab = tab
        if let previous { remember(frame.size, for: previous) }
        var size = tabSizes[tab] ?? savedSize(for: tab) ?? frame.size
        if tabSizes[tab] == nil, savedSize(for: tab) == nil, previous != nil, tab == .agents {
            size = NSSize(width: max(frame.width, Self.agentsDefaultSize.width), height: max(frame.height, Self.agentsDefaultSize.height))
        }
        resize(to: size, animate: animateResize && window.isVisible)
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        if let sizedTab { remember(window.frame.size, for: sizedTab) }
    }

    private static func sizeKey(_ tab: ChatTab) -> String { "AutoChatWindowSize.\(tab.rawValue)" }

    private func remember(_ size: NSSize, for tab: ChatTab) {
        tabSizes[tab] = size
        guard persistsTabSizes else { return }
        UserDefaults.standard.set(NSStringFromSize(size), forKey: Self.sizeKey(tab))
    }

    private func savedSize(for tab: ChatTab) -> NSSize? {
        guard persistsTabSizes, let saved = UserDefaults.standard.string(forKey: Self.sizeKey(tab)) else { return nil }
        let size = NSSizeFromString(saved)
        return size.width > 0 && size.height > 0 ? size : nil
    }

    /// Resizes keeping the top-left corner, within the minimum size and the screen.
    private func resize(to wanted: NSSize, animate: Bool) {
        let frame = window.frame
        var size = NSSize(width: max(wanted.width, window.minSize.width), height: max(wanted.height, window.minSize.height))
        var origin = NSPoint(x: frame.minX, y: frame.maxY - size.height)
        if let visible = (window.screen ?? NSScreen.main)?.visibleFrame, visible.intersects(frame) {
            size.width = min(size.width, visible.width)
            size.height = min(size.height, visible.height)
            origin.y = frame.maxY - size.height
            origin.x = min(max(origin.x, visible.minX), visible.maxX - size.width)
            origin.y = min(max(origin.y, visible.minY), visible.maxY - size.height)
        }
        let target = NSRect(origin: origin, size: size)
        guard target != frame else { return }
        if animate {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.22
                ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                window.animator().setFrame(target, display: true)
            }
        } else {
            window.setFrame(target, display: true)
        }
    }

    // MARK: Leave Room / Join Room

    /// Join the Lounge, off or on, from the toolbar: it says what a click does.
    private func sync(_ item: NSToolbarItem, _ p: ChatPresentation) {
        let title = p.loungeOn ? "Leave Room" : "Join Room"
        item.label = title
        item.image = NSImage(systemSymbolName: p.loungeOn ? "rectangle.portrait.and.arrow.right" : "person.2.badge.plus", accessibilityDescription: title)
            ?? NSImage(systemSymbolName: "person.2", accessibilityDescription: title)
        item.toolTip = p.loungeOn ? "Leave the lounge: you stay out until you join again" : "Join the lounge: chat with everyone in \(p.title)"
        item.isEnabled = p.canToggleLounge
    }

    @objc private func loungeClicked(_ sender: Any?) {
        model.setLounge(!model.presentation.loungeOn)
    }

    // MARK: Toolbar

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.meID, Self.loungeID]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.meID, Self.loungeID]
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
        case Self.loungeID:
            let item = NSToolbarItem(itemIdentifier: id)
            item.target = self
            item.action = #selector(loungeClicked(_:))
            item.isBordered = true
            item.autovalidates = false
            sync(item, model.presentation)
            loungeItem = item
            return item
        default:
            return nil
        }
    }

    // MARK: Snapshot rendering

    /// The real window, configured for an offscreen PNG render.
    static func makeForSnapshot(model: AppModel, size: NSSize, appearance: NSAppearance.Name) -> (ChatWindowController, ChatWindow) {
        let controller = ChatWindowController(model: model)
        controller.persistsTabSizes = false
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

/// `activate(ignoringOtherApps:)` without its deprecation warning. macOS 14 deprecated it in
/// favor of cooperative activation, which since macOS 26 declines menu bar clicks.
@MainActor private protocol LegacyActivation {
    func activate(ignoringOtherApps flag: Bool)
}

extension NSApplication: LegacyActivation {}
