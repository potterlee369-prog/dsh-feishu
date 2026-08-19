# dsh-feishu

DSH 宿主插件：**用飞书控制本机 DSH**。手机或电脑上的飞书客户端给机器人发 `@dsh <指令>`，插件通过飞书**长连接**（WebSocket，无需公网 IP）收到消息，把指令作为用户消息投递给一个专属 DSH 会话执行完整 agent 流程（工具调用、读写工作区、权限审批都在本机 DSH 内完成），等 DSH 空闲后把最终回复发回同一个飞书会话——手机和 PC 双端同步可见。

```
手机飞书 / PC 飞书  ──►  飞书服务器  ──长连接──►  dsh-feishu 插件（跑在 dsh web/headless 进程内）
                                                      │
                                    创建/复用 DSH 会话（ctx.apiProxy.sessions）
                                                      │
                                    DSH Agent 执行（工具、工作区、权限）
                                                      │
飞书双端看到回复  ◄── im.message.create ──────────────┘
```

## 飞书后台要求（配置过一次即可）

1. 飞书开放平台 → 自建应用 → **开通机器人能力**（建议机器人名就叫 `dsh`，群聊里 @ 它）。
2. 复制 **App ID**（`cli_...`）与 **App Secret**。
3. 权限管理添加（以应用身份开通）：
   - `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息）——私聊必须
   - `im:message.group_at_msg:readonly`（读取群聊中 @ 机器人的消息）——群聊必须
   - `im:message:send_as_bot`（以机器人身份发消息）
   - 如果希望机器人读取群里**所有**消息（不 @ 也触发），再额外加 `im:message.group_msg`
4. 事件与回调：
   - 订阅 **接收消息 `im.message.receive_v1`**
   - 订阅方式选 **“使用长连接接收事件”**
5. **创建应用版本并发布**（组织内可用即可，无需上架）。修改权限或事件后必须发新版，否则不会生效。

## 构建与安装

```powershell
cd E:\dsh_custom\dsh-feishu
npm install      # 首次
node build.mjs   # 产出 lib/index.js + lib/index.d.ts
node smoke-test.mjs

# 安装到 web profile（link 方式，源码改动即时生效）
dsh plugin --profile web add "E:\dsh_custom\dsh-feishu"
```

## 配置 App ID / App Secret（推荐：设置页面）

重启 `dsh web` 后打开 **设置 → 飞书**，在页面上填写：

- **App ID**（`cli_...`）与 **App Secret**；
- 触发词、工作目录等可选项；
- 点 **保存** —— 凭据变化会立即重连飞书长连接，无需再重启。

设置保存在本机 DSH 设置文档中（`settings` 服务），也可以在 `cordis.patch.yml` 里给 `feishu` 行写 `appId`/`appSecret` 作为底层默认值，页面保存的值会覆盖它：

```yaml
- id: feishu
  name: dsh-feishu
  config:
    appId: ''                       # 可留空，在 设置 → 飞书 里填
    appSecret: ''
    trigger: '@dsh'
    cwd: E:\your\workspace          # DSH 会话工作目录（留空 = 宿主默认）
