// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AutoChat",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AutoChat", targets: ["AutoChat"])
    ],
    targets: [
        // Foundation-only: protocol models, daemon socket client, process supervision, pure UI rules.
        .target(name: "AutoChatCore"),
        // AppKit + SwiftUI: status item, descending panel, chat window, snapshot renderer.
        .target(name: "AutoChatApp", dependencies: ["AutoChatCore"]),
        .executableTarget(name: "AutoChat", dependencies: ["AutoChatApp"]),
        .testTarget(name: "AutoChatCoreTests", dependencies: ["AutoChatCore"]),
        .testTarget(name: "AutoChatAppTests", dependencies: ["AutoChatApp", "AutoChatCore"])
    ]
)
