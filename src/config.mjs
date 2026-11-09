/**
 * 配置加载：config.json + 环境变量覆盖。
 * 所有对外可见的取值（端口、密钥、agent 白名单、限额）都必须经过这里校验，
 * 避免网关以“半配置”状态启动。
 */

import { readFileSync, existsSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    maxBodyBytes: 16 * 1024 * 1024,
    runTimeoutMs: 300_000,
    streamIdleTimeoutMs: 180_000,
    heartbeatMs: 15_000,
    accessLog: true,
  },
  dsh: {
    baseUrl: undefined,
    token: undefined,
    tokenFile: undefined,
    connectTimeoutMs: 10_000,
    requestTimeoutMs: 60_000,
    spawn: undefined,
  },
  auth: {
    header: 'authorization',
    keys: [],
  },
  agents: [],
  models: {
    default: undefined,
  },
  limits: {
    maxConcurrentRuns: 8,
    maxSessionsPerKey: 200,
    maxImagesPerRequest: 4,
    maxImageBytes: 8 * 1024 * 1024,
  },
  files: {
    enabled: true,
    reader: 'auto',
    roots: [],
    maxBytes: 32 * 1024 * 1024,
    tokenTtlMs: 15 * 60 * 1000,
    includeWritten: true,
    publicBaseUrl: undefined,
    signingSecret: undefined,
  },
  questions: {
    enabled: true,
    waitMs: 120_000,
  },
  storage: {
    conversationsFile: 'data/conversations.json',
    usageFile: 'data/usage.json',
  },
}

/** 配置错误，启动期直接抛出，不做降级。 */
export class ConfigError extends Error {}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function merge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue
    if (value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = merge(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${field} 必须是正整数，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function requireNonNegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${field} 必须是非负整数，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function normalizeKey(raw, index) {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`auth.keys[${index}] 必须是对象`)
  const id = raw.id
  if (typeof id !== 'string' || id.length === 0) throw new ConfigError(`auth.keys[${index}].id 必填`)
  const hasSecret = typeof raw.secret === 'string' && raw.secret.length >= 16
  const hasHash = typeof raw.secretSha256 === 'string' && /^[0-9a-f]{64}$/i.test(raw.secretSha256)
  if (!hasSecret && !hasHash) {
    throw new ConfigError(`auth.keys[${index}] 需要 secret（>=16 字符）或 secretSha256（64 位 hex）`)
  }
  // `apps` 是 0.3.x 的旧字段名，读到就当 agents 处理，避免老配置静默失效。
  const whitelist = raw.agents ?? raw.apps
  return {
    id,
    secret: hasSecret ? raw.secret : undefined,
    secretSha256: hasHash
      ? raw.secretSha256.toLowerCase()
      : createHash('sha256').update(raw.secret, 'utf8').digest('hex'),
    agents: Array.isArray(whitelist) && whitelist.length > 0 ? whitelist.map(String) : ['*'],
    rpm: raw.rpm === undefined ? 0 : requirePositiveInt(raw.rpm, `auth.keys[${index}].rpm`),
    tokenQuota: raw.tokenQuota === undefined ? 0 : requireNonNegativeInt(raw.tokenQuota, `auth.keys[${index}].tokenQuota`),
    maxConcurrentRuns: raw.maxConcurrentRuns === undefined
      ? undefined
      : requirePositiveInt(raw.maxConcurrentRuns, `auth.keys[${index}].maxConcurrentRuns`),
    admin: raw.admin === true,
  }
}

function normalizeModel(raw, field) {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`${field} 必须是对象`)
  if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') {
    throw new ConfigError(`${field} 需要 provider 与 model 字符串`)
  }
  if (raw.reasoningEffort !== undefined && typeof raw.reasoningEffort !== 'string') {
    throw new ConfigError(`${field}.reasoningEffort 必须是字符串`)
  }
  return {
    provider: raw.provider,
    model: raw.model,
    ...(raw.reasoningEffort === undefined ? {} : { reasoningEffort: raw.reasoningEffort }),
  }
}

