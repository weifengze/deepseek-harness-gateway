# 回答问题 + 文件下载

Agent 答完一段话，往往还产出了一个 `.docx`、一张图、一份 CSV。
没有这一层时，调用方拿到的是「一段文字 + 一个它打不开的路径」——这就是 0.4.x 的真实缺口。

0.5.0 起，**一轮对话的返回里会带上产物清单**，每个产物自带一个可以直接下载的链接：

```json
{
  "object": "message",
  "content": "会议预案已经写好，见附件。",
  "files": [
    {
      "object": "file",
      "name": "会议预案.docx",
      "path": "out/会议预案.docx",
      "source": "present",
      "description": "下周 RRB 会议预案",
      "size": 24813,
      "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "downloadable": true,
      "download_url": "/v1/files/eyJzIjoic2Vzc2lvbi0...",
      "expires_at": 1794193172
    }
  ]
}
```

`download_url` 不校验 `Authorization`：它自己就是授权。所以前端拿到 JSON 就能直接把链接丢进 `<a href>` 或 `window.open`。

---

## 1. 三条能力，两个读者面

| 能力 | 路由 | 鉴权 |
|---|---|---|
| 一轮对话的产物清单 | `POST /v1/sessions/{id}/messages`、`POST /v1/runs`、`GET /v1/runs/{id}` 的 `files` 字段 | Bearer |
| 浏览会话工作目录 | `GET /v1/sessions/{id}/files?path=&limit=` | Bearer + 归属 |
| 下载文件 | `GET /v1/sessions/{id}/files/{path}` | Bearer + 归属 |
| 下载文件（可分享链接） | `GET /v1/files/{token}` | 签名本身 |

底下有两个 reader，对上层是同一套语义：

| reader | 走哪 | 何时用 |
|---|---|---|
| `dsh` | 宿主 `workspaceFiles` Remote（`stat` / `list` / `readBytes`） | 插件形态默认可用；CLI 形态下要求 profile 含 `dsh-api-gateway` 之外的 `@deepseek-ai/dsh-api-workspace-files`（web profile 自带） |
| `local` | 网关进程的 `node:fs` | 网关与 DSH 同机时永远可用；`workspaceFiles` 缺失时自动降级 |

`files.reader: "auto"`（默认）先探测 DSH，只有「服务/方法不存在」才降级到本地；
会话不存在、路径不存在这类**业务错误不会触发降级**——那说明上游是活的，只是这个文件不在。

> 为什么需要两个：`workspaceFiles` 走的是 DSH 的 composed fs，能跨容器、能处理 DSH 自己的路径映射；
> 而本地 fs 零依赖、不产生 RPC。单机部署用哪个都对，容器分离部署只有前者成立。

---

## 2. 产物是怎么认出来的

只认会话事件流里的两类事实，**不扫目录、不猜**：

| 来源 | 事件 | 语义 |
|---|---|---|
| `present` | `deliverables/presented` | Agent 显式声明的交付物（`present` 工具写入的权威记录，路径已是绝对路径） |
| `write` / `edit` | `tool/call` + `tool/result` | 成功落盘的写文件工具；失败或 `isError` 的结果不算 |

排序规则：`present` 组在前（按声明顺序），写工具产出的在后（按写盘顺序）。
同一个文件既被写又被声明时只保留一条，并以 `present` 为准——调用方通常只取 `files[0]`，
排在前面的必须是模型真正想交付的那个。

`files.includeWritten: false` 可以只保留 `present` 声明的产物（更严格，但会漏掉「忘了 present」的场景）。

### 越界的产物

`present` 允许声明工作目录之外的文件（`/tmp`、下载目录都行）。
这类文件照样会出现在 `files` 里，但 `downloadable: false` + `download_error: "file_outside_scope"`：

```json
{ "name": "x.docx", "path": "/tmp/x.docx", "downloadable": false,
  "download_error": "file_outside_scope" }
```

**不会**因为一个越界附件把整轮回答变成 500。要真的能下，把它在 `files.roots` 里放开。

---

