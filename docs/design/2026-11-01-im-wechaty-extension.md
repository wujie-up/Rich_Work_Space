# IM 插件接入 Wechaty 网页协议

场景：多个 IM 渠道通过独立插件向 Agent 会话投递消息并回传本轮结果。

主要矛盾：渠道协议与账号生命周期变化频繁，而 Agent 会话能力应保持独立。渠道适配必须留在消息插件，不能让 Agent 理解微信扫码、飞书事件或关键词路由。

本次范围仅为 `plugin-dev/message-bridge/` 及方案、验收记录。不修改 desk 或 AI 插件；继续通过宿主 `desk.capabilities.v1` 调用 AI 已有的会话目录、绑定、提交、读取等能力。消息插件负责会话选择、来源映射、规则、凭据、连接与回传。

微信默认采用 Wechaty + `wechaty-puppet-wechat4u@1.14.14`，直接连接网页协议，不需要 Puppet Service Token。已有 Service 渠道按旧 Token/端点识别并继续工作，界面可显式选择 Puppet；已有 iLink 渠道保留。网页登录资格和真实收发必须以目标账号测试为准，不依据 SDK 加载成功宣称上线通过。网页协议重新登录可能改变联系人/群 ID，规则按实际 ID 匹配，不按昵称猜测身份；变更后从最近来源更新白名单。

实施顺序：先补充默认网页与旧 Service 配置的失败测试，再实现 Puppet 选择与配置界面，验证原有路由/会话/出站链路，构建 0.1.1 并在临时目录验证包与独立进程。

可验证指标：免 Token 能创建网页 Puppet；旧配置仍创建 Service Puppet；无 Service Token 不发起连接；私聊/群聊均回到原会话且忽略自身消息；UI 默认网页且切换凭据字段准确；构建包包含网页依赖与完整性清单；消息插件崩溃不影响 AI 插件，重启后配置与历史保留。真实扫码、私聊、群聊与重新登录单列验收，不与模拟测试混计。

参考：[Wechaty Puppet 规范](https://wechaty.js.org/docs/specs/puppet)、[WeChat4U Provider](https://wechaty.js.org/docs/puppet-providers/wechat4u/)。

实施已完成，分发版本 0.1.1；实际验证、账号验收边界与安装包信息见 [验收记录](2026-11-01-im-wechaty-verification.md)。
