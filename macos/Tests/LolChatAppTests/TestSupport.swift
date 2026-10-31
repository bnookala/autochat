import Foundation
import LolChatCore
@testable import LolChatApp

/// A live-wired model whose client never connects; tests feed it snapshots directly.
@MainActor
func connectedModel() -> AppModel {
    let model = AppModel(
        client: DaemonClient(socketPath: "/nonexistent/ui.sock"),
        supervisor: DaemonSupervisor(socketPath: "/nonexistent/ui.sock", locate: { nil }, ping: { _ in nil })
    )
    model.connectionChanged(.connected)
    return model
}
