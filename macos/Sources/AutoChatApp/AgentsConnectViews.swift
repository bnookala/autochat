import AppKit
import AutoChatCore
import SwiftUI

// Connect agents (issue #65): the Agents tab while no agent is here, and the sheet that
// connects tools to the agent room through the daemon (`agents.setupPlan`, `agents.setup`).
// Harness names, paths and reasons come from the daemon: rendered with `Text(verbatim:)`.

/// The whole tab, for a room with nothing in it yet.
struct EmptyRoomView: View {
    let state: AgentsEmptyState
    let detected: DetectedAgents?
    let tier: String?
    let onConnect: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: 14) {
                ZStack {
                    Circle()
                        .fill(Palette.indigo.opacity(0.12))
                        .frame(width: 84, height: 84)
                    Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                        .font(.system(size: 34, weight: .regular))
                        .foregroundStyle(Palette.indigo)
                }
                .padding(.bottom, 2)
                .accessibilityHidden(true)
                Text(verbatim: state.title)
                    .font(.title2.weight(.semibold))
                if let running = state.running {
                    VStack(spacing: 9) {
                        Text(verbatim: running)
                            .font(.body)
                            .foregroundStyle(.secondary)
                        RunningAgentsChips(detected: detected)
                    }
                }
                Text("Agents join this room through autochat's MCP server. Connect your tools once, and their new sessions join on their own.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 400)
                if state.canConnect {
                    Button(action: onConnect) {
                        Label("Connect agents…", systemImage: "link")
                    }
                    .buttonStyle(.action(prominent: true, size: .large))
                    .help("Choose which tools to connect to the agent room")
                    .padding(.top, 4)
                }
                if let hint = state.hint {
                    Label {
                        Text(verbatim: hint)
                    } icon: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
                }
            }
            .padding(30)
            Spacer(minLength: 0)
            Label(AgentsRules.isLocal(tier) ? "Agents on this Mac only. Nothing leaves it." : "Shared agent room", systemImage: AgentsRules.isLocal(tier) ? "lock.fill" : "person.2.fill")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.bottom, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The same, in the sidebar: the room has history or cards, but nobody's here.
struct EmptyBoardBlock: View {
    let state: AgentsEmptyState
    let detected: DetectedAgents?
    let onConnect: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: state.title)
                .font(.callout.weight(.semibold))
            if let running = state.running {
                Text(verbatim: running)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                RunningAgentsChips(detected: detected)
            }
            if let hint = state.hint {
                Text(verbatim: hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if state.canConnect {
                Button(action: onConnect) {
                    Label("Connect agents…", systemImage: "link")
                }
                .buttonStyle(.action(prominent: true, size: .small))
                .padding(.top, 2)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous).fill(Theme.cardFill))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous).strokeBorder(Theme.cardStroke, lineWidth: 0.5))
        .accessibilityElement(children: .contain)
    }
}

/// "Copilot CLI ×2 · Claude Code": what the process scan found, by harness.
struct RunningAgentsChips: View {
    let detected: DetectedAgents?

    var body: some View {
        HStack(spacing: 6) {
            ForEach(AgentsRules.runningByHarness(detected), id: \.harness) { group in
                let style = HarnessBadge.style(group.harness)
                Pill(
                    text: group.count > 1 ? "\(group.harness.displayName) ×\(group.count)" : group.harness.displayName,
                    symbol: style.symbol, glyph: style.glyph, tint: style.tint
                )
                .help(places(group.harness))
            }
        }
    }

    /// Where they run, for the tooltip.
    private func places(_ harness: AgentHarness) -> String {
        let cwds = (detected?.agents ?? []).filter { $0.harness == harness }.compactMap(\.cwd).map { PlainText.clean($0) }
        return cwds.isEmpty ? harness.displayName : cwds.joined(separator: "\n")
    }
}

