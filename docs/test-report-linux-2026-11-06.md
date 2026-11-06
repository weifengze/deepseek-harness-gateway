# DSH API 网关 · Linux 部署测试报告

| 项 | 内容 |
|---|---|
| 被测系统 | `deepseek-harness-gateway`（DSH API 网关）+ `@deepseek-ai/dsh` |
| 版本 | 网关 `0.4.1`，DSH `0.2.2-rc.1` |
| 测试类型 | 实机部署验证 + 对外 API 黑盒测试 + 沙箱边界验证 |
| 测试环境 | 全新 Ubuntu Server 24.04（非容器），内网 `192.168.2.198` |
| 测试时间 | 2026-11-06 |
| 结论 | **通过**。核心功能与安全边界成立；过程中发现 1 个严重缺陷（审批挂死）、3 个中等缺陷，均已修复并回归 |

---

## 1. 结论摘要

- 对外 API 全部按契约工作：agents / models / sessions / messages / runs / usage / metrics，**冒烟 22/22 通过**。
- **沙箱写入边界成立**：Agent 只能写会话 `cwd`，写父目录被内核级拒绝（`Read-only file system`）。
- **租户隔离成立**：跨 key 读会话、未知会话、未知 agent 一律 404，不泄露存在性。
- **无人值守可用**：systemd 常驻、开机自启、DSH 重启后网关约 12 秒自愈。
- 最严重的问题不是功能缺失，而是**默认审批策略在无人值守下会把请求挂死**（实测 290 秒无返回），已通过配置 + 网关兜底两层修复。

---

## 2. 测试环境

### 2.1 系统与依赖

| 项 | 值 |
|---|---|
| OS | Ubuntu 24.04（kernel 6.8） |
| CPU / 内存 | VM，`/` 452G 可用 |
| Node / npm | 22.22.2 / 10.9.7 |
| 沙箱 | `bubblewrap`（apt 安装）+ `/etc/apparmor.d/bwrap` |
| DSH | `@deepseek-ai/dsh@0.2.2-rc.1`，`--profile web`，回环 3080 |
| 网关 | `deepseek-harness-gateway@0.4.1`，回环 8787 |
| 模型 | `deepseek-official/deepseek-flash`、`deepseek-v4-pro` |
| 进程管理 | systemd（`dsh.service`、`dsh-gateway.service`） |

### 2.2 目录与角色

```
/srv/dsh/tenants/acme           ← agent "assistant" 的 cwd
/srv/dsh/tenants/acme/work      ← agent "sandbox"   的 cwd
/opt/dsh-gateway/config.json    ← 网关配置
/var/lib/dsh-gateway/           ← dsh-token / conversations.json / usage.json
/var/log/dsh/web.log            ← DSH stdout（令牌桥从中提取 token）
```

### 2.3 测试账号

| key id | 权限 | 用途 |
|---|---|---|
| `linux` | 全部 agent，admin，rpm 120 | 主测试 |
| `other` | 仅 `assistant`，rpm 30 | 跨租户隔离验证 |

---

## 3. 结果总览

| 类别 | 用例数 | 通过 | 失败 | 备注 |
|---|---|---|---|---|
| 部署与环境 | 6 | 6 | 0 | 含 2 次配置性失败并修正 |
| 对外 API 契约 | 15 | 15 | 0 | blocking / SSE / raw / runs / cancel |
| 隔离与安全 | 6 | 6 | 0 | 含 4 类错误路径 |
| 沙箱边界 | 4 | 4 | 0 | cwd 内可写、外被拒、提权被拒 |
| 稳定性与运维 | 2 | 2 | 0 | 重启自愈、开机自启 |
| **合计** | **33** | **33** | **0** | 冒烟脚本 22 项含在其中 |

---

## 4. 详细用例

### 4.1 部署与环境

