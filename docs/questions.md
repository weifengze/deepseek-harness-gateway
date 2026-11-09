# 提问表单（`ask_user_question`）

调用方通过 HTTP 替人回答模型提出的问题。本文只讲网关这一层；模型为什么提问、什么时候提问，
由 DSH 的 `tool-ask-user` 预设决定。

---

## 1. 为什么需要专门做这一层

`ask_user_question` 不是普通的工具调用：它走的是**瀑布事件** `user-questions/request`，
必须有客户端当面给出结论；没人应答时，DSH 不会自己收尾。

这一点与直觉相反，值得写清楚：

| 场景 | 结果 |
|---|---|
| 浏览器界面开着 | 卡片弹出来，用户点选项 |
| **没有任何客户端** | Host 把事件挂在 `pendingRemoteEvents` 里**不结算**（`packages/api/gateway/src/index.ts:startRemoteEvent`），发起那一轮永远等下去 |
| 网关以 `interactions=none` 连接 | 同上——它连 `$events` 流都打不开，等于没有客户端 |

实测（`dsh --profile web` + 网关，`standard` 预设）：一句强制模型提问的输入，
**150 秒没有任何响应体**，客户端断开后才计入 `outcome="cancelled"`。这不是模型慢，
是工具在等一个永远不会来的答案。

网关 0.6.0 起接管这条通道：订阅 `$events`，把提问变成一张可以 HTTP 提交的表单。

---

## 2. 契约

### 2.1 列出待答问题

```http
GET /v1/sessions/{id}/questions
Authorization: Bearer <key>
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "q_3c4e7707-479d-4160-af60-e6c208c5e56f",
      "session_id": "session-45d4e6c2-...",
      "questions": [
        {
          "id": "q1",
          "question": "选 A 还是 B",
          "header": "确认",
          "options": [{ "label": "A" }, { "label": "B" }]
        }
      ],
      "created_at": 1794197262,
      "expires_at": 1794197322
    }
  ],
  "has_more": false
}
```

`questions[].id` 是**模型给的**（提示词里让它写 `q1`），`data[].id` 是**网关给的**，
提交答案时用后者。

### 2.2 提交答案

```http
POST /v1/sessions/{id}/questions/{question_id}/answer
Authorization: Bearer <key>
Content-Type: application/json

{ "answers": [ { "id": "q1", "selected": ["A"] } ] }
```

- `answers[].id` 必须对应 `questions[].id`
- **每个问题恰好一条**，不能少也不能重复（DSH 对形状有硬要求，模型会把它当 tool result 读）
- `selected: []` 表示用户跳过了这个问题，是合法答案
- `selected` 里的值必须是该问题 `options[].label` 之一；`multi_select` 未置为 `true` 时只能选一个
- `custom` 是自由文本补充，可选

成功后返回 `{"object":"question","id":...,"answered_at":...,"declined":false}`。

### 2.3 放弃这次提问

```json
{ "decline": true }
```

工具会收到 `NO_PROVIDER`，模型通常会转而用文字把问题写在回答里（实测原文：
「提问卡片没能送达（没有可用的应答方…），请直接回复 A 或 B。」）。

### 2.4 SSE 事件

`stream: true` 的回合会多两种帧：

```json
{"type":"question","session_id":"...","message_id":"...","question_id":"q_...",
 "questions":[...],"created_at":1794197262,"expires_at":1794197322}

{"type":"question_closed","session_id":"...","question_id":"q_...","reason":"answered"}
```

`reason` ∈ `answered` / `declined` / `timeout` / `channel_closed` / `cancelled` / `shutdown`。
`question` 是**带外**事件：它不属于某条消息，但一定落在发起它的那一轮 SSE 连接上。

`stream: false` 的调用方拿不到帧，只能靠 `GET /questions` 轮询
（会话对象里也带了 `pending_questions` 计数，可以据此判断要不要轮询）。

---

## 3. legacy 与 timed

DSH 的 `tool-ask-user` 有两种形态，网关**只支持 legacy**：

| | legacy（默认） | timed |
|---|---|---|
| 工具行为 | 阻塞到有人回答 | 等 `timeout` 秒，超时返回 pending |
| 请求里带 `callId` | 否 | 是 |
| 投影 `userQuestions` | 不记录 | 记录，可事后补答 |
| 网关支持 | ✅ 本文 | ❌ 未实现 |