/**
 * 规范化一个 agent 条目。
 * `template` 是 0.3.x `inputTemplate` 的新名字。
 */
export function normalizeAgent(raw, index) {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`agents[${index}] 必须是对象`)
  const id = raw.id
  const preset = raw.preset
  if (typeof id !== 'string' || id.length === 0) throw new ConfigError(`agents[${index}].id 必填`)
  if (typeof preset !== 'string' || preset.length === 0) throw new ConfigError(`agents[${index}].preset 必填`)
  if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw new ConfigError(`agents[${index}].cwd 必须是字符串`)
  const template = raw.template ?? raw.inputTemplate
  if (template !== undefined && typeof template !== 'string') {
    throw new ConfigError(`agents[${index}].template 必须是字符串`)
  }
  const model = raw.model === undefined ? undefined : normalizeModel(raw.model, `agents[${index}].model`)

  return {
    id,
    preset,
    name: typeof raw.name === 'string' ? raw.name : preset,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    cwd: raw.cwd,
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : undefined,
    template,
    model,
    maxRunMs: raw.maxRunMs === undefined ? undefined : requirePositiveInt(raw.maxRunMs, `agents[${index}].maxRunMs`),
  }
}

/**
 * 为每个 agent 计算生效模型与来源。
 * 插件模式会在激活时才展开 agents，因此这里单独导出，供 plugin.mjs 补算。
 * @param {object} config 已校验的配置
 */
export function decorateAgents(config) {
  for (const agent of config.agents) {
    agent.effectiveModel = agent.model ?? config.models.default
    agent.modelSource = agent.model !== undefined
      ? 'agent'
      : config.models.default !== undefined ? 'models.default' : 'dsh-default'
  }
  return config
}

const FILE_READERS = new Set(['auto', 'dsh', 'local'])

/**
 * 规范化 `files` 段。
 *
 * 允许根里拒绝「整盘/根目录」：那等于把整机文件交给任何一个持 key 的调用方，
 * 是误配置而不是需求；要放开就逐条列出业务目录。
 * @param {object} value 已与默认值合并后的 files 段
 */
function normalizeFiles(value) {
  const reader = value.reader ?? 'auto'
  if (!FILE_READERS.has(reader)) {
    throw new ConfigError(`files.reader 只能是 auto / dsh / local，收到 ${JSON.stringify(reader)}`)
  }
  const roots = []
  if (value.roots !== undefined) {
    if (!Array.isArray(value.roots)) throw new ConfigError('files.roots 必须是绝对路径数组')
    for (const entry of value.roots) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        throw new ConfigError('files.roots 每项必须是非空字符串')
      }
      if (!isAbsolute(entry)) throw new ConfigError(`files.roots 需要绝对路径：${entry}`)
      const resolved = resolve(entry)
      if (resolved === resolve('/') || /^[A-Za-z]:[\\/]?$/.test(resolved)) {
        throw new ConfigError(`files.roots 不接受整盘或根目录：${entry}（等于把整机文件交给调用方）`)
      }
      roots.push(resolved)
    }
  }

  const { publicBaseUrl, signingSecret } = value
  if (publicBaseUrl !== undefined && publicBaseUrl !== null && typeof publicBaseUrl !== 'string') {
    throw new ConfigError('files.publicBaseUrl 必须是字符串')
  }
  if (signingSecret !== undefined && signingSecret !== null
    && (typeof signingSecret !== 'string' || signingSecret.length < 16)) {
    throw new ConfigError('files.signingSecret 至少 16 个字符（多实例部署必须显式配置，否则各实例签发的链接互不认）')
  }

  return {
    enabled: value.enabled !== false,
    reader,
    roots,
    maxBytes: requirePositiveInt(value.maxBytes, 'files.maxBytes'),
    tokenTtlMs: requirePositiveInt(value.tokenTtlMs, 'files.tokenTtlMs'),
    includeWritten: value.includeWritten !== false,
    publicBaseUrl: typeof publicBaseUrl === 'string' && publicBaseUrl.length > 0
      ? publicBaseUrl.replace(/\/+$/, '')
      : undefined,
    signingSecret: typeof signingSecret === 'string' && signingSecret.length > 0 ? signingSecret : undefined,
  }
}

