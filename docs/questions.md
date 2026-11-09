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
      "id": "call_00_iMUJVzGZKLSDDdzYnh609463",
      "call_id": "call_00_iMUJVzGZKLSDDdzYnh609463",
      "session_id": "session-09cbf8cf-...",
      "state": "continued",
      "can_answer_late": true,
      "questions": [
        {
          "id": "q1",
          "question": "选 A 还是 B",
          "header": "确认",
          "options": [{ "label": "A" }, { "label": "B" }]
        }
      ]
    }
  ],
  "has_more": false
}
```

两个 id 不要混：`questions[].id` 是**模型给的**（提示词里让它写 `q1`），`data[].id` 是
**网关给的**（timed 模式下就是 `callId`），提交答案时用后者。

`state` 有 `open` / `continued` 两种，见第 3.1 节。

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

响应带 `mode`，标明走的是哪条路：

```json
{"object":"question","id":"call_00_...","session_id":"session-...","mode":"late",
 "answered_at":1794208687,"declined":false}
```

`mode: "live"` = 窗口内，答案直接回了 waterfall；`mode: "late"` = 超时后补答，
答案作为一条 `user-question-reply` 用户消息 steer 回会话，DSH 会接着跑一轮。

### 2.3 放弃这次提问

```json
{ "decline": true }
```

工具会收到 `NO_PROVIDER`，模型通常会转而用文字把问题写在回答里（实测原文：
「提问卡片没能送达（没有可用的应答方…），请直接回复 A 或 B。」）。

只对窗口内（`state: "open"`）的问题有效；已经 `continued` 的问题要拒绝就直接不再提交。

### 2.4 SSE 事件

`stream: true` 的回合会多两种帧：

```json
{"type":"question","session_id":"...","message_id":"...","question_id":"call_00_...",
 "questions":[...],"created_at":1794197262,"expires_at":1794197322}

{"type":"question_closed","session_id":"...","question_id":"call_00_...","reason":"answered"}
```

`reason` ∈ `answered` / `declined` / `timeout` / `channel_closed` / `cancelled` / `shutdown`。
`question` 是**带外**事件：它不属于某条消息，但一定落在发起它的那一轮 SSE 连接上。

`stream: false` 的调用方拿不到帧，只能靠 `GET /questions` 轮询
（会话对象里也带了 `pending_questions` 计数，可以据此判断要不要轮询）。

---

## 3. legacy 与 timed：两种形态都支持

DSH 的 `tool-ask-user` 有两种形态，网关两条都接：

| | legacy（默认） | timed |
|---|---|---|
| 工具行为 | 阻塞到有人回答 | 等 `timeout` 秒，超时返回 `pending` |
| 请求里带 `callId` | 否 | 是（`request.wait.callId`） |
| 超过窗口后 | 工具失败（`NO_PROVIDER`） | 回合照常结束，问题留在投影里 |
| 事后补答 | ❌ 不支持 | ✅ 走 `userQuestions/answer` |
| 网关支持 | ✅ | ✅ |

### 3.1 同一个 id 贯穿两个阶段

timed 模式下网关直接把 `callId` 当作 `question_id` 用（legacy 没有 `callId`，才生成 `q_...`）。
所以「窗口内」和「超时后补答」两个阶段用的是**同一个标识**，调用方不需要自己做映射。

`GET /questions` 的每一项都有 `state`：

| state | 含义 | 怎么答 |
|---|---|---|
| `open` | 工具正在前台等（窗口内），带 `expires_at` | `POST .../answer`，走 waterfall |
| `continued` | 已超时，问题是 pending（**不是跳过**），带 `can_answer_late: true` | `POST .../answer`，走 `userQuestions/answer` 补答 |

两种条目用**同一个 URL**：网关先找内存里的表单，找不到再按 `callId` 去会话投影里补答。
调用方不必区分自己拿到的是哪一种。

### 3.2 legacy 的边界（timed 没有）

1. **答案只在网关进程内存里**。网关重启 / 那轮被取消，表单就没了。
2. **没有 `callId`**，答案无法事后补交给 DSH，只能在 `waitMs` 窗口内提交。
3. 超过 `waitMs` 网关按「放行」处理，工具快速失败，回合继续——不会拖到全局超时。

timed 的第 2 条不成立：`continued` 的问题即使网关重启也还在投影里，重新 `GET /questions` 就能看到。
第 1 条也不成立——补答是 DSH 自己落成消息，不依赖网关内存。

### 3.3 怎么开 timed

timed 是 DSH 侧的设置：给 preset 里的 `tool-ask-user` 加 config。默认是 legacy。

注意 **patch 的 `config` 是整体替换、不是深合并**：

```yaml
# timed.yml —— 用 dsh --patch ./timed.yml 叠加，或写进 profile 的 cordis.patch.yml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # ... 原样照抄 standard.patch.yml 的 plugins ...
      - id: tool-ask-user
        name: '@deepseek-ai/dsh-tool-ask-user'
        config:
          mode: timed
          timeout: 40