| 编号 | 用例 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| TC-01 | `bwrap` 能否建立 user namespace | 可执行 | 初次 `BWRAP_FAIL`（AppArmor 拦截）；写入 `/etc/apparmor.d/bwrap`（`userns,` + unconfined）后 `BWRAP_OK` | ✅ |
| TC-02 | DSH 启动并输出令牌 | 进程常驻、token 落盘 | 3080 监听；`dsh-serve` 抓 `token=` 写入 `/var/lib/dsh-gateway/dsh-token`（0600） | ✅ |
| TC-03 | 网关启动 | `/healthz` 返回 `reachable:true` | `{"status":"ok","version":"0.4.1","dsh":{"reachable":true,"presets":4,"base_url":"http://127.0.0.1:3080"}}` | ✅ |
| TC-04 | systemd 常驻与自启 | `active` + `enabled` | 两个服务均 `active enabled` | ✅ |
| TC-05 | 无凭据时模型目录 | 返回空数组 | `{"object":"list","data":[]}`（DSH 语义：凭据缺失即隐藏路由） | ✅ 设计行为 |
| TC-06 | 写入凭据后模型发现 | 出现 DeepSeek 模型 | 2 个模型，`is_default` 指向 `deepseek-flash` | ✅ |

**观察**：TC-05 是排障时最容易误判的一条 —— 现象是「模型列表为空」，根因在凭据而不在网关。建议后续在 `/healthz` 里增加 `models: 0` 的显式告警。

### 4.2 对外 API 契约

| 编号 | 用例 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| TC-07 | `GET /v1/agents` | 列出 2 个 agent，含生效模型与来源 | `assistant:true, sandbox:true`，`model_source=models.default` | ✅ |
| TC-08 | `POST /v1/sessions` | 201，模型在创建时固定 | `model=deepseek-official/deepseek-flash:high` | ✅ |
| TC-09 | `POST /messages`（blocking） | 返回 answer + usage | `content="收到"`，**847 ms**，usage 完整 | ✅ |
| TC-10 | 同会话续聊 | `turn=2`，上下文保留 | `turn=2` | ✅ |
| TC-11 | `GET /sessions/{id}/messages` | 返回历史 | 4 条 | ✅ |
| TC-12 | `GET /sessions/{id}` | 带标题与运行态 | `title="确认收到指令"` | ✅ |
| TC-13 | `GET /v1/sessions` | 分页列表 | 10 条 | ✅ |
| TC-14 | `stream:true` | SSE `start/delta/done` | `text/event-stream`，**20 个 delta**，`done` 收尾 | ✅ |
| TC-15 | `stream:"raw"` | 原样转发 DSH 帧 | **19 帧**，`snapshot → turn/end` 完整 | ✅ |
| TC-16 | `POST /sessions/{id}/cancel` | SSE 终止且 `finish_reason=aborted` | `{"cancelled":1}`；SSE `done{finish_reason:"aborted", elapsed_ms:7996}` | ✅ |
| TC-17 | `POST /v1/runs` | 202 → 轮询收敛 | 202 → `succeeded`，`content="异步OK"` | ✅ |
| TC-18 | `GET /v1/usage` | 累计口径正确 | `totalTokens=338929, runs=31` | ✅ |
| TC-19 | `GET /metrics`（admin） | Prometheus 文本 | 1973 bytes | ✅ |
| TC-20 | `GET /metrics`（非 admin） | 403 | `403 {"code":"forbidden","error":{"code":"forbidden"}}` | ✅ |
| TC-21 | 模型覆盖 `model: "...:off"` | 生效并如实回显 | 创建/对话/详情三处均为 `:off request` | ✅ |

### 4.3 隔离与错误路径

| 编号 | 用例 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| TC-22 | 跨 key 读会话 | 404（与不存在同码） | `404` | ✅ |
| TC-23 | 未知 session | 404 | `404 session_not_found` | ✅ |
| TC-24 | 未知 agent | 404 | `404 agent_unavailable` | ✅ |
| TC-25 | 空 input | 400 | `400 {"error":{"code":"empty_input"}}` | ✅ |
| TC-26 | 非法 model 写法 | 400 且给出正确格式 | `400 model 需要 "provider/model" 形式，例如 …:off` | ✅ |
| TC-27 | 无效 Bearer | 401 | `401` | ✅ |

