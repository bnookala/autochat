import AppKit
import LolChatCore
import SwiftUI

/// Single-instance window opened from the status item. Closing only hides it; it
/// remembers its frame.
@MainActor
final class ChatWindowController: NSObject, NSWindowDelegate {
    private let model: AppModel
    private var _window: NSWindow?

    var window: NSWindow {
        if let _window { return _window }
        let w = makeWindow()
        _window = w
        return w
    }

    init(model: AppModel) {
        self.model = model
        super.init()
    }

    func show() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    func hide() {
        _window?.orderOut(nil)
    }

    private func makeWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 540, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 420, height: 420)
        window.title = "LolChat"
        window.delegate = self
        window.tabbingMode = .disallowed
        window.contentViewController = NSHostingController(rootView: ConnectionStatusView(model: model))
        window.setContentSize(NSSize(width: 540, height: 620))
        window.center()
        window.setFrameAutosaveName("LolChatChatWindow")
        return window
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()
        return false
    }
}

/// What the app knows about lolchat right now: connection, daemon, room and phase.
struct ConnectionStatusView: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            content
            Spacer(minLength: 0)
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var content: some View {
        switch (model.daemon, model.connection) {
        case (.cliMissing, _):
            Image(systemName: "shippingbox")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(.secondary)
            Text("lolchat CLI not found")
                .font(.title2.weight(.semibold))
            Text("LolChat runs the lolchat command-line tool in the background. Install it, then try again:")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 360)
            Text(verbatim: DaemonLocator.installCommand)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
            Button("Try Again") { model.supervisor?.retry() }
        case let (.restarting(after, code), _):
            ProgressView().controlSize(.small)
            Text(verbatim: "lolchat daemon exited with code \(code). Restarting in \(Int(after.rounded()))s.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        case let (.failed(why), _):
            Text(verbatim: why)
                .multilineTextAlignment(.center)
        case let (_, .incompatible(why)):
            Text("lolchat is running in a terminal")
                .font(.title3.weight(.semibold))
            Text(verbatim: why)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        case (_, .connected):
            Image(systemName: model.snapshot?.phase.isInRoom == true ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(.secondary)
            Text(verbatim: model.snapshot?.room?.display ?? "#lobby")
                .font(.title2.weight(.semibold))
            Text(verbatim: model.snapshot?.phase.isInRoom == true ? "\(model.snapshot?.activeCount ?? 0) on autopilot" : "Waiting for autopilot")
                .foregroundStyle(.secondary)
            if model.snapshot?.phase == .lounge {
                Button("Join Now") { model.perform(.joinNow) }
            }
        default:
            ProgressView()
            Text("Connecting to lolchat…")
                .foregroundStyle(.secondary)
        }
    }
}
