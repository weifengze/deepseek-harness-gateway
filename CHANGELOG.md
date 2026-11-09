# 变更记录

本文件记录 `deepseek-harness-gateway` 的对外变更。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

0.4.0 之前的版本是 Dify 兼容层形态，已不再维护，故不收录。

---

## [Unreleased]

暂无。

---

## [0.6.0] — 2026-11-09

### Added

- **提问表单**：调用方可以替人回答模型提出的 `ask_user_question`。
  - `GET /v1/sessions/{id}/questions` 列出待答表单
  - `POST /v1/sessions/{id}/questions/{question_id}/answer` 提交答案（`{answers:[…]}`）或放弃（`{decline:true}`）
  - SSE 新增 `question` / `question_closed` 两种帧；会话对象新增 `pending_questions`
  - 新配置 `questions.enabled`（默认 `true`）、`questions.waitMs`（默认 120000，上限 1 小时）
    及环境变量 `DSH_GATEWAY_QUESTIONS_ENABLED`、`DSH_GATEWAY_QUESTIONS_WAIT_MS`
- 指标 `dsh_gateway_questions_total{outcome=answered|declined|timeout|…}`
- 文档 [`docs/questions.md`](docs/questions.md)：legacy/timed 差异、与浏览器抢答的竞态、错误码表

### Fixed

- **回合挂死**：`user-questions/request` 与 `approval/request` 都是转发给「应答客户端」的瀑布事件，
  没有应答客户端时 DSH 不会结算，发起那一轮会一直等待（实测 150 秒无响应体）。
  网关现在以 `interactions=answer` 连接并订阅 `$events`，每个瀑布都有确定结局：
  提问挂起等表单，其余事件回 `next`（与"没有客户端"语义一致）。
- `questions.enabled:false` 仍然订阅事件流，只是收到提问就直接放行——**不订阅会退回挂死**。

### Known limitations

- 仅支持 `tool-ask-user` 的 **legacy（阻塞）** 形态：答案只在网关进程内存里，
  没有 `callId` 不能事后补交，超过 `waitMs` 按放行处理。timed 形态未实现。
- 同一实例开着浏览器界面时，提问可能被浏览器抢答，API 侧的 `GET /questions` 会一直为空。

---

## [0.5.0] — 2026-11-09

### Added

- **产物投递**：一轮对话的响应（blocking / SSE `done` / 异步 run 终态）新增 `files[]`，
  每项含 `name`、`path`、`source`、`description`、`size`、`content_type`、`downloadable`、
  `download_url`、`expires_at`。
- 文件路由：
  - `GET /v1/sessions/{id}/files?path=&limit=` 浏览会话工作目录（单层）
  - `GET /v1/sessions/{id}/files/{path}` Bearer 下载，支持 `?inline=1`、单段 `Range`、`If-None-Match`
  - `GET /v1/files/{token}` 签名短链，**免 Bearer**，默认 15 分钟
- 新配置 `files.enabled` / `reader`（`auto|dsh|local`）/ `roots` / `maxBytes` / `tokenTtlMs` /
  `includeWritten` / `publicBaseUrl` / `signingSecret`
- 指标 `dsh_gateway_files_total`
- 文档 [`docs/files.md`](docs/files.md)

### Changed

- 产物从回合事件流识别（`deliverables/presented` 优先，`write`/`edit` 的 `tool/result` 兜底），不扫工作区。
- 下载可见范围由网关收窄为「会话 cwd + `files.roots`」，并用 canonical 路径复核防符号链接逃逸。

### Fixed

- 上游 `workspaceFiles` 的两处误用：线上参数是 `workspaceFileScopeId`（不是 `sessionId`）；
  `readBytes` 的 HTTP 响应是 multipart，`attachments[].path` 相对 `result.value`。
  后者此前表现为「200 + 0 字节」。
- 下载计量不再用 `res.on('close')` 判定（客户端收完 body 即退出也会触发），改为「承诺字节是否全部写出」。

---

## [0.4.2] — 2026-11-06

### Added

- 环境变量 `DSH_GATEWAY_ADMIN_KEYS='id1,id2'`：按 key id 提升为 admin。容器里抓取方来自网桥，
  「回环免鉴权」不成立，需要这个入口来读 `/metrics`。引用不存在的 id 会在启动期报错。

---

## [0.4.1] — 2026-11-06

### Added

- 文档 [`docs/linux-deploy.md`](docs/linux-deploy.md)：Ubuntu 24.04 实测部署（systemd、令牌桥、沙箱边界），
  以及当日的测试报告。
- 审批兜底：看到 `approval/asked` 立即终止本轮并返回 **409 `approval_required`**，
  不再干等人工审批（0.4.0 及之前会挂到超时）。

### Changed

- 冒烟脚本扩展；`runner.mjs` 与 `server.mjs` 的回合收尾细节调整。

---

## [0.4.0] — 2026-11-06

### Changed — Breaking

- **不再是 Dify 兼容层**。删除 Dify 风格的路由：`/v1/apps`、`/v1/chat-messages`、
  `/v1/conversations`、`/v1/messages`；改为 Agent 框架形态：

  | 0.3.x | 0.4.0 |
  |---|---|
  | `/v1/apps` | `/v1/agents` |
  | `/v1/conversations` | `/v1/sessions` |
  | `/v1/chat-messages` | `/v1/sessions/{id}/messages` |

- 资源模型固定为 `agent → session → message / run`；引入 SSE 流式（`start`/`delta`/`done`/`error`）、
  `stream:"raw"` 原样转发 DSH 帧、以及网关自建的异步 `runs`。
- 配置结构随之重写（`dsh` / `auth.keys` / `agents` / `limits` / `storage`），不再兼容 0.3.x 的 `config.json`。

---

[Unreleased]: https://github.com/weifengze/deepseek-harness-gateway/compare/v0.6.0...HEAD
[0.6.0]: https://www.npmjs.com/package/deepseek-harness-gateway/v/0.6.0
[0.5.0]: https://www.npmjs.com/package/deepseek-harness-gateway/v/0.5.0
[0.4.2]: https://www.npmjs.com/package/deepseek-harness-gateway/v/0.4.2
[0.4.1]: https://www.npmjs.com/package/deepseek-harness-gateway/v/0.4.1
[0.4.0]: https://www.npmjs.com/package/deepseek-harness-gateway/v/0.4.0
