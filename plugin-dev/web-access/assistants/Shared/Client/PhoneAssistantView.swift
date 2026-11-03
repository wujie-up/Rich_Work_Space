import SwiftUI

struct PhoneAssistantView: View {
    @ObservedObject var model: ClientModel
    @State private var managingBinding = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.saved == nil ? "绑定工作台" : "已绑定").font(.headline)
                    if model.browser != nil {
                        Text(model.status).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if model.busy || model.browser != nil {
                    Button { Task { await model.disconnect() } } label: { Image(systemName: "stop.circle") }
                        .help("断开连接并清除网页会话").accessibilityLabel("断开连接并清除网页会话")
                        .frame(minWidth: 44, minHeight: 44)
                } else if model.saved != nil {
                    Button { managingBinding = true } label: { Image(systemName: "gearshape") }
                        .help("管理工作台绑定").accessibilityLabel("管理工作台绑定")
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
            if let error = model.pageError {
                Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled).padding(.horizontal, 20)
            }
            if let browser = model.browser {
                WorkspaceBrowser(context: browser, onFailure: { message in
                    if model.browser?.id == browser.id { model.pageError = message }
                }).id(browser.id)
            } else if model.saved != nil {
                connectionHome
            } else {
                PairingForm(model: model).labelStyle(.iconOnly)
                Text(model.status).font(.callout).textSelection(.enabled).padding(20)
            }
        }
        .sheet(isPresented: $managingBinding) {
            VStack(spacing: 0) {
                HStack {
                    Text("工作台绑定").font(.headline)
                    Spacer()
                    Button { managingBinding = false } label: { Image(systemName: "xmark") }
                        .help("关闭绑定管理").accessibilityLabel("关闭绑定管理")
                        .frame(minWidth: 44, minHeight: 44)
                }.padding(.horizontal, 20)
                PairingForm(model: model).labelStyle(.iconOnly)
                Text(model.status).font(.callout).textSelection(.enabled).padding(20)
            }
            .interactiveDismissDisabled(model.busy)
        }
        .onChange(of: model.busy) { _, busy in
            // Only a completed pairing clears the invitation; failures keep the form available for correction.
            if !busy && model.saved != nil && model.invitation.isEmpty {
                managingBinding = false
            }
        }
        .tint(.primary)
    }

    private var connectionHome: some View {
        GeometryReader { space in
            ScrollView {
                VStack(spacing: 24) {
                    Spacer(minLength: 24)
                    Button { model.begin(pair: false) } label: {
                        ZStack {
                            Circle().fill(.primary.opacity(colorScheme == .dark ? 0.18 : 0.06))
                            Circle().stroke(.primary.opacity(0.2), lineWidth: 1)
                            if model.busy {
                                ProgressView().controlSize(.large)
                            } else {
                                Image(systemName: "power").font(.system(size: 48, weight: .light))
                            }
                        }
                        .frame(width: 176, height: 176)
                        .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.busy)
                    .help("连接工作台").accessibilityLabel("连接工作台")
                    VStack(spacing: 8) {
                        Text(model.busy ? "正在连接" : "点击连接工作台").font(.title3)
                        Text(model.status).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    Spacer(minLength: 24)
                    Text("仅访问已绑定工作台的 Web 服务")
                        .font(.footnote).foregroundStyle(.secondary).padding(.bottom, 24)
                }
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity, minHeight: space.size.height)
            }
        }
    }
}

// Keep first-time and explicit re-pairing on the same approval flow on both platforms.
struct PairingForm: View {
    @ObservedObject var model: ClientModel

    var body: some View {
        Form {
            if let saved = model.saved {
                LabeledContent("已配对工作台", value: String(saved.hostId.prefix(24)))
            }
            TextField("设备名称", text: $model.label).disabled(model.busy)
            Text("粘贴工作台生成的配对邀请，在工作台核对指纹后确认。邀请有效期为两分钟。")
                .font(.callout).foregroundStyle(.secondary)
            TextEditor(text: $model.invitation).frame(minHeight: 100, maxHeight: 180)
                .disabled(model.busy).accessibilityLabel("工作台配对邀请")
            Button { model.begin(pair: true) } label: { Label("请求配对", systemImage: "key") }
                .disabled(model.busy || model.invitation.isEmpty)
                .help("请求配对").accessibilityLabel("请求配对")
            Text("仅连接工作台 Web 服务。已绑定设备连接后直接进入首页；断开后清除本次访问会话，撤销绑定后立即失效。")
                .font(.callout).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }
}