## 3. 安全模型：范围只能由网关收窄

DSH 的 `workspaceFiles` 明确允许读工作区之外的文件（它服务于 Web UI 的预览）。
把这条路直接透给 API 调用方，等于给每个持 key 的人一个任意读。所以收窄在网关侧做，三层：

1. **词法**：请求路径先 `resolve`（吃掉 `..`、统一分隔符、统一 Windows 盘符大小写），
   再判「是否落在 cwd 或 `files.roots` 之内」。不成立就是 `403 file_outside_scope`。
2. **canonical 复核**：`stat` 返回的 `absolutePath` 是解开符号链接后的真实路径，**再判一次**。
   词法上在 cwd 内、实际指向 `/etc` 的软链接过不了这一关。
3. **签名范围**：下载令牌里写死了「会话 + 绝对路径」，签名之后 `files.roots` 被收紧的话，
   再次校验依然会拒绝——链接不会因为签发过就永久有效。

允许根 = `会话 cwd` + `files.roots`。cwd 来自三处，按优先级：
`agents[].cwd`（建会话时记录）→ 从 DSH `session/list` 的 header 反查并写回档案 → 拿不到就 **409**
（宁可失败，也不要退化成「整机可读」）。

`files.roots` 拒绝 `/` 和 `C:\` 这种整盘配置：那是误配，不是需求。

---

## 4. 接口

### 4.1 浏览目录

```bash
curl -s "$BASE/v1/sessions/$SID/files?path=out&limit=50" -H "Authorization: Bearer $KEY"
```

```json
{"object":"list","path":"out","truncated":false,
 "data":[{"object":"file","name":"a.docx","path":"out/a.docx","type":"file","size":24813},
         {"object":"file","name":"tmp","path":"out/tmp","type":"directory"}]}
