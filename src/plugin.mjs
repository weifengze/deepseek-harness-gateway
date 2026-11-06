/**
 * DSH 插件入口：把网关挂到宿主进程内。
 *
 * 与 CLI 模式的差别只有一处：客户端换成 `CordisDshClient`，直接调用宿主服务，
 * 因此不需要 `dsh.baseUrl`、不需要启动令牌、也不需要额外进程。
 *
 * 组合方式见包根的 `cordis.patch.yml`：`dsh plugin add` 会把本包登记为 profile 的
 * 一个 bundle 层，再由 profile 的 `dsh.profile.bundles` 顺序装载。
 */

import { randomBytes, createHash } from 'node:crypto'
import { buildConfig, decorateAgents, normalizeAgent } from './config.mjs'
import { CordisDshClient } from './cordis-client.mjs'
import { createGateway } from './server.mjs'

/** 插件显示名（Cordis 的约定字段，缺省时回落到包名）。 */
export const name = 'dsh-api-gateway'

/**
 * 必须声明 inject：Cordis 的上下文代理只沿“已注入”的服务查找，
 * 直接写 `ctx.sessionController` 而未声明 inject 会抛 `cannot get property ... without inject`。
 * `agentPresets` 故意不注入——缺失时只影响 `/v1/agents`，不应让整个插件拒绝激活。
 */
export const inject = ['sessionController']

/** 日志适配：优先用宿主 logger，缺失时退回 stdout，避免插件因日志失败。 */
function makeLog(ctx) {
  return (level, message, extra) => {
    const line = extra === undefined ? message : `${message} ${JSON.stringify(extra)}`
    try {
      const logger = ctx.logger
      const write = logger?.[level]
      if (typeof write === 'function') {
        write.call(logger, line)
        return
      }
    } catch {
      // 日志失败不影响服务。
    }
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout
    stream.write(`[dsh-api-gateway] ${level}: ${line}\n`)
  }
}

/**
 * 挂载网关。async apply 是 Cordis 支持的形态：激活失败会落到该行的 fiber 上，
 * 而不是留一个“已激活但端口没起来”的插件。
 * @param {object} ctx Cordis 上下文
 * @param {object} [config] `cordis.patch.yml` 里本行的 config，与 config.json 同构
 * @returns {Promise<() => Promise<void>>} 释放函数：停止监听并关闭存储
 */
export async function apply(ctx, config) {
  const log = makeLog(ctx)
  // 插件模式由构建期校验兜底：端口、密钥、agents 都可留空（下面自动展开）。
  const settings = buildConfig(config ?? {}, { configPath: 'cordis:dsh-api-gateway', inProcess: true })
  const client = new CordisDshClient(ctx, { log })

  // 开箱可用：没配 agents 就按宿主已注册的预设展开；没配密钥就生成一次性密钥并打印。
  // 两者都可被 cordis.patch.yml 的显式配置覆盖。
  if (settings.agents.length === 0) {
    const roster = await client.call('agentPresets/list', {}, { timeoutMs: 15_000 })
    const usable = (roster?.presets ?? []).filter(row => !row.broken && typeof row.id === 'string')
    if (usable.length === 0) {
      throw new Error('dsh-api-gateway: 宿主没有可用预设，无法自动生成 agents；请在 cordis.patch.yml 显式配置 agents')
    }
    settings.agents = usable.map((row, index) => normalizeAgent(
      { id: row.id, preset: row.id, name: row.name ?? row.id }, index,
    ))
    decorateAgents(settings)
  }

  if (settings.auth.keys.length === 0) {
    const secret = randomBytes(24).toString('base64url')
    settings.auth.keys = [{
      id: 'plugin',
      secret,
      secretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
      agents: ['*'],
      rpm: 0,
      tokenQuota: 0,
      maxConcurrentRuns: undefined,
      admin: false,
    }]
    log('warn', '未配置 auth.keys，已生成本次启动的一次性 API key（重启会变；要固定请在 cordis.patch.yml 配置 auth.keys）', { api_key: secret })
    // 宿主 logger 通常只写日志文件，控制台看不到；这里补一条 stderr，保证 key 可被发现。
    process.stderr.write(
      `\n[dsh-api-gateway] 已启动，监听 ${settings.server.host}:${settings.server.port}\n`
      + `[dsh-api-gateway] 未配置 auth.keys，本次启动的一次性 API key：${secret}\n`
      + '[dsh-api-gateway] 要固定 key，请在 cordis.patch.yml 的 auth.keys 里声明。\n\n',
    )
  }

  const gateway = createGateway({ config: settings, client, log })

  const address = await new Promise((resolve, reject) => {
    const onError = (error) => reject(new Error(
      `dsh-api-gateway 监听 ${settings.server.host}:${settings.server.port} 失败：${error.message}`,
    ))
    gateway.server.once('error', onError)
    gateway.server.listen(settings.server.port, settings.server.host, () => {
      gateway.server.off('error', onError)
      resolve(gateway.server.address())
    })
  })

  const port = typeof address === 'object' && address !== null ? address.port : settings.server.port
  log('info', 'gateway.listening', {
    url: `http://${settings.server.host}:${port}`,
    mode: 'cordis-plugin',
    agents: settings.agents.map(agent => agent.id),
    keys: settings.auth.keys.map(key => key.id),
  })

  return async () => {
    await gateway.close()
    client.close()
  }
}

export default { name, inject, apply }
