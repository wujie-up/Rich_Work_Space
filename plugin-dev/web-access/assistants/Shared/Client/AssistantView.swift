import SwiftUI

public struct AssistantView: View {
    @StateObject private var model = ClientModel()
    @Environment(\.scenePhase) private var phase
    public init() {}

    public var body: some View {
        Group {
            #if os(iOS)
            PhoneAssistantView(model: model)
            #else
            desktop
            #endif
        }
        .onChange(of: phase) { _, value in
            #if os(iOS)
            Task { await model.sceneChanged(value) }
            #endif
        }
    }

    private var desktop: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(model.status).font(.callout).textSelection(.enabled)
                Spacer()
                if model.busy || model.browser != nil {
                    Button { Task { await model.disconnect() } } label: { Image(systemName: "stop.circle") }
                        .help("断开连接并清除网页会话").accessibilityLabel("断开连接并清除网页会话")
                } else if model.saved != nil {
                    Button { model.begin(pair: false) } label: { Image(systemName: "link") }
                        .help("连接工作台").accessibilityLabel("连接工作台")
                }
            }
            if let error = model.pageError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let browser = model.browser {
                WorkspaceBrowser(context: browser, onFailure: { message in
                    if model.browser?.id == browser.id { model.pageError = message }
                }).id(browser.id)
            } else {
                PairingForm(model: model)
            }
        }
        .padding(12)
    }
}