/// "Connect agents…" under the board while agents are here and a tool isn't connected yet.
struct ConnectRow: View {
    let detail: String?
    let action: () -> Void

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous)
        Button(action: action) {
            HStack(alignment: .center, spacing: 9) {
                Image(systemName: "link.badge.plus")
                    .font(.body)
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connect agents…")
                        .font(.callout.weight(.semibold))
                    if let detail {
                        Text(verbatim: detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(shape.fill(Theme.cardFill.opacity(0.55)))
            .overlay(shape.strokeBorder(Color.primary.opacity(0.16), style: StrokeStyle(lineWidth: 0.75, dash: [3, 2.5])))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .help("Choose which tools to connect to the agent room")
    }
}

// MARK: - The sheet

/// Connect agents…: one row per harness from `agents.setupPlan`, checked when there's
/// something to add or update; Connect sends `agents.setup` with the checked ones and shows
/// what happened.
struct AgentsSetupSheet: View {
    let agents: AgentsModel

    static let command = "autochat setup --agents"

    var body: some View {
        let setup = agents.setup
        VStack(alignment: .leading, spacing: 16) {
            header
            switch setup.phase {
            case .closed, .loading:
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Checking your tools…")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 140)
            case .failed:
                failure(setup.error)
            case .ready, .connecting, .done:
                plans(setup)
            }
            buttons(setup)
        }
        .padding(24)
        .frame(width: 540)
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Palette.indigo.gradient)
                    .frame(width: 42, height: 42)
                Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Connect agents to the agent room")
                    .font(.title3.weight(.semibold))
                Text("autochat adds its MCP server to each tool you pick, so their new sessions join this room. Nothing leaves this Mac.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func plans(_ setup: AgentsSetup) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(spacing: 0) {
                ForEach(Array(setup.plans.enumerated()), id: \.element.id) { index, plan in
                    if index > 0 { Divider().padding(.leading, 40) }
                    SetupPlanRow(plan: plan, setup: setup) { agents.toggleSetup(plan.id) }
                }
            }
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.cardFill))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
            if let error = setup.error {
                Label {
                    Text(verbatim: error)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.callout)
                .foregroundStyle(Palette.red)
            }
            if let summary = AgentsRules.setupSummary(setup) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: summary)
                        .font(.callout.weight(.medium))
                    if !(setup.result?.applied.isEmpty ?? true) {
                        Label(AgentsRules.restartHint, systemImage: "arrow.clockwise")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func failure(_ error: String?) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                Text(verbatim: error ?? "autochat didn't answer.")
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .font(.callout)
            .foregroundStyle(Palette.red)
            Text("You can also connect them from a terminal:")
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Text(verbatim: Self.command)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(Self.command, forType: .string)
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .buttonStyle(.action(size: .small))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.06)))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func buttons(_ setup: AgentsSetup) -> some View {
        HStack(spacing: 10) {
            Spacer(minLength: 0)
            switch setup.phase {
            case .done:
                Button("Done") { agents.closeSetup() }
                    .buttonStyle(.action(prominent: true))
                    .keyboardShortcut(.defaultAction)
            case .failed:
                Button("Cancel") { agents.closeSetup() }
                    .buttonStyle(.action())
                    .keyboardShortcut(.cancelAction)
                Button("Try Again") { Task { await agents.openSetup() } }
                    .buttonStyle(.action(prominent: true))
                    .keyboardShortcut(.defaultAction)
            default:
                Button("Cancel") { agents.closeSetup() }
                    .buttonStyle(.action())
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await agents.connectAgents() }
                } label: {
                    HStack(spacing: 6) {
                        if setup.phase == .connecting { ProgressView().controlSize(.mini).tint(.white) }
                        Text(setup.phase == .connecting ? "Connecting…" : "Connect")
                    }
                }
                .buttonStyle(.action(prominent: true))
                .keyboardShortcut(.defaultAction)
                .disabled(!setup.canConnect)
            }
        }
    }
}

