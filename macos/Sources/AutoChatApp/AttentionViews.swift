import AppKit
import AutoChatCore
import SwiftUI

// The attention queue's views: a row (the panel, and the countdown panel), and the compact strip
// in the chat window. Every string from the daemon is plain text (`Text(verbatim:)`).

enum AttentionStyle {
    static func symbol(_ kind: AttentionKind) -> String {
        switch kind {
        case .blocked: "exclamationmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .finished, .unknown: "checkmark.circle.fill"
        }
    }

    static func tint(_ kind: AttentionKind) -> Color {
        switch kind {
        case .blocked: Palette.orange
        case .failed: Palette.red
        case .finished, .unknown: Palette.green
        }
    }

    /// What "Jump to" does for this kind, for the tooltip.
    static func jumpHelp(_ kind: AttentionKind) -> String {
        kind.isUrgent ? "Go to this agent's terminal to answer it" : "Go to this agent's terminal (and take it off the list)"
    }
}

struct AttentionGlyph: View {
    let kind: AttentionKind
    var size: CGFloat = 15

    var body: some View {
        Image(systemName: AttentionStyle.symbol(kind))
            .font(.system(size: size, weight: .semibold))
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, AttentionStyle.tint(kind))
            // The octagon is wider than the circles: keep the column even.
            .frame(width: size + 3, height: size + 3)
            .accessibilityHidden(true)
    }
}

/// A small round ×.
struct DismissButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 8.5, weight: .bold))
                .frame(width: 20, height: 20)
                .background(Circle().fill(Color.primary.opacity(0.08)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("Dismiss")
        .accessibilityLabel("Dismiss")
    }
}

/// One item: what it is, which agent, where, and Jump to / dismiss.
struct AttentionRow: View {
    let item: AttentionItem
    /// One line of summary (the countdown panel), instead of two for a question.
    var compact = false
    let onJump: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AttentionGlyph(kind: item.kind)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: AttentionRules.title(item))
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.top, 1)
                if let summary = AttentionRules.summary(item) {
                    Text(verbatim: summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(compact || !item.kind.isUrgent ? 1 : 2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 6) {
                    HarnessBadge(harness: item.harness)
                    if let place = AttentionRules.place(item) {
                        Label {
                            Text(verbatim: place)
                        } icon: {
                            Image(systemName: "folder")
                        }
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    Button("Jump to", action: onJump)
                        .buttonStyle(.action(prominent: item.kind.isUrgent, tint: AttentionStyle.tint(item.kind), size: .small))
                        .help(AttentionStyle.jumpHelp(item.kind))
                    DismissButton(action: onDismiss)
                }
                .padding(.top, 1)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(AttentionRules.accessibilityLabel(item))
    }
}

/// The queue, inset in a panel: up to `limit` rows, then "and N more".
struct AttentionList: View {
    let model: AppModel
    let items: [AttentionItem]
    var limit = AttentionRules.panelRows
    var compact = false

    var body: some View {
        let shown = Array(items.prefix(limit))
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { i, item in
                if i > 0 { Divider() }
                AttentionRow(item: item, compact: compact, onJump: { model.jump(to: item) }, onDismiss: { model.dismiss(item) })
                    .padding(.vertical, 8)
            }
            if items.count > shown.count {
                Divider()
                Text(verbatim: "and \(items.count - shown.count) more in the chat")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 6)
            }
        }
        .padding(.horizontal, 10)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(0.045)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5))
    }
}

// MARK: - Chat strip

/// A compact, non-blocking strip at the top of the Lounge tab: the first item on one line, and
/// the rest of the queue one click away. It never covers the messages or the input.
struct AttentionStrip: View {
    let items: [AttentionItem]
    @Bindable var model: AppModel
    /// The request card above the messages shows one more (Copilot's question).
    var besideRequest = false

    var body: some View {
        let expanded = model.attentionExpanded && items.count > 1
        VStack(spacing: 0) {
            if expanded {
                header
                ForEach(items) { item in
                    Divider().padding(.leading, 38)
                    StripRow(item: item, more: 0, model: model)
                }
            } else if let first = items.first {
                StripRow(item: first, more: items.count - 1, model: model)
            }
        }
        .background(Color.primary.opacity(0.035))
        .animation(.smooth(duration: 0.2), value: expanded)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attention: \(AttentionRules.counts(items))")
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "tray.full.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 17)
            Text(besideRequest ? "Your other agents" : "Your agents")
                .font(.callout.weight(.semibold))
            Text(verbatim: AttentionRules.counts(items))
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button {
                model.attentionExpanded = false
            } label: {
                Image(systemName: "chevron.up")
                    .font(.system(size: 10, weight: .bold))
            }
            .buttonStyle(.action(size: .small))
            .help("Show only the first")
            .accessibilityLabel("Collapse")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private struct StripRow: View {
        let item: AttentionItem
        let more: Int
        let model: AppModel

        var body: some View {
            HStack(spacing: 8) {
                AttentionGlyph(kind: item.kind, size: 14)
                Text(verbatim: AttentionRules.title(item))
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                    .layoutPriority(1)
                if let detail {
                    Text(verbatim: detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 6)
                HarnessBadge(harness: item.harness)
                Button("Jump to") { model.jump(to: item) }
                    .buttonStyle(.action(prominent: item.kind.isUrgent, tint: AttentionStyle.tint(item.kind), size: .small))
                    .help(AttentionStyle.jumpHelp(item.kind))
                DismissButton { model.dismiss(item) }
                if more > 0 {
                    Button {
                        model.attentionExpanded = true
                    } label: {
                        HStack(spacing: 3) {
                            Text(verbatim: "+\(more)")
                                .monospacedDigit()
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9, weight: .bold))
                        }
                    }
                    .buttonStyle(.action(size: .small))
                    .help("Show all \(more + 1)")
                    .accessibilityLabel("Show \(more) more")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .help(AttentionRules.accessibilityLabel(item))
            .accessibilityElement(children: .contain)
        }

        /// `· web · Bash: npm run migrate…`
        private var detail: String? {
            let bits = [AttentionRules.place(item), AttentionRules.summary(item)].compactMap { $0 }
            return bits.isEmpty ? nil : "· " + bits.joined(separator: " · ")
        }
    }
}