```

> App ID / Secret 也可以用环境变量 `DSH_FEISHU_APP_ID`、`DSH_FEISHU_APP_SECRET`；环境变量仅在配置值为空时兜底。

## 使用

| 场景 | 操作 |
|---|---|
| 单聊机器人 | **直接发消息**即可（默认私聊免 @，例如发“帮我看看当前目录有哪些文件”） |
| 群聊 | 把机器人拉进群，发 `@dsh 帮我写一个周报`，只有 @ 它才触发 |
| 发图片（私聊） | 直接发图片，DSH 会调用本机 `dsh-image-recognizer` 识别后回复 |
| 发图片（群聊） | 在群里 @机器人 后发图片，机器人识别后回复 |
| 发文件（私聊） | 直接发送文件；文件会下载到 DSH 工作目录的 `.feishu-inbox/`，然后交给当前会话处理 |
| 发文件（群聊） | 在群里 @机器人 后发送文件；文件会下载到 `.feishu-inbox/`，然后交给当前会话处理 |
| 从 DSH 发文件回飞书 | 发送 `/send <工作目录内的路径>`，例如 `/send reports/final.pdf`；成功后只发送文件附件，不额外发送确认文本 |
| 私聊也要 @ | 在设置页关闭“私聊免 @ 触发”，或把 `p2pNoTrigger` 配为 `false` |
| 全部消息触发 | 把 `trigger` 配成空字符串 `''` |

内置命令（私聊直接发命令，群聊前缀 `@dsh `）：

| 命令 | 作用 |
|---|---|
| `/help` | 显示帮助 |
| `/status` | 桥接状态（长连接、工作目录、会话数） |
| `/new`（`/reset`） | 为当前飞书会话开启新的 DSH 会话，清空上下文 |
| `/send <路径>` | 将 DSH 工作目录内的普通文件上传并发送到当前飞书会话（也支持 `/发送 <路径>`），成功后不发送文字确认 |

每个飞书会话（chat_id）对应一个独立的 DSH 会话，历史上下文会跨消息保留；同一会话内消息按到达顺序**串行执行**，不会互相打断。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `appId` | `''` | 飞书 App ID；空则读 `DSH_FEISHU_APP_ID` |
| `appSecret` | `''` | 飞书 App Secret；空则读 `DSH_FEISHU_APP_SECRET` |
| `trigger` | `'@dsh'` | 群聊（及关闭免 @ 时的私聊）触发前缀；`''` = 每条文本消息都触发 |
| `p2pNoTrigger` | `true` | 私聊免 @：单聊机器人直接发消息即触发 |
| `cwd` | `''` | 飞书消息创建的 DSH 会话工作目录；空 = 宿主默认 |
| `agentPreset` | `''` | 可选 agent preset id |
| `ack` | `true` | DSH 执行前先回复“收到，DSH 处理中…” |
| `replyChunkSize` | `1800` | 长回复按字符预算分段（段落边界处切开） |
| `timeoutMs` | `600000` | 等 DSH 空闲的上限；超时回复“仍在处理中” |

## 工作原理

- 插件依赖宿主服务：`apiProxy`、`agents`、`sessions`（在 `inject` 中声明）。
- 收到触发消息后调用 `ctx.apiProxy.sessions.create({ sessionId, cwd })` —— 与 Web 输入框相同的会话创建路径，sessionId 固定为 `feishu-<chat_id>`，重启后同 id 恢复既有会话。
- 每个飞书会话首次使用前读取宿主 `host.describe` 的默认 provider/model；若历史请求头仍记录旧路由，则调用 `session.selectModel` 同步到当前默认模型，再提交消息。
- 然后 `ctx.apiProxy.sessions.prompt({ mode: 'queue', content })` 把消息投进 DSH agent 的收件箱；文字消息传 `{ type: 'text' }`，图片消息会先下载飞书图片并传 `{ type: 'image', mediaType, data }`，由本机 `dsh-image-recognizer` 识别后交给 DSH。
- 通用文件消息会通过 `messageResource` 下载到该会话工作目录的 `.feishu-inbox/`，再以包含相对路径的文字提示投递给 DSH；这避免把通用文件伪装成当前宿主只支持的图片附件。
- `agent.whenIdle()` 等待本轮全部活动（含工具调用与后续轮次）结束，再从会话事件流中取出最后一个 `assistant/message` 的文本块，经 `client.im.message.create` 发回飞书。
- `/send` 只允许读取当前 DSH 工作目录内的普通文件，单文件按飞书机器人接口限制不超过 30 MB；飞书消息资源下载按接口限制不超过 100 MB。
- 飞书长连接由官方 `@larksuiteoapi/node-sdk` 的 `WSClient` 维护，自动重连；插件卸载时关闭连接。

## 排查

| 现象 | 处理 |
|---|---|
| 设置页没有“飞书”栏目 | 确认已运行 `dsh plugin --profile web add`，并**重启 `dsh web`** 后刷新页面 |
| 启动日志提示 `appId/appSecret not configured` | 打开 设置 → 飞书 填写并保存，或设置环境变量后重启 |
| 设置页显示“设置服务不可用” | 宿主未挂载 settings 服务；改在 cordis.patch.yml 配置 |
| 日志出现 `invalid appId` | App ID 必须是 `cli_` + 16 位十六进制格式 |
| 长连接一直 `not ready` / `onError` | 确认事件订阅方式选了“长连接”，App Secret 正确，机器没断网（长连接由本机主动连出，不需要公网） |
| 长连接已 `ready` 但完全收不到飞书事件 | 重点检查：`im.message.receive_v1` 是否已订阅；是否开通 `im:message.p2p_msg:readonly`（私聊）/ `im:message.group_at_msg:readonly`（群聊 @）；**应用版本是否已发布**。只加 `im:message` 或只改配置不发布，都会出现这种“连接正常但没事件”的情况 |
| 飞书收到消息但机器人不回复 | 检查 `im.message.receive_v1` 订阅、`im:message.p2p_msg:readonly`/`im:message.group_at_msg:readonly`/`im:message:send_as_bot` 权限、应用版本是否已发布；群聊里机器人要被拉进群 |
| 文件收到了但 DSH 找不到 | 检查提示中的 `.feishu-inbox/<文件名>`，该路径相对于当前 DSH 工作目录；文件消息在群聊中必须 @ 机器人 |
| 文件发送失败 | `/send` 只接受当前 DSH 工作目录内的普通文件，且单文件不能超过 30 MB；确认机器人仍在会话中并拥有 `im:message:send_as_bot` |
| 回复“无法创建 DSH 会话: session-conflict” | 同一 `feishu-<chat_id>` 会话曾在别的 `cwd` 下创建过；改 `cwd` 或发 `/new` 换会话 |
| 发送失败 `code ...` | 机器人未加入群、或应用可用范围不含该用户；看日志中的飞书错误码 |

## 开发循环

```powershell
cd E:\dsh_custom\dsh-feishu
node build.mjs         # 修改 src/index.ts 或 src/client 后重新构建
node smoke-test.mjs    # 宿主半侧冒烟（mock 宿主，不联网）
node client-smoke.mjs  # 客户端 bundle 工厂形态
# 重启 dsh web 生效
```