/// One harness: a checkbox for `add` and `update`, a check once it's connected, and the
/// reason when autochat can't do it.
struct SetupPlanRow: View {
    let plan: AgentSetupPlan
    let setup: AgentsSetup
    let toggle: () -> Void

    var body: some View {
        let status = AgentsRules.setupStatus(plan, result: setup.result)
        let failed = setup.result?.failure(plan.id) != nil
        let available = plan.action.isSelectable || status == "connected"
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            mark(status: status, failed: failed)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    let style = HarnessBadge.style(AgentHarness(raw: plan.id))
                    Group {
                        if let symbol = style.symbol { Image(systemName: symbol) } else { Text(verbatim: style.glyph ?? "") }
                    }
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(style.tint)
                    .frame(width: 14)
                    Text(verbatim: PlainText.clean(plan.name))
                        .font(.body.weight(.semibold))
                    Spacer(minLength: 8)
                    SetupStatusPill(status: status)
                }
                if let location = plan.location {
                    Text(verbatim: PlainText.clean(location))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(.leading, 20)
                }
                if let detail = AgentsRules.setupDetail(plan, result: setup.result) {
                    Text(verbatim: detail)
                        .font(.caption)
                        .foregroundStyle(failed ? AnyShapeStyle(Palette.red) : AnyShapeStyle(.secondary))
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 20)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .opacity(available || failed ? 1 : 0.6)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func mark(status: String, failed: Bool) -> some View {
        if failed {
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(Palette.red)
                .accessibilityLabel("failed")
        } else if status == "connected" {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Palette.green)
                .accessibilityLabel("connected")
        } else {
            Toggle(isOn: Binding(get: { setup.checked.contains(plan.id) && plan.action.isSelectable }, set: { _ in toggle() })) {
                Text(verbatim: "Connect \(PlainText.clean(plan.name))")
            }
            .toggleStyle(AccentCheckboxStyle())
            .disabled(!plan.action.isSelectable || setup.phase != .ready)
        }
    }
}

/// A checkbox that keeps its accent fill in sheets that aren't key, as in snapshots (like
/// `ActionButtonStyle`), and reads as a checkbox to accessibility. The label is only for that.
struct AccentCheckboxStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Box(configuration: configuration)
    }

    private struct Box: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let on = configuration.isOn
            let shape = RoundedRectangle(cornerRadius: 3.5, style: .continuous)
            Button {
                configuration.isOn.toggle()
            } label: {
                ZStack {
                    shape
                        .fill(on ? AnyShapeStyle(Color.accentColor.gradient) : AnyShapeStyle(Color(nsColor: .controlBackgroundColor)))
                        .shadow(color: .black.opacity(0.12), radius: 0.5, y: 0.5)
                    shape.strokeBorder(Color.primary.opacity(on ? 0 : 0.28), lineWidth: 0.5)
                    if on {
                        Image(systemName: "checkmark")
                            .font(.system(size: 9, weight: .heavy))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 14, height: 14)
                .opacity(isEnabled ? 1 : 0.75)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityRepresentation {
                Toggle(isOn: configuration.$isOn) { configuration.label }
                    .toggleStyle(.checkbox)
            }
        }
    }
}

/// What happens to a harness: add, update, connected, manual, not installed, failed.
struct SetupStatusPill: View {
    let status: String

    var body: some View {
        let style = Self.style(status)
        Pill(text: status, symbol: style.symbol, tint: style.tint)
    }

    static func style(_ status: String) -> (symbol: String?, tint: Color) {
        switch status {
        case "add": ("plus", Palette.blue)
        case "update": ("arrow.triangle.2.circlepath", Palette.purple)
        case "connected": ("checkmark", Palette.green)
        case "failed": ("xmark", Palette.red)
        case "manual": ("hand.point.up.left", Palette.amber)
        default: (nil, Palette.gray)
        }
    }
}