### 4.4 沙箱边界（本次最关键的一组）

| 编号 | 用例 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| TC-28 | Agent 写 cwd 内文件 | 成功、无需审批 | `inside.txt` 落盘（`-rw------- ubuntu`，6 字节） | ✅ |
| TC-29 | Agent 写 cwd 父目录 | 被拒 | `bash: …: Read-only file system` + `[sandbox: file access denied under workspace-write mode]`；文件系统中不存在 | ✅ |
| TC-30 | Agent 主动提权（`sandbox_permissions`） | 不应成功 | `409 approval_required`（policy=ask，网关兜底，**7–8 s**）；policy=never 时 19 s 完成且明确说明被拒 | ✅ |
| TC-31 | 沙箱内挂载视图 | 根只读、cwd 可写 | `/ … ro,nosuid,nodev`；`/srv/dsh/tenants/acme/work … rw` | ✅ |

> TC-29/31 说明：这不是「工具的礼貌性检查」，而是内核挂载层面的只读。因此即使模型被诱导（prompt injection）尝试越界写入，也只能拿到 `EROFS`。

### 4.5 稳定性与运维

| 编号 | 用例 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| TC-32 | `systemctl restart dsh` | 令牌轮换，网关自愈 | token `b7wp0Ucl…` → `kjzuykA2…`；约 **12 s** 后 `reachable:true`；随后真实对话正常 | ✅ |
| TC-33 | 全量冒烟 | 全通过 | **22/22 PASS**（对 registry 安装的 0.4.1 产物） | ✅ |

---

## 5. 缺陷清单

### D-01（严重）无人值守下审批请求挂死

- **现象**：`POST /messages` 让 Agent 写 cwd 外文件，请求 **290 秒无任何返回**（客户端超时），无错误、无响应体。
- **定位**：抓 `session/follow` 原始帧，事件序列在 `approval/asked` 之后**没有 `approval/decided`**，也没有 `turn/end`。
  即 DSH 把审批问题发给「应答者」，而 API 场景没有应答者，承诺永远不 resolve。
- **根因**：`approval.policy` 默认 `ask`；`ask` 委托给已组合的应答者（Web UI 的权限弹窗）。无人值守部署下该链路无终点。
- **修复**（两层）：
  1. 部署侧：`approval.policy: never`，且 `permission.presets.*.approval` 一并改 `never`；
  2. 网关侧：`runner`/`raw` 两条通道检测到 `approval/asked` 立即取消本轮，返回 `409 approval_required`（含 `tool`、`reason`）。
- **回归**：TC-30 通过，7–8 秒返回；policy=never 下 19 秒正常结束。

### D-02（中）只改 `approval.policy` 会导致 DSH 启动失败

- **现象**：`permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly`
- **原因**：`permission-presets` 用「沙箱模式 + 审批策略」二元组匹配预置；只改一半就成了无法匹配的 `custom` 组合。
- **修复**：配置两侧同步修改；已写入部署文档第 5 节的完整片段。

### D-03（中）模型回显与实际生效模型不一致

- **现象**：`POST /v1/sessions {"model":"…:off"}` 后，对话响应报 `:high`、`model_source=models.default`。
- **定位**：查 DSH 会话日志，`model/selection={…,reasoningEffort:"off"}`、`request/header=…:off` —— **实际行为正确，只是上报错**。
- **根因**：响应按「配置默认模型」构造，未读会话创建时固定下来的模型。
- **修复**：会话档案持久化 `model` 与 `modelSource`，create/message/detail 统一以会话为准。
- **回归**：TC-21 通过。

### D-04（低）冒烟脚本在异地部署出现伪失败

- **现象**：跨租户检查报 `FAIL status=401`。
- **原因**：第二个 key 写死为 `dsh_dev_local_key_0002`，在别的部署上不存在 → 401 而非 404。
- **修复**：改为第 5 个参数传入；缺参时输出 `SKIP`，不再用「没测」冒充「通过」。

