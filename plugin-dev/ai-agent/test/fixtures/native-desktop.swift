import Cocoa

// A disposable application keeps native mouse and keyboard checks away from user documents.
final class ProbeWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}

final class Probe: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    var window: NSWindow!
    var field: NSTextField!
    let path = CommandLine.arguments[1]

    func save() {
        let screen = NSScreen.screens[0].frame
        let point = window.convertPoint(toScreen: NSPoint(x: field.frame.midX, y: field.frame.midY))
        let scale = min(1, 1280 / screen.width)
        let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "text": field.stringValue,
            "x": Int(point.x * scale), "y": Int((screen.height - point.y) * scale)]
        try! JSONSerialization.data(withJSONObject: state).write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let screen = NSScreen.screens[0].frame
        window = ProbeWindow(contentRect: screen, styleMask: [.borderless], backing: .buffered, defer: false)
        window.backgroundColor = .white
        window.level = .floating
        field = NSTextField(frame: NSRect(x: screen.width / 2 - 250, y: screen.height / 2, width: 500, height: 40))
        field.placeholderString = "Disposable native SDK verification"
        field.isEditable = true
        field.isSelectable = true
        field.isBezeled = true
        field.drawsBackground = true
        field.delegate = self
        window.contentView!.addSubview(field)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(field)
        NSApp.activate(ignoringOtherApps: true)
        save()
    }

    func controlTextDidChange(_ notification: Notification) { save() }
}

let app = NSApplication.shared
let probe = Probe()
app.setActivationPolicy(.regular)
app.delegate = probe
app.run()
