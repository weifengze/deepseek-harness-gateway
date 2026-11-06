#!/usr/bin/env node
/**
 * 网关入口：装配配置 → 取得 DSH 令牌 → 启动 HTTP 服务。
 *
 * 两种部署形态：
 *   A. sidecar：DSH 由 systemd / 容器单独运行，网关通过 dsh.baseUrl + dsh.token 接入；
 *   B. 托管：网关自己拉起 `dsh --profile web`，从启动日志里解析每进程令牌。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, ConfigError } from './config.mjs'
import { DshClient } from './dsh-client.mjs'
import { createGateway } from './server.mjs'
import { spawnDshWeb } from './supervisor.mjs'

/**
 * 令牌来源，按优先级排列：
 *   1. DSH_API_TOKEN（P0：稳定的机器凭据，DSH 后续原生支持时零改动）
 *   2. DSH_TOKEN（兼容旧名）
 *   3. config.dsh.token
 *   4. token 文件：dsh.tokenFile → $DSH_HOME/api-token → ~/.dsh/api-token
 * 每次握手重新解析，文件轮换后下一次 401 自动生效，无需重启网关。
 */
function createTokenResolver(config, log) {
  const candidates = [
    ['env:DSH_API_TOKEN', () => process.env.DSH_API_TOKEN],
    ['env:DSH_TOKEN', () => process.env.DSH_TOKEN],
    ['config:dsh.token', () => config.dsh.token],
  ]
  const files = []
  if (config.dsh.tokenFile) files.push(config.dsh.tokenFile)
  if (process.env.DSH_HOME) files.push(join(process.env.DSH_HOME, 'api-token'))
  files.push(join(homedir(), '.dsh', 'api-token'))
  for (const file of files) {
    candidates.push([`file:${file}`, () => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    }])
  }

  let lastSource
  return async () => {
    for (const [source, read] of candidates) {
      const value = read()?.trim()
      if (value) {
        if (source !== lastSource) {
          log('info', 'dsh.token.source', { source })
          lastSource = source
        }
        return value
      }
    }
    return undefined
  }
}

/** 结构化日志：一行一个 JSON，便于被采集器直接消费。 */
function createLogger(level = 'info') {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 }
  const threshold = levels[level] ?? 20
  return (lvl, message, extra) => {
    if ((levels[lvl] ?? 20) < threshold) return
    const line = { time: new Date().toISOString(), level: lvl, message, ...extra }
    const text = JSON.stringify(line)
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(`${text}\n`)
    else process.stdout.write(`${text}\n`)
  }
}

async function main() {
  const log = createLogger(process.env.LOG_LEVEL ?? 'info')
  let config
  try {
    config = loadConfig(process.argv[2])
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`配置错误: ${error.message}\n`)
      process.exit(2)
    }
    throw error
  }

  let baseUrl = config.dsh.baseUrl
  let child
  let closing = false
  const resolveToken = createTokenResolver(config, log)
  const client = new DshClient({ baseUrl, getToken: resolveToken, log })

  if (!baseUrl) {
    // 托管模式：dsh 每次重启都会换启动令牌，重拉后必须把新令牌灌回 client。
    const launch = async () => {
      log('info', 'dsh.spawn', { command: config.dsh.spawn.command, args: config.dsh.spawn.args })
      const handle = await spawnDshWeb({
        command: config.dsh.spawn.command,
        args: config.dsh.spawn.args,
        cwd: config.dsh.spawn.cwd,
        env: config.dsh.spawn.env,
        startupTimeoutMs: config.dsh.spawn.startupTimeoutMs,
        onExit: (code) => {
          if (closing || !child) return
          log('warn', 'dsh.exited', { code, restart_in_ms: 2000 })
          setTimeout(() => {
            void launch().catch((error) => log('error', 'dsh.restart.failed', { message: error.message }))
          }, 2_000)
        },
      }, log)
      child = handle
      baseUrl = handle.baseUrl
      client.setBaseUrl(baseUrl)
      client.setToken(handle.token)
      log('info', 'dsh.ready', { base_url: baseUrl })
    }
    await launch()
  }

  // 启动即验证一次握手：配错令牌时立刻失败，而不是等第一个业务请求。
  try {
    await client.call('agentPresets/list', {}, { timeoutMs: 15_000 })
    log('info', 'dsh.handshake.ok', { base_url: baseUrl })
  } catch (error) {
    log('error', 'dsh.handshake.failed', { message: error.message, code: error.code })
    await child?.stop?.()
    process.exit(3)
  }

  const gateway = createGateway({ config, client, log })
  await new Promise((resolve, reject) => {
    gateway.server.once('error', reject)
    gateway.server.listen(config.server.port, config.server.host, resolve)
  })
  log('info', 'gateway.listening', {
    url: `http://${config.server.host}:${config.server.port}`,
    agents: config.agents.map(agent => agent.id),
    keys: config.auth.keys.map(key => key.id),
    config: config.configPath,
  })

  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    log('info', 'gateway.shutdown', { signal })
    const timer = setTimeout(() => process.exit(1), 15_000)
    timer.unref()
    try {
      await gateway.close()
      client.close()
      await child?.stop?.()
    } finally {
      clearTimeout(timer)
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  process.stderr.write(`网关启动失败: ${error.stack ?? error.message}\n`)
  process.exit(1)
})
