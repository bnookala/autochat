// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LolChat",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "LolChat", targets: ["LolChat"])
    ],
    targets: [
        // Foundation-only: protocol models, daemon socket client, process supervision, pure UI rules.
        .target(name: "LolChatCore"),
        // AppKit + SwiftUI: status item, descending panel, chat window, snapshot renderer.
        .target(name: "LolChatApp", dependencies: ["LolChatCore"]),
        .executableTarget(name: "LolChat", dependencies: ["LolChatApp"]),
        .testTarget(name: "LolChatCoreTests", dependencies: ["LolChatCore"]),
        .testTarget(name: "LolChatAppTests", dependencies: ["LolChatApp", "LolChatCore"])
    ]
)
