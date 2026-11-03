import AppKit
import AutoChatCore
import SwiftUI

/// Content of the descending status bar panel: your agents that need you (the attention queue).
struct StatusPanelView: View {
    let model: AppModel
    var onOpenChat: () -> Void = {}
    /// Snapshot rendering can't capture behind-window vibrancy; draw an equivalent fill.
    var opaqueBackground = false

    var body: some View {
        attention
            .padding(14)
            .frame(width: Theme.panelWidth, alignment: .leading)
            .background {
                if opaqueBackground {
                    RoundedRectangle(cornerRadius: Theme.panelCorner, style: .continuous)
                        .fill(Color(nsColor: .windowBackgroundColor).opacity(0.97))
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: Theme.panelCorner, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.5)
            }
            .contentShape(RoundedRectangle(cornerRadius: Theme.panelCorner, style: .continuous))
            .onTapGesture(perform: onOpenChat)
    }

    /// Comes down when an agent is blocked on you; lists the whole queue, urgent first.
    private var attention: some View {
        let items = model.attention
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                Badge(symbol: "exclamationmark.bubble.fill", colors: [Color.orange, Color.yellow])
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: AttentionRules.headline(items))
                        .font(.headline)
                    Text(verbatim: AttentionRules.subheadline(items))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            AttentionList(model: model, items: items)
            Button(action: onOpenChat) {
                Text("Open Chat").frame(maxWidth: .infinity)
            }
            .buttonStyle(.action(size: .large))
        }
        .accessibilityElement(children: .contain)
    }
}

/// App-icon-like rounded square with an SF Symbol, as in a notification.
struct Badge: View {
    let symbol: String
    let colors: [Color]

    var body: some View {
        RoundedRectangle(cornerRadius: 9, style: .continuous)
            .fill(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: 38, height: 38)
            .overlay {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .accessibilityHidden(true)
    }
}
