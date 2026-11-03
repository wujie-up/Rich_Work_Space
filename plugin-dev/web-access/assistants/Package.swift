// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "DeskLink", platforms: [.macOS(.v15), .iOS("27.2")],
    products: [.library(name: "DeskLinkClient", targets: ["DeskLinkClient"]), .executable(name: "DeskLinkMac", targets: ["DeskLinkMac"])],
    dependencies: [.package(path: "core"), .package(url: "https://github.com/n0-computer/iroh-ffi.git", exact: "1.2.0")],
    targets: [
        .target(name: "DeskLinkClient", dependencies: [.product(name: "DeskLinkCore", package: "core"),
            .product(name: "IrohLib", package: "iroh-ffi")], path: "Shared/Client", resources: [.copy("Resources/WebShell")], swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "ClientTests", dependencies: ["DeskLinkClient"], path: "Tests/ClientTests", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "DeskLinkMac", dependencies: ["DeskLinkClient"], path: "desktop", swiftSettings: [.swiftLanguageMode(.v5)])])