### D-05（低）systemd `ExecStart` 指向错误路径

- **现象**：服务 `activating (auto-restart)`，`status=203/EXEC`。
- **原因**：npm 全局装在 `/usr/bin`，单元文件写了 `/usr/local/bin`。
- **修复**：改为绝对路径；同时显式设置 `PATH`。已写入部署文档的易错点清单。

---

## 6. 未覆盖与风险

| 编号 | 项 | 说明 | 建议 |
|---|---|---|---|
| R-01 | Node 版本 | `@deepseek-ai/dsh` 声明 `>=24.9`，实测环境为 22.22，不在官方支持组合 | 生产升 24 后重跑冒烟 |
| R-02 | 未做并发压测 | 仅单请求串行验证；`maxConcurrentRuns`、`rpm`、`tokenQuota` 的 429 路径未在 Linux 触发 | 上线前用 k6/wrk 打一轮 |
| R-03 | 无 soaks | 未做 24h 长跑；内存与 token 账本增长未观测 | 建议灰度期观察 `/metrics` |
| R-04 | 多租户同 agent | 同一 agent 的多用户共享 cwd 与文件权限（同 Unix 用户） | 一人一目录 → 多 agent + key 白名单 |
| R-05 | 无文件上传 | 只支持 base64 内联图片 | 按需规划 `POST /v1/files` |
| R-06 | 会话不可删除 | DSH 无删除接口，只能归档 | 在 JavaWeb 侧做逻辑归档 |
| R-07 | 8787 仅回环 | 当前 `server.host=127.0.0.1`，外部不可达 | nginx TLS + IP 白名单，或改内网绑定 |
| R-08 | `Requires=dsh.service` | DSH 重启会连带重启网关，造成约 12 s 全不可用 | 若想缩短，可去掉 `Requires` 只保留 `After`，由令牌热读自愈 |
| R-09 | 令牌桥 | 依赖解析 DSH stdout，属于权宜方案 | 等 DSH 支持固定机器凭据后移除 |

---

## 7. 性能数据

| 场景 | 耗时 |
|---|---|
| blocking 短问答（典型） | 808 ms / 847 ms / 939 ms / 2.1 s |
| blocking 偶发长尾 | 31 s、46 s（网络或推理长度导致，非配置问题） |
| SSE 首帧 → 结束 | 20–29 个 `delta` 帧 |
| raw 单轮帧数 | 19 |
| 取消生效 | 发起后立即 cancel，SSE 于 7996 ms 处以 `aborted` 收尾 |
| 提权被拒（网关兜底） | 7–8 s |
| DSH 重启 → 网关恢复 | ~12 s |

> 长尾说明：同一 prompt 在相邻时刻分别测到 0.8 s 与 31 s，`reasoningEffort=high` 下推理长度差异明显。若业务对首字延迟敏感，可把 `models.default` 固定为 `:off` 或 `:low`（会话级固定，不影响其他调用方）。

---

## 8. 交付物与复现

| 文件 | 用途 |
|---|---|
| `docs/linux-deploy.md` | 部署运行手册（含 systemd 单元、权限配置、验证清单） |
| `scripts/smoke.mjs` | 22 项端到端冒烟 |
| `scripts/linux-preflight.sh` | 只读预检（Node / bwrap / AppArmor / 端口） |

复现：

```bash
bash scripts/linux-preflight.sh
# 按 docs/linux-deploy.md 第 2–7 节部署
cd /usr/lib/node_modules/deepseek-harness-gateway
node scripts/smoke.mjs http://127.0.0.1:8787 <key> sandbox <另一个 key>
```

---

## 9. 签署意见

从「能不能给业务方用」的角度看，当前状态**可以进入联调**，前提是：

1. 部署时**必须**按第 5 节设置审批策略（否则走 409 兜底，功能上可用但错误语义偏重）；
2. 8787 不要直接暴露公网，前面加 TLS 与来源限制；
3. 终端用户只接触 API / JavaWeb，不接触 DSH Web UI（单 owner，侧栏可见全部会话）。