```

- `path` 相对则按 cwd 解析，绝对则必须落在允许范围内；空值 = cwd 根目录。
- `limit` 默认 200，上限 1000；`truncated` 表示上游截断。
- `type`：`file` / `directory` / `other`。

### 4.2 下载

```bash
curl -sJO "$BASE/v1/sessions/$SID/files/out/report.docx" -H "Authorization: Bearer $KEY"
```

- 路径可以带子目录（`/files/out/report.docx`）。
- `?inline=1` 把 `Content-Disposition` 从 `attachment` 换成 `inline`（图片 / PDF 预览）。
- 支持单段 `Range`：命中返回 `206` + `Content-Range`；不可满足返回 `416`。
- `ETag` 取自文件版本，`If-None-Match` 命中返回 `304`。
- 中文文件名同时给 ASCII 回退名和 RFC 5987 的 `filename*=UTF-8''…`。

### 4.3 签名链接

```bash
curl -sO "$BASE/v1/files/eyJzIjoic2Vzc2lvbi0..."
```

令牌是 `base64url(payload).base64url(HMAC-SHA256)`，payload 含
`{s: 会话, p: 绝对路径, k: key id, n: 文件名, e: 过期秒}`。

- **不需要 Bearer**：链接本身就是一次性的、单文件的、有期限的授权。
- 有效期 `files.tokenTtlMs`，默认 15 分钟。
- 换 `files.signingSecret` 或重启进程（未显式配置密钥时）都会让旧链接失效。
- 持有链接的人能看到那一个文件；key 被删掉，链接立即失效。

### 4.4 响应里的 `files`

| 字段 | 说明 |
|---|---|
| `name` | 文件名（basename） |
| `path` | cwd 内给相对路径，cwd 外给绝对路径 |
| `source` | `present` / `write` / `edit` / … |
| `description` | `present` 里模型写的用途说明 |
| `size` | 字节数（上游不报时省略） |
| `content_type` | 按扩展名推断 |
| `downloadable` | 能不能下（`false` 时带 `download_error`） |
| `download_url` | 签名链接；配了 `files.publicBaseUrl` 时是绝对 URL |
| `expires_at` | 链接过期时间（Unix 秒） |

SSE 模式下这一整组挂在 `done` 帧上；`stream:"raw"` 不额外包装，`deliverables/presented`
本来就在原样转发的帧里。

---

## 5. 配置

```json
{
  "files": {
    "enabled": true,
    "reader": "auto",
    "roots": ["/srv/tenant-reports"],
    "maxBytes": 33554432,
    "tokenTtlMs": 900000,
    "includeWritten": true,
    "publicBaseUrl": "https://api.example.com",
    "signingSecret": "至少 16 个字符的随机串"
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时三个文件路由都返回 404 `files_disabled`，响应里也不再带 `files` |
| `reader` | `auto` | `auto` / `dsh` / `local` |
| `roots` | `[]` | 除会话 cwd 之外额外允许的**绝对目录**；不接受整盘或根目录 |
| `maxBytes` | 32 MiB | 单文件下载上限，超过返回 413 |
| `tokenTtlMs` | 15 min | 签发链接的有效期 |
| `includeWritten` | `true` | 是否把 `write`/`edit` 落盘的文件也算进产物 |
| `publicBaseUrl` | — | 反代/对外域名，用于拼绝对 `download_url`；默认给相对路径 |
| `signingSecret` | 每进程随机 | 多实例部署**必须**显式配置，否则各实例签发的链接互不认 |

环境变量：`DSH_GATEWAY_FILES_ENABLED`、`DSH_GATEWAY_FILES_ROOTS`（按 `PATH` 分隔符拆分）、
`DSH_GATEWAY_PUBLIC_BASE_URL`。

---

## 6. 错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_path` | 路径为空 / 含 NUL |
| 400 | `file_not_regular` | 目标是目录或特殊文件 |
| 403 | `file_outside_scope` | 越出 cwd 与 `files.roots`（含符号链接逃逸） |
| 403 | `file_not_readable` | 本地 fs 权限不足 |
| 403 | `invalid_signature` | 签名链接被篡改或已过期 |
| 404 | `file_not_found` | 文件不存在（两种 reader 同一个码） |
| 404 | `files_disabled` | 部署关掉了文件能力 |
| 409 | `session_cwd_unknown` | 会话没有工作目录且未配 `files.roots` |
| 413 | `file_too_large` | 超过 `files.maxBytes` |
| 416 | `invalid_range` | `Range` 无法满足 |
| 502 | `file_transfer_failed` | 上游返回了元数据但没给字节 |

---

## 7. 部署注意

- **容器分离部署必须用 `reader: "dsh"`**：网关在容器外时，本地 fs 看不到 DSH 的工作目录。
  一体化镜像（`Dockerfile.allinone`）两种都成立。
- **多实例必须配 `files.signingSecret`**，否则负载均衡把请求打到另一个实例时链接验不过。
- **对外域名配 `files.publicBaseUrl`**：否则 `download_url` 是相对路径，需要调用方自己拼前缀。
- **下载会占用内存与带宽**：按 `maxBytes` × 并发量估算；`files.maxBytes` 也是防「把网关当文件中转站」的闸门。
- `GET /v1/files/{token}` 是唯一一条**免 Bearer** 的数据出口。它绑定单个文件、短期有效，
  但如果部署把日志里的完整 URL 收走，等于把那个文件也收走了——按需缩短 `tokenTtlMs`。

---

## 8. 已知限制

1. **只读**：没有上传、覆盖、删除。写文件仍然只能由 Agent 在会话里做。
2. **不递归列举**：`/files` 只列一层（和 DSH 的 `list` 一致），深层目录按 `path` 逐层进。
3. **产物只从事件流来**：Agent 用 bash 写、又没 `present` 的文件不会出现在 `files` 里
   （`GET /files` 仍能看到它）。这是刻意的：扫工作区在大仓库里又慢又吵。
4. **单文件上限 32 MiB**（可调）：超过返回 413，不做分片下载协议。
5. **`files` 不进历史**：`GET /v1/sessions/{id}/messages` 仍是纯文本消息，
   产物只跟「这一轮的响应」绑定；异步 run 的产物只在内存里陪着那条记录（1 小时 TTL）。
