# Docker 部署

两种形态，按「DSH 是否也放进容器」区分。**都在真机（Ubuntu 24.04 / Docker 29.4）构建并跑过 22 项冒烟。**

| | 形态 A：网关独占 | 形态 B：一体化 |
|---|---|---|
| Dockerfile | `docker/Dockerfile.gateway` | `docker/Dockerfile.allinone` |
| 包含 | 只有网关 | DSH + 网关 + bubblewrap |
| 镜像体积 | **331 MB** | **1.48 GB** |
| 需要外部 DSH | 是（baseUrl + 令牌文件） | 否 |
| 适用 | 生产推荐：DSH 独立升级、网关水平扩展 | 单机自用、演示、边缘部署 |
| 构建耗时 | ~1 分钟 | ~8 分钟（npm 装 dsh 约 190 MB） |

---

## 1. 形态 A：网关独占

```bash
docker build -f docker/Dockerfile.gateway -t dsh-gateway:0.4.1 .
```

DSH 在外（宿主机或另一台机器）。容器需要两样东西：**可达的 baseUrl** 和**启动令牌文件**。

```bash
docker run -d --name dsh-gateway -p 8787:8787 \
  -e DSH_BASE_URL=http://192.168.2.198:3080 \
  -e DSH_TOKEN_FILE=/var/lib/dsh-gateway/dsh-token \
  -e DSH_GATEWAY_API_KEYS='prod:<至少16位随机串>' \
  -e DSH_GATEWAY_AGENTS='[{"id":"assistant","preset":"standard","cwd":"/srv/dsh/tenants/acme"}]' \
  -v /var/lib/dsh-gateway:/var/lib/dsh-gateway:ro \
  dsh-gateway:0.4.1
```

要点：

- **令牌文件权限**：镜像以 `node`（uid 1000）运行，宿主上的令牌文件必须对 uid 1000 可读
  （`chown 1000:1000` 或 `chmod 640` + 同组）。
- 容器内访问宿主服务：`--network host` 或 `--add-host host.docker.internal:host-gateway`。
- 只读挂载 `:ro` 即可——网关从不写令牌文件，只读它。

---

## 2. 形态 B：一体化

```bash
docker build -f docker/Dockerfile.allinone -t dsh-allinone:0.4.1 .
```

```bash
docker run -d --name dsh -p 127.0.0.1:8787:8787 \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  -e DEEPSEEK_API_KEY=sk-... \
  -v dsh-home:/home/dsh/.dsh \
  -v dsh-state:/var/lib/dsh-gateway \
  -v /srv/tenants/acme:/workspace \
  dsh-allinone:0.4.1
```

第一次启动会打印一次性 key（`docker logs dsh | grep 一次性`），重启会变。生产请显式传：

```bash
-e DSH_GATEWAY_API_KEYS='prod:<至少16位随机串>'
```

### 2.1 入口做了三件事

1. **令牌桥**：`dsh web` 的令牌每个进程随机、只打印一次，入口抓一次落盘给网关读，并监督两个进程，任一退出就整体退出（交给 restart policy）。
2. **审批策略预置**：写入 `$DSH_HOME/profiles/web/cordis.patch.yml`，把 `approval.policy` 与 `permission.presets.*.approval` 一起设为 `never`。**不这么做，需要审批的轮次会永久挂起**（详见 `docs/linux-deploy.md` 第 5 节）。
3. **沙箱后端自检**：探测 bwrap，不可用时说明回退到 landlock，**不会**擅自切成 `danger-full-access`。

---

## 3. 沙箱：容器里到底能不能限制写入

这是本次构建最值得记的一件事。bwrap 依赖 user namespace，而 Docker 的默认配置会拦。

### 3.1 bwrap 权限矩阵（实测，镜像内 `bwrap --ro-bind / / ... true`）

| 启动方式 | bwrap | 实际报错 |
|---|---|---|
| 默认参数 | ✗ | `No permissions to create new namespace` |
| `--security-opt seccomp=unconfined` | ✗ | `Failed to make / slave: Permission denied` |
| `--security-opt seccomp=unconfined --security-opt apparmor=unconfined` | ✅ | — |
| `--cap-add SYS_ADMIN` | ✗ | `Failed to make / slave: Permission denied` |
| `--privileged` | ✅ | — |

结论：**最小可用组合是同时放开 seccomp 与 apparmor**；`--cap-add SYS_ADMIN` 单独加没用（卡在 AppArmor 对 mount 的拦截）。

### 3.2 但默认参数下边界依然成立

因为 DSH 的沙箱链是 `bwrap → landlock → seatbelt`，而 **landlock 不需要任何特权**。实测默认参数启动：

```
[entrypoint] 沙箱后端：bwrap 不可用（容器内常见），回退 landlock（部分强制，边界仍生效）
```

Agent 自己动手的结果：

