import SwiftUI

/// Capsule buttons that keep their tint in the never-key status panel and in snapshots
/// (system prominent buttons fall back to gray in inactive windows).
struct ActionButtonStyle: ButtonStyle {
    var prominent = false
    var tint: Color = .accentColor
    var size: ControlSize = .regular

    func makeBody(configuration: Configuration) -> some View {
        StyledLabel(configuration: configuration, prominent: prominent, tint: tint, size: size)
    }

    private struct StyledLabel: View {
        let configuration: ButtonStyleConfiguration
        let prominent: Bool
        let tint: Color
        let size: ControlSize
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.colorScheme) private var colorScheme

        var body: some View {
            let large = size == .large
            configuration.label
                .font(large ? .body.weight(.semibold) : size == .small ? .callout.weight(.medium) : .body.weight(.medium))
                .lineLimit(1)
                .padding(.horizontal, large ? 16 : size == .small ? 10 : 13)
                .padding(.vertical, large ? 8 : size == .small ? 3 : 5)
                .foregroundStyle(prominent ? AnyShapeStyle(Color.white) : AnyShapeStyle(tint == .accentColor ? Color.primary : tint))
                .background(
                    Capsule(style: .continuous)
                        .fill(prominent ? AnyShapeStyle(tint.gradient) : AnyShapeStyle(Color.primary.opacity(colorScheme == .dark ? 0.14 : 0.08)))
                )
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(Color.primary.opacity(prominent ? 0 : 0.06), lineWidth: 0.5)
                )
                .opacity(isEnabled ? (configuration.isPressed ? 0.72 : 1) : 0.45)
                .contentShape(Capsule())
        }
    }
}

extension ButtonStyle where Self == ActionButtonStyle {
    static func action(prominent: Bool = false, tint: Color = .accentColor, size: ControlSize = .regular) -> ActionButtonStyle {
        ActionButtonStyle(prominent: prominent, tint: tint, size: size)
    }
}
