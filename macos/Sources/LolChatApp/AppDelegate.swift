import AppKit
import LolChatCore
import UniformTypeIdentifiers

/// Wires the daemon client/supervisor, the status item and the chat window together, and
/// owns the clean-closeout path on Quit.
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    private let paths = LolchatPaths.current()
    private var client: DaemonClient!
    private var supervisor: DaemonSupervisor!
    private var model: AppModel!
    private var chat: ChatWindowController!
    private var statusItem: StatusItemController!
    private var terminating = false
    private var signalSources: [DispatchSourceSignal] = []

    public func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        // `kill`/Ctrl-C take the same clean-closeout path as Quit.
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            // Terminate from the run loop, not from inside this main-queue callout: the
            // terminate-later wait must be able to drain the main queue for the shutdown task.
            source.setEventHandler {
                RunLoop.main.perform { MainActor.assumeIsolated { NSApp.terminate(nil) } }
            }
            source.resume()
            signalSources.append(source)
        }
        let logs = URL(fileURLWithPath: paths.runDir).appendingPathComponent("daemon.log")
        client = DaemonClient(socketPath: paths.sockPath)
        supervisor = DaemonSupervisor(socketPath: paths.sockPath, logURL: logs)
        model = AppModel(client: client, supervisor: supervisor)
        chat = ChatWindowController(model: model)
        statusItem = StatusItemController(model: model, paths: paths, actions: .init(
            openChat: { [weak self] in self?.openChat() },
            locateCLI: { [weak self] in self?.locateCLI() },
            togglePause: { [weak self] in self?.togglePause() },
            toggleLoginItem: { [weak self] in self?.toggleLoginItem() },
            quit: { NSApp.terminate(nil) }
        ))
        model.start()
    }

    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Finder/Spotlight relaunch opens the chat; a background `open -g` from a hook doesn't.
        if NSApp.isActive { openChat() }
        return false
    }

    public func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateNow }
        terminating = true
        client?.stop()
        guard let supervisor else { return .terminateNow }
        Task { @MainActor in
            // Only signals a daemon this app spawned, then waits up to 3 s for it to leave the room.
            await supervisor.shutdown(timeout: 3)
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    // MARK: Actions

    private func openChat() {
        chat.show()
    }

    private func locateCLI() {
        let open = NSOpenPanel()
        open.title = "Locate the lolchat command"
        open.message = "Choose the lolchat executable (for example /opt/homebrew/bin/lolchat)."
        open.canChooseFiles = true
        open.canChooseDirectories = false
        open.allowsMultipleSelection = false
        open.showsHiddenFiles = true
        open.treatsFilePackagesAsDirectories = true
        if let current = supervisor.binary?.path {
            open.directoryURL = URL(fileURLWithPath: current).deletingLastPathComponent()
        }
        NSApp.activate()
        guard open.runModal() == .OK, let url = open.url else { return }
        UserDefaults.standard.set(url.path, forKey: DaemonLocator.overrideDefaultsKey)
        supervisor.retry()
    }

    private func togglePause() {
        guard let binary = supervisor.binary else { return }
        let paused = LolchatConfig.isPaused(paths: paths)
        let paths = self.paths
        Task {
            if !(await LolchatConfig.setPaused(!paused, paths: paths, binary: binary)) {
                let alert = NSAlert()
                alert.messageText = "Couldn't change the lolchat launch setting"
                alert.informativeText = "Try `lolchat config launch \(paused ? "auto" : "off")` in a terminal."
                alert.runModal()
            }
        }
    }

    private func toggleLoginItem() {
        do {
            try LoginItem.set(!LoginItem.isEnabled)
        } catch {
            let alert = NSAlert(error: error)
            alert.runModal()
        }
    }
}

public enum LolChatMain {
    /// Entry point. Hidden dev mode:
    ///   --render-icon <dir.iconset> write the app icon PNGs, then exit
    @MainActor
    public static func run() {
        let args = CommandLine.arguments
        let app = NSApplication.shared
        if let i = args.firstIndex(of: "--render-icon") {
            let dir = i + 1 < args.count ? args[i + 1] : "AppIcon.iconset"
            exit(IconRenderer.writeIconset(to: URL(fileURLWithPath: dir)) ? 0 : 1)
        }
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}