| 操作 | 结果 |
|---|---|
| 写 `/workspace/inside-ai.txt`（cwd 内） | 成功，`landlock-run: partial enforcement (older Landlock ABI)` |
| 写 `/outside.txt`（cwd 外） | `Permission denied`，文件不存在 |

所以：

- **默认参数**：`workspace-write` + landlock（部分强制），边界生效，无需任何特权标志。
- **加两个 `--security-opt`**：`workspace-write` + bwrap（完整强制），入口日志会打印「bwrap 可用（完整强制）」。

对安全敏感的场景用后者；只想「别让 Agent 写到我挂载之外的路径」，默认参数已经够。

---

## 4. 配置

### 4.1 全部用环境变量（推荐，容器友好）

| 变量 | 说明 |
|---|---|
| `DSH_BASE_URL` | DSH 地址；一体化镜像已内置 `http://127.0.0.1:3080` |
| `DSH_TOKEN_FILE` | 令牌文件路径；一体化镜像由入口写入 |
| `DSH_GATEWAY_API_KEYS` | `id:secret,id2:secret2`，secret ≥16 字符 |
| `DSH_GATEWAY_ADMIN_KEYS` | 逗号分隔的 key id，标为 admin（可读 `/metrics`、跨 key 读会话）。**需要网关 ≥ 0.4.2** |
| `DSH_GATEWAY_AGENTS` | JSON 数组，`[{id,preset,cwd}]` |
| `DSH_GATEWAY_DEFAULT_MODEL` | `provider/model[:effort]`，建会话时固定 |
| `DSH_PERMISSION_MODE` | 显式指定沙箱模式；缺省由入口探测决定 |
| `HOST` / `PORT` | 监听地址与端口（镜像默认 `0.0.0.0:8787`） |

### 4.2 或挂载配置文件

```bash
-v /host/config.json:/opt/dsh-gateway/config.json:ro
```

⚠️ 一旦配置里写了 `auth.keys`，**不要再设 `DSH_GATEWAY_API_KEYS`**——环境变量会整体覆盖 keys 数组，把 admin 标记冲掉。入口检测到配置里已有 keys 时不会生成一次性 key，并在日志里说明。

### 4.3 `/metrics` 在容器里的坑

网关的规则是「admin key **或** 回环访问」。容器里抓取方来自网桥（`172.x.x.x`），**回环豁免不成立**，所以必须用 admin key：

```bash
curl -s http://127.0.0.1:8787/metrics -H "Authorization: Bearer $ADMIN_KEY"
```

实测：admin key → `200`（463 bytes 起）；普通 key → `403`。

---

## 5. 编排

`docker/docker-compose.yml` 提供两套服务，默认起一体化：

```bash
DEEPSEEK_API_KEY=sk-... docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml --profile gateway-only up -d
```

---

## 6. 实测记录

| 项 | 形态 A | 形态 B |
|---|---|---|
| `/healthz` | `reachable:true`，`base_url` 指向宿主 DSH | `reachable:true`，`base_url: http://127.0.0.1:3080` |
| 冒烟 22 项 | **全 PASS** | **全 PASS** |
| blocking 首轮 | 778–847 ms | 1248–1250 ms |
| SSE 增量帧 | 20–22 | 16 |
| raw 帧 | 19 | 19 |
| 跨 key 读会话 | 404 | 404 |
| 写入边界 | 由宿主 DSH 决定 | `/workspace` 可写、`/outside.txt` 被拒 |
| healthcheck | healthy | healthy |

---

## 7. 踩过的两个坑（都已修在镜像里）

1. **CRLF**：Windows 上写的 `entrypoint.sh` 带 CRLF，容器里报
   `/usr/bin/env: 'bash\r': No such file or directory`。Dockerfile 里加了 `sed -i 's/\r$//'`，
   仓库加了 `.gitattributes`（`*.sh text eol=lf`）。
2. **匿名卷属主**：`VOLUME` 指向的目录若在镜像里不存在，Docker 会建一个 `root:root` 的空卷，
   运行期 `mkdir` 直接 `Permission denied`。现在镜像里先 `mkdir` + `chown` 再声明 `VOLUME`。

---

## 8. 已知限制

1. **一体化镜像里 DSH 与网关同生命周期**：DSH 崩溃会带走网关，靠 `restart: unless-stopped` 拉起。
2. **令牌仍是 per-process**：容器重启后令牌变，一体化镜像内部自己处理；形态 A 需要宿主同步更新令牌文件（网关会重读，无需重启）。
3. **不能用 `--network host` 之外的方式跨机访问一体化镜像里的 DSH**：`dsh web` 只绑 `127.0.0.1`，这是有意为之——对外只暴露网关的 8787。
4. **镜像不含模型凭据**：`DEEPSEEK_API_KEY` 必须运行期注入，不要写进 Dockerfile。
5. **Node 版本**：镜像用 `node:24-bookworm-slim`（DSH 声明 `>=24.9`），比宿主那台 Node 22 更符合要求。
