# Linux 部署运行手册

本文是在**全新 Ubuntu 24.04 + 无人值守**条件下实测出来的部署路径，不是推演。
每一步都标注了「为什么必须这么做」以及「不这么做会怎样」。

- 验证环境：Ubuntu 24.04（kernel 6.8）、Node 22.22.2 / npm 10.9.7、`@deepseek-ai/dsh@0.2.2-rc.1`、`deepseek-harness-gateway@0.4.x`
- 验证结果：冒烟 22/22 通过；写入边界、跨 key 隔离、DSH 重启自愈、提权拒绝均实测通过

---

## 1. 预检（只读，不改任何东西）

```bash
bash scripts/linux-preflight.sh
```

关注四项：Node 版本、`bwrap` 是否存在、`apparmor_restrict_unprivileged_userns`、端口占用。

---

## 2. 沙箱前提：bwrap 必须真的能跑

这一步是整条链路的**地基**。DSH 的文件与 bash 工具依赖 `bubblewrap` 执行 `workspace-write`；
沙箱不可用时不是「降级为无沙箱」，而是工具直接不可用。

### 2.1 装 bubblewrap

```bash
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap
```

### 2.2 Ubuntu 23.10+ 必须补 AppArmor 放行

Ubuntu 24.04 默认 `kernel.apparmor_restrict_unprivileged_userns=1`，会直接拦掉 bwrap 的
非特权 user namespace。**不要**去把 sysctl 关掉（那会放宽整机限制），而是只给 bwrap 单独授权：

```bash
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
EOF

sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

### 2.3 验证

```bash
bwrap --ro-bind / / --dev /dev --proc /proc true && echo BWRAP_OK
```

不打印 `BWRAP_OK` 就先停下，后面所有工具调用都会失败。

实测的边界形态（这也是多租户隔离的原理）：

```
根文件系统在沙箱内是只读（ro,nosuid,nodev），只有会话 cwd 被单独以 rw 重新挂载
```

---

## 3. 安装

```bash
# 建议 Node ≥ 24（dsh 声明 >=24.9；22.22 实测可跑，但不在支持组合内）
sudo npm i -g @deepseek-ai/dsh deepseek-harness-gateway
dsh --version
dsh-gateway --version
```

### 3.1 如果 npm 卡住（境内常见的 IPv6 问题）

现象：`npm i` 长时间无输出，`ss -tn | grep 443` 显示连接停在 `FIN-WAIT`，而 `curl -4` 同一地址正常。
原因是系统 DNS 优先返回 AAAA，但机器没有 IPv6 路由。

绕法（只影响该主机，可回滚）：

```bash
IP4=$(getent ahostsv4 registry.npmjs.org | awk 'NR==1{print $1}')
echo "$IP4 registry.npmjs.org" | sudo tee -a /etc/hosts
```

镜像源（`registry.npmmirror.com`）在测试中不稳定（同一域名一次 200 用 10s、一次直接超时），
不建议作为唯一来源。

---

## 4. 模型凭据

DSH 的凭据解析顺序（`credentials-local`）：

```
$DSH_HOME/.credentials.yaml  >  进程环境  >  <cwd>/.env  >  $DSH_HOME/.env
```

最简单可靠的是写 `$DSH_HOME/.env`：

```bash
umask 077
printf 'DEEPSEEK_API_KEY=%s\n' 'sk-...' > ~/.dsh/.env
chmod 600 ~/.dsh/.env
```

⚠️ **凭据缺失时 `/v1/models` 返回空数组，而不是报错**。这是 DSH 的语义（凭据缺失即隐藏该路由）。
所以「模型列表为空」的第一反应应该是查凭据，而不是查网关。

验证：

```bash
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $KEY"
# 应看到 deepseek-official/deepseek-flash、deepseek-official/deepseek-v4-pro
```

---

## 5. 权限策略：无人值守必须改成 never

### 5.1 为什么

DSH 默认 `approval.policy = ask`：需要审批的操作会发 `approval/asked`，然后等一个「应答者」。
API 调用没有人在场回答，于是：

```
approval/asked  →  （永远等不到 approval/decided）  →  整轮挂住
```

实测：不做本节配置时，一次「让 Agent 写工作区外文件」的请求 **290 秒没有任何返回**。

### 5.2 怎么配

`~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high

- id: approval
  name: "@deepseek-ai/dsh-user-approval"
  config:
    policy: never

- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: never
      workspace-write:
        sandbox: workspace-write
        approval: never
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: workspace-write
```

⚠️ **`approval` 和 `permission` 必须一起改**。只把 `approval.policy` 设成 `never`、
`presets` 里还留着 `approval: ask`，启动会直接报：

```
permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly
```

### 5.3 网关侧的兜底

即使漏配了策略，网关（0.4.1+）也不会挂 5 分钟：它会在看到 `approval/asked` 时立即终止本轮并返回

```json
{"code":"conflict","status":409,
 "error":{"type":"conflict_error","code":"approval_required",
          "details":{"tool":"write","reason":"escalate sandbox to danger-full-access: …"}}}
```

实测耗时 7–8 秒（等模型先尝试一次提权）。raw 通道会额外补一帧
`{"type":"gateway-error","status":409,"code":"approval_required"}`。

---

## 6. 目录与配置

```bash
sudo mkdir -p /srv/dsh/tenants/acme/work \
              /opt/dsh-gateway \
              /var/lib/dsh-gateway \
              /var/log/dsh
sudo chown -R ubuntu:ubuntu /srv/dsh /var/lib/dsh-gateway /var/log/dsh
```

`/opt/dsh-gateway/config.json`：

```json
{
  "server": { "host": "127.0.0.1", "port": 8787, "runTimeoutMs": 300000 },
  "dsh": { "baseUrl": "http://127.0.0.1:3080" },
  "models": {
    "default": { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "high" }
  },
  "auth": {
    "keys": [
      { "id": "linux", "secret": "换成强随机串", "agents": ["*"], "rpm": 120, "admin": true },
      { "id": "other", "secret": "换成另一个强随机串", "agents": ["assistant"], "rpm": 30 }
    ]
  },
  "agents": [
    { "id": "assistant", "preset": "standard", "cwd": "/srv/dsh/tenants/acme" },
    { "id": "sandbox",   "preset": "standard", "cwd": "/srv/dsh/tenants/acme/work" }
  ],
  "storage": {
    "conversationsFile": "/var/lib/dsh-gateway/conversations.json",
    "usageFile": "/var/lib/dsh-gateway/usage.json"
  }
}
```

要点：

- **`agents[].cwd` 就是沙箱边界**，不是「默认目录」。一个租户一个目录，目录必须在部署时建好
  （`cwd` 分支不做 `stat` 校验，路径不存在要等工具调用才报错）。
- `workspaceId` 分支更严格（会 `realpathNormalize` + 校验目录），但那个 UUID 是**每台机器各自生成**的，
  不能从别的机器复制。跨机部署直接用 `cwd` 更省事。
- 两个 key 是为了让冒烟脚本能验证「跨租户读会话返回 404」。生产按需增删。

---

## 7. systemd 常驻

`dsh web` 的启动令牌**每个进程随机**，只打印在 stdout 一次。网关从令牌文件读取，
所以需要一个很小的「令牌桥」把 stdout 里的 token 落盘。

`/usr/local/bin/dsh-serve`（`0755`）：

```bash
#!/usr/bin/env bash
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
TOKEN_FILE=/var/lib/dsh-gateway/dsh-token
LOG=/var/log/dsh/web.log
: > "$LOG"
dsh web --no-open --port "${DSH_PORT:-3080}" >>"$LOG" 2>&1 &
PID=$!
trap 'kill -TERM "$PID" 2>/dev/null; wait "$PID" 2>/dev/null' TERM INT
for _ in $(seq 1 120); do
  T=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)
  if [ -n "${T:-}" ]; then
    printf '%s' "$T" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    break
  fi
  sleep 1
done
wait "$PID"
```

`/etc/systemd/system/dsh.service`：

```ini
[Unit]
Description=DeepSeek Harness web host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/srv/dsh
EnvironmentFile=-/home/ubuntu/.dsh/.env
ExecStart=/usr/local/bin/dsh-serve
Restart=always
RestartSec=3
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/dsh-gateway.service`：

```ini
[Unit]
Description=DeepSeek Harness API gateway
After=dsh.service
Requires=dsh.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/dsh-gateway
Environment=DSH_TOKEN_FILE=/var/lib/dsh-gateway/dsh-token
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/dsh-gateway
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh.service dsh-gateway.service
```

⚠️ 两个易错点：

1. `ExecStart` 必须写**实际路径**（npm 全局装到 `/usr/bin`，不是 `/usr/local/bin`），
   否则 `status=203/EXEC` 并无限重启（`systemctl status` 显示 `activating (auto-restart)`）。
2. `dsh-gateway` 要显式给 `PATH`，systemd 的默认 PATH 不含 `/usr/local/bin`。

---

## 8. 验证清单

```bash
KEY=<你的 key>
curl -s http://127.0.0.1:8787/healthz
# {"status":"ok","version":"0.5.0","dsh":{"reachable":true,"presets":4,"base_url":"http://127.0.0.1:3080"}}

curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $KEY"
curl -s http://127.0.0.1:8787/v1/agents -H "Authorization: Bearer $KEY"

SID=$(curl -s -X POST http://127.0.0.1:8787/v1/sessions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"agent":"sandbox"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

curl -s -X POST http://127.0.0.1:8787/v1/sessions/$SID/messages \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"input":"只回复两个字：在线"}'
```

### 8.1 写入边界（最该测的一条）

让 Agent 自己动手，而不是手搓 bwrap：

```bash
curl -s -X POST http://127.0.0.1:8787/v1/sessions/$SID/messages \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"input":"在当前工作目录建 inside.txt 写 hello；再在 /srv/dsh/tenants/acme/outside.txt 建文件写 bad。把两次真实输出原样贴给我。"}'
```

预期：

| 目标 | 结果 |
|---|---|
| `.../work/inside.txt` | 成功，无需审批 |
| `.../acme/outside.txt` | `Read-only file system` + `[sandbox: file access denied under workspace-write mode]` |

文件系统事实核验：`inside.txt` 存在，`outside.txt` 不存在。

### 8.2 重启自愈

```bash
sudo systemctl restart dsh.service
```

实测时间线：`token` 从 `b7wp0Ucl…` 变成 `kjzuykA2…`，网关约 **12 秒**后重新
`reachable:true`，随后真实一轮对话正常。期间 `healthz` 短暂无响应（网关在重新握手）。

### 8.3 全量冒烟

```bash
cd /usr/lib/node_modules/deepseek-harness-gateway
node scripts/smoke.mjs http://127.0.0.1:8787 <key> sandbox <另一个 key>
```

22 项覆盖：健康检查、401、agents/models、建会话、blocking、续聊、历史、会话详情/列表、
SSE、raw、未知 session/agent、跨 key 404、异步 run、usage、metrics。

---

## 9. 实测数据

| 项 | 数值 |
|---|---|
| 建会话 + 首轮（`deepseek-flash:high`） | 0.9–2.5 s；偶发 30–46 s 抖动（网络/推理长度，非配置） |
| SSE 增量帧 | 20–29 |
| raw 帧（snapshot → turn/end） | 19 |
| 提权拒绝（policy=ask，网关兜底） | 7–8 s，409 `approval_required` |
| 提权拒绝（policy=never，DSH 直接拒） | 19 s，模型自行解释失败原因 |
| DSH 重启 → 网关恢复 | ~12 s |
| 冒烟 | 22/22 |

---

## 10. JavaWeb 侧怎么调

路径由服务端固定，Java 侧永远不传路径：

```java
// 1) 建会话（可复用，不必每轮新建）
POST /v1/sessions
{"agent": "sandbox"}
→ 201 {"id":"session-...","model":"deepseek-official/deepseek-flash:high","model_source":"models.default"}

// 2) 发消息
POST /v1/sessions/{id}/messages
{"input": "把这份周报整理成表格", "stream": false}
→ {"content":"...","turn":1,"usage":{...},"model":"..."}

// 3) 长任务
POST /v1/runs  {"agent":"sandbox","input":"..."} → 202 {"id":"run_..."}
GET  /v1/runs/{id} → status: queued|running|succeeded|failed|cancelled
```

`model` 字段带 effort（如 `:high`），可以原样回传给 `POST /v1/v1/sessions` 的 `model`；
回显以**会话实际固定的模型**为准，不会因为部署默认值变化而漂移。

---

## 11. 已知限制（不要踩）

1. **单 owner**：所有会话在 DSH 侧同属一个身份。终端用户只能通过网关 API（或你的 JavaWeb）访问，
   **不要把 DSH Web UI 暴露给他们**——侧栏能看到全部会话。
2. **一个 agent 一个目录**：同 agent 的多用户共享文件读写。要一人一目录，就多配 agent + 按 key 白名单绑定。
3. **Node 版本**：`@deepseek-ai/dsh` 声明 `>=24.9`，22.22 实测可跑但非支持组合。生产建议升 24。
4. **令牌桥是权宜**：根因是 DSH 只在 stdout 打印 per-process token。若 DSH 后续支持固定
   `DSH_API_TOKEN` 或 `$DSH_HOME/api-token`，可去掉 `dsh-serve` 直接 `ExecStart=dsh web ...`。
5. **会话只增不删**：DSH 没有删除接口，只能归档。
6. **无文件上传**：当前只支持 base64 内联图片。
7. **`/metrics`**：需 admin key 或本机回环访问，别直接把 8787 暴露到公网。
