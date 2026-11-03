// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "DeskLinkCore", platforms: [.macOS(.v15), .iOS("27.2")],
    products: [.library(name: "DeskLinkCore", targets: ["DeskLinkCore"])],
    targets: [.target(name: "DeskLinkCore"), .executableTarget(name: "CoreCheck", dependencies: ["DeskLinkCore"], path: "Checks"), .testTarget(name: "DeskLinkCoreTests", dependencies: ["DeskLinkCore"])])