```

只写 `plugins:` 一项会把整个 preset 打坏，启动报 `$.id missing required value`——
因为 `id` / `order` 被一并抹掉了。

验证：

```bash
dsh --profile web --patch ./timed.yml --dump-config | grep -A4 'id: tool-ask-user'
# 应当看到 mode: timed
```

`--patch` 是**启动器选项**，必须写在 app 参数之前：
`dsh --profile web --patch ./timed.yml --port 3080`。
写在 `--port` 后面会得到 `error: unknown option '--patch'`。

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
| `waitMs` | `120000` | 窗口内表单的等待上限，最大 3600000；与 timed 的 `timeout` 各管一段 |

环境变量：`DSH_GATEWAY_QUESTIONS_ENABLED`、`DSH_GATEWAY_QUESTIONS_WAIT_MS`。

`waitMs` 与 `timeout` 的关系：`timeout` 是模型那侧的等待（决定什么时候变成 `continued`），
`waitMs` 是网关这侧的（决定窗口内表单什么时候放弃）。取小者先生效。

**`enabled:false` 不等于「关掉提问通道」。** 事件流照样订阅，只是立刻回 `next`。
这是必须的：网关一旦不接 `$events`，任何瀑布事件都会把那一轮挂死（见第 1 节）。
实测 `enabled:false` 下同一句提示 63 秒收敛（模型重试了两次工具），HTTP 200，不是挂死。

---

## 5. 部署要点

### 5.1 sidecar 模式

网关 `POST /connect` 时带 `interactions=answer`，再打开 `$events` 流；
回包走一元接口 `$events/result`（`{clientId, eventId, outcome}`）。
两个字段名都不能猜错，否则会得到 `gateway/interactions-forbidden`。

补答走另一个接口 `userQuestions/answer`，线上第一个参数是 **SessionId**（生成代码里叫 `agentId`）：

```ts
'userQuestions/answer': (agentId: SessionId, callId: ToolCallId, answer: AskUserQuestionAnswer) => boolean
```

不参与的事件（例如 `approval/request`）一律回 `next`，
宿主会按自己的兜底策略收尾（审批是 `unavailable`，即 fail-closed），
与「没有客户端」时完全一致——网关在场不改变任何语义。

### 5.2 插件模式

进程内直接挂 `ctx.on('user-questions/request')`，不需要 `$events`，也不需要 `interactions=answer`。

补答需要「精确的那个活 Agent」：`agents.get(sessionId)` 取不到（冷会话、或不是同一个实例）时
返回 409 `agent_not_live`——这是 DSH 的语义，不是网关的限制。

### 5.3 与浏览器界面共存（重要）

DSH 会把同一个 waterfall 投给**所有**会应答的客户端，谁先回谁赢
（`receiveRemoteEventResult` 先到先结算）。所以：

> 同时开着浏览器界面时，提问可能被浏览器抢走并弹卡片，
> 此时 API 调用方的 `GET /questions` 永远是空，那一轮会等浏览器里的人点。

如果这套部署要长期对外提供 API，建议不要在同一实例上开着别人的浏览器标签页；
或者把浏览器标签当作「人工兜底」来用——两种接法都成立，但要有意识地选一个。

timed 模式下这个竞态伤害更小：浏览器没在 `timeout` 内点，问题就变成 `continued`，API 侧还能补答。

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
| 409 | `question_not_answerable` | DSH 拒收（该 callId 已结算，不是 `continued`） |
| 409 | `questions_disabled` | 部署关闭了 `questions.enabled` |
| 409 | `agent_not_live` | 插件模式下会话没有活着 runtime，无法补答 |

`question_not_pending` 对「已超时」「不属于该会话」「不属于本次提问」用同一个码，避免跨会话探测。

---

## 7. 实测记录

### 7.1 legacy（2026-11-09，网关 0.6.0）

| 场景 | 结果 |
|---|---|
| `stream:true` + 2 秒内提交 `A` | `question` → `question_closed{answered}` → `done`，content「用户选了A。」 |
| `stream:false` + 轮询后提交 `B` | HTTP 200，content「用户选了B。」 |
| `decline:true` | 工具 `NO_PROVIDER`，回合正常结束，模型转文字提问 |
| `questions.enabled:false` | 63 秒收敛，HTTP 200，不悬挂 |
| 断线（SSE 客户端退出） | 提问以 `cancelled` 关闭，不留悬挂 promise |

### 7.2 timed（2026-11-09，网关 0.7.0）

用 `--patch` 把 `preset-standard` 的 `tool-ask-user` 改成 `mode: timed, timeout: 40`，
模型按提示传 `timeout=8`：

| 步骤 | 结果 |
|---|---|
| 第一轮（不答） | **12 秒**收敛，工具返回 pending，模型原话「结果状态：`pending`，并非跳过」 |
| `GET /questions` | `state: "continued"`、`can_answer_late: true`，id 就是 `call_00_iMUJ...` |
| `POST .../answer` 选 `B` | `mode: "late"`，200 |
| 之后 | 投影清空；新的一轮 assistant 消息「收到，q1 的答复是 **B**。」 |

两条协议事实也是实测确认的（不是读文档猜的）：

- `userQuestions/answer` 的线上参数名是 `agentId` / `callId` / `answer`：
  传假 callId 返回 `{"ok":true,"value":false}`；字段名不对会是 400 `args fields do not match`。
- patch 的 `config` 是整体替换：只给 `plugins` 会让 preset 校验失败，必须带 `id` / `order`。

离线单测：`node scripts/test-questions.mjs` → **31 项**
（答案校验 8 + 中枢行为 13 + timed 投影/补答 10）。