/**
 * 提问通道：`enabled:false` 时仍然订阅转发事件流（否则 Host 的 waterfall 会悬挂），
 * 只是把提问直接放行——工具会以 `NO_PROVIDER` 快速失败。`waitMs` 是调用方填表的窗口。
 * @param {object} value 已与默认值合并后的 questions 段
 */
function normalizeQuestions(value) {
  const waitMs = requirePositiveInt(value.waitMs, 'questions.waitMs')
  if (waitMs > 3_600_000) {
    throw new ConfigError('questions.waitMs 不应超过 3600000（1 小时），超时会把整轮对话一直挂着')
  }
  return { enabled: value.enabled !== false, waitMs }
}

/**
 * 读取并校验配置。
 * @param {string} [configPath] config.json 路径；缺省读 DSH_GATEWAY_CONFIG 或 ./config.json
 * @returns {object} 冻结后的配置
 */
export function loadConfig(configPath) {
  const path = resolve(configPath ?? process.env.DSH_GATEWAY_CONFIG ?? 'config.json')
  let fileConfig = {}
  if (existsSync(path)) {
    try {
      fileConfig = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new ConfigError(`无法解析配置文件 ${path}: ${error.message}`)
    }
  } else if (configPath !== undefined || process.env.DSH_GATEWAY_CONFIG !== undefined) {
    throw new ConfigError(`配置文件不存在: ${path}`)
  }

  // 首次使用（npx / 全局安装）常见失败：目录里没有 config.json。
  // 这里提前给出可操作的提示，而不是等到 auth.keys 校验时报“至少配置一个”。
  const hasEnvKeys = Boolean(process.env.DSH_GATEWAY_API_KEYS)
  if (!existsSync(path) && !hasEnvKeys) {
    throw new ConfigError(
      `找不到配置文件 ${path}。\n`
      + '  1) 复制示例：cp node_modules/deepseek-harness-gateway/config.example.json config.json\n'
      + '  2) 填入 dsh.baseUrl 与 auth.keys[].secret\n'
      + '  3) 或用环境变量：DSH_BASE_URL / DSH_GATEWAY_API_KEYS / DSH_GATEWAY_CONFIG',
    )
  }
  return buildConfig(fileConfig, {
    configPath: existsSync(path) ? path : `${path}（不存在，纯环境变量模式）`,
  })
}

/**
 * 由配置对象构建并校验网关配置。
 *
 * `inProcess` 用于 DSH 插件模式：网关跑在宿主进程内，直接调用 `sessionController` /
 * `agentPresets` 服务，因此不需要也不允许配 `dsh.baseUrl` / `dsh.spawn`。
 * @param {object} raw 配置对象（与 config.json 同构）
 * @param {{ configPath?: string, inProcess?: boolean }} [options]
 * @returns {object} 校验后的配置
 */