legacy 的直接后果，调用方要心里有数：

1. **答案只在网关进程内存里**。网关重启 / 那轮被取消，表单就没了。
2. **没有 `callId`**，所以答案无法"事后补交"给 DSH，只能在 `waitMs` 窗口内提交。
3. 超过 `waitMs` 网关按「放行」处理，工具快速失败，回合继续——不会拖到全局超时。

---

## 4. 配置

```json
"questions": {
  "enabled": true,
  "waitMs": 120000
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 收到提问直接放行（工具以 `NO_PROVIDER` 失败） |
| `waitMs` | `120000` | 表单等待上限，最大 3600000 |

环境变量：`DSH_GATEWAY_QUESTIONS_ENABLED`、`DSH_GATEWAY_QUESTIONS_WAIT_MS`。

**`enabled:false` 不等于「关掉提问通道」。** 事件流照样订阅，只是立刻回 `next`。
这是必须的：网关一旦不接 `$events`，任何瀑布事件都会把那一轮挂死（见第 1 节）。
实测 `enabled:false` 下同一句提示 63 秒收敛（模型重试了两次工具），HTTP 200，不是挂死。

---

## 5. 部署要点

### 5.1 sidecar 模式

网关 `POST /connect` 时带 `interactions=answer`，再打开 `$events` 流；
回包走一元接口 `$events/result`（`{clientId, eventId, outcome}`）。
两个字段名都不能猜错，否则会得到 `gateway/interactions-forbidden`。

不参与的事件（例如 `approval/request`）一律回 `next`，
宿主会按自己的兜底策略收尾（审批是 `unavailable`，即 fail-closed），
与"没有客户端"时完全一致——网关在场不改变任何语义。

### 5.2 插件模式

进程内直接挂 `ctx.on('user-questions/request')`，不需要 `$events`，
也不需要 `interactions=answer`。表单状态与 HTTP 路由和 sidecar 完全一致。

### 5.3 与浏览器界面共存（重要）

DSH 会把同一个 waterfall 投给**所有**会应答的客户端，谁先回谁赢
（`receiveRemoteEventResult` 先到先结算）。所以：

> 同时开着浏览器界面时，提问可能被浏览器抢走并弹卡片，
> 此时 API 调用方的 `GET /questions` 永远是空，那一轮会等浏览器里的人点。

如果这套部署要长期对外提供 API，建议不要在同一实例上开着别人的浏览器标签页；
或者把浏览器标签当作"人工兜底"来用——两种接法都成立，但要有意识地选一个。

---

## 6. 错误码

| 状态 | code | 含义 |
|---|---|---|
| 400 | `invalid_answers` | `answers` 不是数组 / 某项不是对象 |
| 400 | `unknown_question` | `answers[].id` 不属于本次提问 |
| 400 | `duplicate_answer` | 同一个问题答了多次 |
| 400 | `incomplete_answers` | 少答了问题 |
| 400 | `unknown_option` | `selected` 里有该问题没有的选项 |
| 400 | `too_many_selected` | 单选问题选了多个 |
| 409 | `question_not_pending` | 已超时 / 已被撤销 / 不属于该会话 |
| 409 | `questions_disabled` | 部署关闭了 `questions.enabled` |

`question_not_pending` 对「已超时」和「不属于该会话」用同一个码，避免跨会话探测。

---

## 7. 实测记录（2026-11-09，DSH web profile + 网关 0.6.0）

| 场景 | 结果 |
|---|---|
| `stream:true` + 2 秒内提交 `A` | `question` → `question_closed{answered}` → `done`，content「用户选了A。」 |
| `stream:false` + 轮询后提交 `B` | HTTP 200，content「用户选了B。」 |
| `decline:true` | 工具 `NO_PROVIDER`，回合正常结束，模型转文字提问 |
| `questions.enabled:false` | 63 秒收敛，HTTP 200，不悬挂 |
| 断线（SSE 客户端退出） | 提问以 `cancelled` 关闭，不留悬挂 promise |

离线单测：`node scripts/test-questions.mjs` → 21 项（答案校验 8 项 + 中枢行为 13 项）。
