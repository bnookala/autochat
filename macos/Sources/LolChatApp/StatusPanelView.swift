import AppKit
import LolChatCore
import SwiftUI

/// Content of the descending status bar panel. `kind` is passed separately from the model so
/// the panel keeps its content while it animates away.
struct StatusPanelView: View {
    let model: AppModel
    let kind: PanelKind
    var onOpenChat: () -> Void = {}
    /// Snapshot rendering can't capture behind-window vibrancy; draw an equivalent fill.
    var opaqueBackground = false

    var body: some View {
        Group {
            switch kind {
            case .autopilot: autopilot
            case .countdown: countdown
            case .request: request
            }
        }
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

    // MARK: Autopilot is on

    private var autopilot: some View {
        HStack(alignment: .center, spacing: 12) {
            Badge(symbol: "airplane", colors: [Color(red: 0.36, green: 0.42, blue: 1.0), Color(red: 0.70, green: 0.36, blue: 0.95)])
            VStack(alignment: .leading, spacing: 2) {
                Text("Autopilot is on")
                    .font(.headline)
                Text(verbatim: autopilotLine)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text("Click the menu bar icon to chat.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private var autopilotLine: String {
        let n = model.snapshot?.activeCount ?? 1
        let room = model.snapshot?.room?.display ?? "#lobby"
        return "\(n) on autopilot in \(room)"
    }

    // MARK: Back to reality in Ns

    private var countdown: some View {
        let c = model.countdown
        let remaining = model.countdownRemaining ?? 0
        let fraction = c.map { CountdownClock.fractionLeft(endsAt: $0.endsAt, total: $0.total, now: model.now) } ?? 0
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                CountdownRing(remaining: remaining, fraction: fraction)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: CountdownClock.title(remaining: remaining))
                        .font(.headline)
                        .monospacedDigit()
                        .contentTransition(.numericText(countsDown: true))
                    Text(verbatim: countdownDetail(c))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                Button(action: onOpenChat) {
                    Text("Open Chat").frame(maxWidth: .infinity)
                }
                .buttonStyle(.action(size: .large))
                Button {
                    model.perform(.returnNow)
                } label: {
                    Text("Return Now").frame(maxWidth: .infinity)
                }
                .buttonStyle(.action(prominent: true, tint: Theme.countdown, size: .large))
                .disabled(remaining == 0)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func countdownDetail(_ c: Countdown?) -> String {
        var bits = [CountdownClock.reasonPhrase(c?.reason)]
        if let cwd = c?.cwd, !cwd.isEmpty { bits.append(PlainText.clean(cwd)) }
        return bits.joined(separator: " · ")
    }

    // MARK: Copilot needs you

    private var request: some View {
        let r = model.snapshot?.request
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Badge(symbol: "exclamationmark.bubble.fill", colors: [Color.orange, Color.yellow])
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: PlainText.clean(r?.title ?? "Copilot needs you"))
                        .font(.headline)
                    if let message = r?.message, !message.isEmpty {
                        Text(verbatim: PlainText.clean(message))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                    if let cwd = r?.cwd, !cwd.isEmpty {
                        Text(verbatim: "in \(PlainText.clean(cwd))")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                Button(action: onOpenChat) {
                    Text("Open Chat").frame(maxWidth: .infinity)
                }
                .buttonStyle(.action(size: .large))
                Button {
                    model.perform(.jumpToCopilot)
                    model.dismissRequestPanel()
                } label: {
                    Text("Jump to Copilot").frame(maxWidth: .infinity)
                }
                .buttonStyle(.action(prominent: true, tint: .orange, size: .large))
            }
        }
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

/// Seconds left inside a ring that drains with the countdown.
struct CountdownRing: View {
    let remaining: Int
    let fraction: Double

    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.countdown.opacity(0.18), lineWidth: 4)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(Theme.countdown, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(verbatim: "\(remaining)")
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText(countsDown: true))
        }
        .frame(width: 40, height: 40)
        .animation(.linear(duration: 0.35), value: remaining)
        .accessibilityLabel("\(remaining) seconds left")
    }
}
