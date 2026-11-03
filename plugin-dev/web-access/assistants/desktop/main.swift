import SwiftUI
import AppKit
import DeskLinkClient

private final class AssistantDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    // The plugin can reopen its helper after the user closes the last window.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct DeskLinkMac: App {
    @NSApplicationDelegateAdaptor(AssistantDelegate.self) private var delegate
    var body: some Scene { WindowGroup { AssistantView() }.defaultSize(width: 1100, height: 780) }
}
