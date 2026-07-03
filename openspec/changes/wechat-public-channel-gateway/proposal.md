## Why

open-tag 已经具备频道、任务和 agent 协作的核心能力，但还缺一个外部入口把真实业务流量接进来。这个 change 先用个人微信 bot 作为 MVP 通道，把消息接到默认公开频道 `#all`，验证“微信只是 I/O 终端，真正的路由和执行在 open-tag 核心里”。

## What Changes

- 新增一个 WeChat gateway/adapter 层，负责接收个人微信 bot 消息并转换为 open-tag 标准输入。
- 将个人微信 bot 绑定到 open-tag 默认公开频道 `#all`，作为首个可用入口。
- 解析 `@Bot #角色` 形式的显性指令，把任务投递到 open-tag 现有 agent/任务能力。
- 将 open-tag 的任务状态和关键结果以微信文本消息回传给 bot。
- 保持微信侧足够薄，不把微信 API 直接写入 open-tag 核心消息流。

## Capabilities

### New Capabilities
- `wechat-public-channel-gateway`: 个人微信 bot 作为 open-tag `#all` 频道的入口，支持显性指令唤起 agent 并回传结果。

### Modified Capabilities
- `channel-core`: 公共频道需要支持来自外部网关的标准化消息输入与任务唤起路径。
- `task-routing`: 任务创建与 agent 唤起的入口增加 WeChat gateway 来源。

## Impact

- 新增微信网关适配层代码与配置。
- 影响 open-tag 的消息入口、任务投递和状态回传路径。
- 需要补充端到端验证，确认微信消息能进入 `#all` 并触发 agent 处理。
