import AppKit
import AutoChatCore

/// The menu bar icon. Left-click opens the chat; right-click (or ⌥-click) shows the menu.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    struct Actions {
        var openChat: () -> Void
        var openAgents: () -> Void
        var locateCLI: () -> Void
        var toggleLoginItem: () -> Void
        var quit: () -> Void
    }

    let item: NSStatusItem
    private let model: AppModel
    private let actions: Actions

    init(model: AppModel, actions: Actions) {
        self.model = model
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
        let badge = model.badgeCount
        var description = "AutoChat"
        var tooltip = "AutoChat"
        switch state {
        case .disconnected:
            description = "AutoChat (not connected)"
            tooltip = "AutoChat: not connected to autochat"
        case .inLounge:
            description = "AutoChat: in the lounge"
            tooltip = "In the lounge. Click to chat"
        case .outOfLounge:
            description = "AutoChat: not in the lounge"
            tooltip = "AutoChat: not in the lounge"
        }
        // The badge: agents blocked on you (the attention queue's urgent items).
        if badge > 0 {
            description += ", \(AttentionRules.badgeTooltip(badge).lowercased())"
            tooltip = "\(AttentionRules.badgeTooltip(badge)) · \(tooltip)"
        }
        button.image = StatusIcon.image(for: state, badge: badge, description: description)
        button.appearsDisabled = state == .disconnected
        button.toolTip = tooltip
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

        menu.addItem(entry("Open Chat", symbol: "bubble.left.and.bubble.right") { [actions] in actions.openChat() })
        menu.addItem(.separator())

        let roomName = model.snapshot?.room?.display ?? "#lobby"
        let roomLine: String = switch model.snapshot {
        case let s? where s.inRoom: "\(roomName) · \(s.members.count) here"
        case .some: "Room \(roomName) · not in the lounge"
        case nil: "Room \(roomName)"
        }
        menu.addItem(info(roomLine, symbol: "number"))
        // The local agent room: a summary that opens the Agents tab. No panel, no badge.
        if model.connected, let agents = model.snapshot?.agents {
            let line = entry(AgentsRules.menuLine(agents, detected: model.snapshot?.detected), symbol: "lock.fill") { [actions] in actions.openAgents() }
            line.toolTip = "The local agent room on this Mac: open the Agents tab"
            menu.addItem(line)
        }
        menu.addItem(info(daemonLine, symbol: "server.rack"))
        if let handle = model.snapshot?.me?.handle { menu.addItem(info("You are \(handle)", symbol: "person.crop.circle")) }

        // The attention queue: jump to an agent from here too.
        let queue = model.attention
        if !queue.isEmpty {
            menu.addItem(.separator())
            menu.addItem(info("Your agents: \(AttentionRules.counts(queue))", symbol: "tray.full"))
            for item in queue.prefix(AttentionRules.panelRows + 2) {
                let place = AttentionRules.place(item).map { " · \($0)" } ?? ""
                let line = entry("\(AttentionRules.title(item))\(place)", symbol: AttentionStyle.symbol(item.kind)) { [model] in model.jump(to: item) }
                line.toolTip = "Jump to it: \(AttentionRules.accessibilityLabel(item))"
                menu.addItem(line)
            }
        }

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
        menu.addItem(loungeItem())
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

    /// Join the Lounge: in the room while it's checked (`autochat config lounge on|off`).
    private func loungeItem() -> NSMenuItem {
        let on = model.loungeOn
        let item = entry("Join the Lounge", symbol: "person.2") { [model] in model.setLounge(!on) }
        item.state = on ? .on : .off
        item.isEnabled = model.connected
        item.toolTip = "The lounge is a public chat room: you're in it while this is checked"
        return item
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
