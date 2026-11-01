import AppKit
import AutoChatCore

/// The menu bar icon. Left-click opens the chat; right-click (or ⌥-click) shows the menu.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    struct Actions {
        var openChat: () -> Void
        var openAgents: () -> Void
        var locateCLI: () -> Void
        var togglePause: () -> Void
        var toggleLoginItem: () -> Void
        var quit: () -> Void
    }

    let item: NSStatusItem
    private let model: AppModel
    private let paths: AutochatPaths
    private let actions: Actions

    init(model: AppModel, paths: AutochatPaths, actions: Actions) {
        self.model = model
        self.paths = paths
        self.actions = actions
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        item.autosaveName = "AutoChatStatusItem"
        if let button = item.button {
            button.target = self
            button.action = #selector(clicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.imagePosition = .imageLeading
            button.setAccessibilityLabel("AutoChat")
        }
        observeChanges { [weak self] in self?.render() }
    }

    /// The status item's button frame in screen coordinates (where the panel hangs from).
    var anchorRect: NSRect? {
        guard let button = item.button, let window = button.window else { return nil }
        return window.convertToScreen(button.convert(button.bounds, to: nil))
    }

    private func render() {
        guard let button = item.button else { return }
        let state = model.iconState
        let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
        var title = ""
        var image: NSImage?
        var tooltip = "AutoChat"
        switch state {
        case .disconnected:
            image = Symbols.image("bubble.left.and.bubble.right", description: "AutoChat (not connected)")
            tooltip = "AutoChat: not connected to autochat"
        case .lounge:
            image = Symbols.image("bubble.left.and.bubble.right", description: "AutoChat")
            tooltip = "AutoChat: waiting for autopilot"
        case .autopilot:
            image = Symbols.image("bubble.left.and.bubble.right.fill", description: "AutoChat: autopilot is on")
            tooltip = "Autopilot is on. Click to chat"
        case .needsYou:
            image = Symbols.image("bubble.left.and.exclamationmark.bubble.right.fill", "exclamationmark.bubble.fill", description: "AutoChat: Copilot needs you")
            tooltip = "Copilot needs you"
        case let .countdown(seconds):
            image = Symbols.image("bubble.left.and.bubble.right.fill", description: "AutoChat: back to reality soon")
            title = " \(seconds)"
            tooltip = CountdownClock.title(remaining: seconds)
        }
        let symbol = image?.withSymbolConfiguration(config)
        symbol?.isTemplate = true
        button.image = symbol
        button.appearsDisabled = state == .disconnected
        button.toolTip = tooltip
        if title.isEmpty {
            button.attributedTitle = NSAttributedString(string: "")
        } else {
            button.attributedTitle = NSAttributedString(string: title, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
            ])
        }
    }

    @objc private func clicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return actions.openChat() }
        let wantsMenu = event.type == .rightMouseUp || event.modifierFlags.contains(.option) || event.modifierFlags.contains(.control)
        if wantsMenu {
            showMenu()
        } else {
            actions.openChat()
        }
    }

    private func showMenu() {
        let menu = buildMenu()
        menu.delegate = self
        item.menu = menu
        item.button?.performClick(nil)
    }

    func menuDidClose(_ menu: NSMenu) {
        item.menu = nil
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let phase = model.snapshot?.phase

        menu.addItem(entry("Open Chat", symbol: "bubble.left.and.bubble.right") { [actions] in actions.openChat() })
        menu.addItem(.separator())

        let roomName = model.snapshot?.room?.display ?? "#lobby"
        let roomLine: String
        switch phase {
        case .room?, .spectating?: roomLine = "\(roomName) · \(model.snapshot?.activeCount ?? 0) on autopilot"
        case .lounge?: roomLine = "Room \(roomName) · waiting for autopilot"
        case nil: roomLine = "Room \(roomName)"
        default: roomLine = "\(roomName) · autopilot is over"
        }
        menu.addItem(info(roomLine, symbol: "number"))
        // The local agent room: a summary that opens the Agents tab. No panel, no badge.
        if model.connected, let agents = model.snapshot?.agents {
            let line = entry(AgentsRules.menuLine(agents), symbol: "lock.fill") { [actions] in actions.openAgents() }
            line.toolTip = "The local agent room on this Mac: open the Agents tab"
            menu.addItem(line)
        }
        menu.addItem(info(daemonLine, symbol: "server.rack"))
        if let handle = model.snapshot?.me?.handle { menu.addItem(info("You are \(handle)", symbol: "person.crop.circle")) }

        if model.connected, model.snapshot?.countdown != nil {
            menu.addItem(entry("Return to Reality Now", symbol: "sunrise") { [model] in model.perform(.returnNow) })
        }
        let join = entry("Join Now", symbol: "figure.wave") { [model] in model.perform(.joinNow) }
        join.isEnabled = model.connected && phase == .lounge
        join.toolTip = "Join the room without autopilot (like `autochat ui --now`)"
        menu.addItem(join)

        if model.daemon == .cliMissing {
            menu.addItem(.separator())
            menu.addItem(info("autochat CLI not found", symbol: "exclamationmark.triangle"))
            menu.addItem(entry("Copy Install Command", symbol: "doc.on.doc") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(DaemonLocator.installCommand, forType: .string)
            })
            menu.addItem(entry("Try Again", symbol: "arrow.clockwise") { [model] in model.supervisor?.retry() })
        }

        menu.addItem(.separator())
        let pause = entry("Pause autochat", symbol: "pause.circle") { [actions] in actions.togglePause() }
        pause.state = AutochatConfig.isPaused(paths: paths) ? .on : .off
        pause.isEnabled = model.supervisor?.binary != nil
        pause.toolTip = "autochat config launch off: autopilot runs won't wake autochat"
        menu.addItem(pause)
        let login = entry("Launch at Login", symbol: "power") { [actions] in actions.toggleLoginItem() }
        login.state = LoginItem.isEnabled ? .on : .off
        login.isEnabled = LoginItem.isAvailable
        menu.addItem(login)
        menu.addItem(entry("Set autochat Location…", symbol: "folder") { [actions] in actions.locateCLI() })
        menu.addItem(.separator())
        let quit = entry("Quit AutoChat", symbol: nil) { [actions] in actions.quit() }
        quit.keyEquivalent = "q"
        menu.addItem(quit)
        return menu
    }

    private var daemonLine: String {
        switch model.daemon {
        case .idle, .starting: "Starting autochat…"
        case .attached: model.connected ? "Connected to a running autochat daemon" : "Connecting to autochat…"
        case let .spawned(pid): model.connected ? "autochat daemon running (pid \(pid))" : "Starting autochat daemon (pid \(pid))…"
        case let .restarting(after, code): "autochat daemon exited (\(code)), restarting in \(Int(after.rounded()))s"
        case .cliMissing: "autochat CLI not found"
        case let .failed(why): why
        case .stopping: "Stopping autochat…"
        case .stopped: "autochat stopped"
        }
    }

    private func info(_ title: String, symbol: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        return item
    }

    private func entry(_ title: String, symbol: String?, _ handler: @escaping () -> Void) -> NSMenuItem {
        let item = ClosureMenuItem(title: title, handler: handler)
        if let symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
        return item
    }
}

private final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(title: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError() }

    @objc private func fire() { handler() }
}