export function buildConfig(raw = {}, { configPath = 'cordis:plugin', inProcess = false } = {}) {
  const config = merge(clone(DEFAULTS), raw)
  // 0.3.x 的旧字段名：读到就迁到 agents，老配置文件仍能直接启动。
  if (config.agents.length === 0 && Array.isArray(config.apps) && config.apps.length > 0) {
    config.agents = config.apps
  }
  delete config.apps

  // 环境变量覆盖：容器化部署时不必挂载密钥文件。
  if (process.env.DSH_BASE_URL) config.dsh.baseUrl = process.env.DSH_BASE_URL
  if (process.env.DSH_API_TOKEN) config.dsh.token = process.env.DSH_API_TOKEN
  if (process.env.DSH_TOKEN && !process.env.DSH_API_TOKEN) config.dsh.token = process.env.DSH_TOKEN
  if (process.env.DSH_TOKEN_FILE) config.dsh.tokenFile = process.env.DSH_TOKEN_FILE
  if (process.env.PORT) config.server.port = Number(process.env.PORT)
  if (process.env.HOST) config.server.host = process.env.HOST
  if (process.env.DSH_GATEWAY_API_KEYS) {
    config.auth.keys = process.env.DSH_GATEWAY_API_KEYS.split(',')
      .map(entry => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf(':')
        if (index <= 0) throw new ConfigError('DSH_GATEWAY_API_KEYS 每项必须是 id:secret 形式')
        return { id: entry.slice(0, index), secret: entry.slice(index + 1), agents: ['*'] }
      })
  }

  // DSH_GATEWAY_APPS 是 0.3.x 的旧名，仍接受，避免升级后启动失败。
  const agentsEnv = process.env.DSH_GATEWAY_AGENTS ?? process.env.DSH_GATEWAY_APPS
  if (agentsEnv) {
    let parsed
    try {
      parsed = JSON.parse(agentsEnv)
    } catch (error) {
      throw new ConfigError(`DSH_GATEWAY_AGENTS 必须是 JSON 数组: ${error.message}`)
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new ConfigError('DSH_GATEWAY_AGENTS 必须是非空 JSON 数组')
    }
    config.agents = parsed
  }

  config.server.port = requirePositiveInt(config.server.port, 'server.port')
  config.server.maxBodyBytes = requirePositiveInt(config.server.maxBodyBytes, 'server.maxBodyBytes')
  config.server.runTimeoutMs = requirePositiveInt(config.server.runTimeoutMs, 'server.runTimeoutMs')
  config.limits.maxConcurrentRuns = requirePositiveInt(config.limits.maxConcurrentRuns, 'limits.maxConcurrentRuns')

  config.auth.keys = (config.auth.keys ?? []).map(normalizeKey)
  // 环境变量方式（DSH_GATEWAY_API_KEYS='id:secret,...'）表达不了 admin 标记，
  // 而容器里 /metrics 的“回环免鉴权”又不成立（抓取方来自网桥）。用它按 id 提升：
  //   DSH_GATEWAY_ADMIN_KEYS=main,ops
  if (process.env.DSH_GATEWAY_ADMIN_KEYS) {
    const adminIds = new Set(process.env.DSH_GATEWAY_ADMIN_KEYS.split(',').map(s => s.trim()).filter(Boolean))
    for (const key of config.auth.keys) {
      if (adminIds.has(key.id)) key.admin = true
    }
    const known = new Set(config.auth.keys.map(key => key.id))
    for (const id of adminIds) {
      if (!known.has(id)) throw new ConfigError(`DSH_GATEWAY_ADMIN_KEYS 引用了不存在的 key id: ${id}`)
    }
  }
  // 插件模式下允许留空：由 plugin.mjs 在激活时生成一次性密钥并打印，避免“装上就报错”。
  if (config.auth.keys.length === 0 && !inProcess) {
    throw new ConfigError('至少配置一个 auth.keys（或用 DSH_GATEWAY_API_KEYS）')
  }
  const ids = new Set()
  for (const key of config.auth.keys) {
    if (ids.has(key.id)) throw new ConfigError(`auth.keys 中 id 重复: ${key.id}`)
    ids.add(key.id)
  }

  config.agents = (config.agents ?? []).map(normalizeAgent)
  // 插件模式下允许留空：由 plugin.mjs 按宿主已注册的预设自动展开成 agent。
  if (config.agents.length === 0 && !inProcess) {
    throw new ConfigError('至少配置一个 agents 条目（或用 DSH_GATEWAY_AGENTS 传 JSON 数组；示例见 config.example.json）')
  }
  const agentIds = new Set()
  for (const agent of config.agents) {
    if (agentIds.has(agent.id)) throw new ConfigError(`agents 中 id 重复: ${agent.id}`)
    agentIds.add(agent.id)
  }
  for (const key of config.auth.keys) {
    for (const agentId of key.agents) {
      // 插件模式下 agents 可能延后由预设目录展开，此处不做交叉校验（运行时未知 agent 返回 404）。
      if (agentId !== '*' && !agentIds.has(agentId) && !inProcess) {
        throw new ConfigError(`key ${key.id} 引用了不存在的 agent: ${agentId}`)
      }
    }
  }

  // 部署级兜底模型：配置后，未声明 agents[].model 的 agent 也会在建会话时被显式固定。
  // DSH 只有 selectModel 一个入口，而它会顺带改写全局默认；显式固定后新会话不再继承漂移值。
  if (process.env.DSH_GATEWAY_DEFAULT_MODEL) {
    const raw = process.env.DSH_GATEWAY_DEFAULT_MODEL.trim()
    const slash = raw.indexOf('/')
    if (slash <= 0) throw new ConfigError('DSH_GATEWAY_DEFAULT_MODEL 必须是 provider/model[:effort] 形式')
    const rest = raw.slice(slash + 1)
    const colon = rest.lastIndexOf(':')
    config.models.default = colon > 0
      ? { provider: raw.slice(0, slash), model: rest.slice(0, colon), reasoningEffort: rest.slice(colon + 1) }
      : { provider: raw.slice(0, slash), model: rest }
  }
  if (config.models.default !== undefined && config.models.default !== null) {
    config.models.default = normalizeModel(config.models.default, 'models.default')
  } else {
    config.models.default = undefined
  }
  decorateAgents(config)

  // 文件下载：对外暴露的是「当前会话工作目录 + 显式放开的业务目录」，不是整机。
  if (process.env.DSH_GATEWAY_PUBLIC_BASE_URL) config.files.publicBaseUrl = process.env.DSH_GATEWAY_PUBLIC_BASE_URL
  if (process.env.DSH_GATEWAY_FILES_ROOTS) {
    config.files.roots = process.env.DSH_GATEWAY_FILES_ROOTS.split(delimiter)
      .map(entry => entry.trim())
      .filter(Boolean)
  }
  if (process.env.DSH_GATEWAY_FILES_ENABLED) {
    config.files.enabled = !/^(0|false|no|off)$/i.test(process.env.DSH_GATEWAY_FILES_ENABLED.trim())
  }
  config.files = normalizeFiles(config.files ?? {})

  if (process.env.DSH_GATEWAY_QUESTIONS_ENABLED) {
    config.questions.enabled = !/^(0|false|no|off)$/i.test(process.env.DSH_GATEWAY_QUESTIONS_ENABLED.trim())
  }
  if (process.env.DSH_GATEWAY_QUESTIONS_WAIT_MS) {
    config.questions.waitMs = Number(process.env.DSH_GATEWAY_QUESTIONS_WAIT_MS)
  }
  config.questions = normalizeQuestions(config.questions ?? {})

  if (config.dsh.token === '') config.dsh.token = undefined
  if (config.dsh.tokenFile !== undefined && typeof config.dsh.tokenFile !== 'string') {
    throw new ConfigError('dsh.tokenFile 必须是字符串路径')
  }

  if (inProcess) {
    // 插件模式：不需要网络地址，保留一个可读标识供 /healthz 显示。
    config.dsh.baseUrl = config.dsh.baseUrl ?? 'cordis:in-process'
  } else if (!config.dsh.baseUrl && !config.dsh.spawn) {
    throw new ConfigError('必须配置 dsh.baseUrl（或 dsh.spawn 让网关自己拉起 dsh web）')
  }
  if (config.dsh.spawn) {
    if (typeof config.dsh.spawn.command !== 'string' || config.dsh.spawn.command.length === 0) {
      throw new ConfigError('dsh.spawn.command 必填')
    }
    config.dsh.spawn.args = Array.isArray(config.dsh.spawn.args) ? config.dsh.spawn.args.map(String) : []
    config.dsh.spawn.startupTimeoutMs = config.dsh.spawn.startupTimeoutMs ?? 120_000
  }

  config.configPath = configPath
  return config
}
