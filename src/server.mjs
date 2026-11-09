/**
 * 对外 HTTP 层：Agent 框架形状的资源 API。
 *
 * 资源只有四类：
 *   - `agents`   profile 里已配置好的能力（DSH preset）
 *   - `sessions` 一次持续对话；创建时绑定 agent 与模型
 *   - `messages` 会话里的消息；向会话发一条消息即跑一轮
 *   - `runs`     同一轮对话的异步句柄
 *
 * 刻意不做产品兼容层：字段一律扁平、名词一律 `agent/session/message/run`。
 * 鉴权、租户、配额、指标都在这一层，DSH 始终只监听回环地址。
 */

import { createServer } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ApiError, requestIdOf, sendError, toApiError } from './errors.mjs'
import { createSession, PresetCatalog, readHistory, runTurn, sessionExists } from './runner.mjs'
import { SessionLocks, SessionStore } from './sessions.mjs'
import { UsageStore } from './usage.mjs'
import { Metrics } from './metrics.mjs'
import { DeliverableBag } from './deliverables.mjs'
import {
  DownloadSigner, FileGuard, FileService, contentDisposition, contentTypeFor, parseRange,
  randomSigningSecret, toSlashes,
} from './files.mjs'

// 版本号必须与 package.json 一致：/healthz 与 / 都会回报，
// 硬编码会在每次发版后立刻与 package.json 脱节。
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const ASYNC_RUN_TTL_MS = 60 * 60 * 1000
const ASYNC_RUN_LIMIT = 500

/** 写响应时等一次 drain；连接被对端关掉时立即返回，避免卡在没人读的 socket 上。 */
function waitForDrain(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })
}

/** 每密钥的滑动窗口限流（次/分钟）。 */
class RateLimiter {
  #hits = new Map()

  /**
   * @param {string} keyId
   * @param {number} rpm 0 表示不限
   */
  take(keyId, rpm) {
    if (!rpm) return true
    const now = Date.now()
    const windowStart = now - 60_000
    const list = (this.#hits.get(keyId) ?? []).filter(time => time > windowStart)
    if (list.length >= rpm) {
      this.#hits.set(keyId, list)
      return false
    }
    list.push(now)
    this.#hits.set(keyId, list)
    return true
  }
}

/** 读取并限制体积的 JSON body。 */
async function readJsonBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new ApiError(413, 'invalid_request_error', 'body_too_large', `请求体超过 ${maxBytes} 字节`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ApiError(400, 'invalid_request_error', 'invalid_json', '请求体不是合法 JSON')
  }
}

function bearerOf(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]
}

function hashSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function safeEqualHex(a, b) {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

function isLoopback(req) {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 内联图片附件（只收 base64，避免 SSRF 与出站抓取）。 */
function toPromptAttachments(attachments, limit) {
  if (attachments === undefined) return []
  if (!Array.isArray(attachments)) {
    throw new ApiError(400, 'invalid_request_error', 'invalid_attachments', 'attachments 必须是数组')
  }
  if (attachments.length > limit) {
    throw new ApiError(400, 'invalid_request_error', 'too_many_attachments', `单次最多 ${limit} 个附件`)
  }
  const parts = []
  for (const item of attachments) {
    if (item?.type !== 'image') {
      throw new ApiError(400, 'invalid_request_error', 'unsupported_attachment_type',
        '当前仅支持 type=image 的内联图片')
    }
    if (typeof item.data !== 'string' || item.data.length === 0) {
      throw new ApiError(400, 'invalid_request_error', 'invalid_attachment',
        '图片必须以 data 传 base64 字符串（不接受远程 URL）')
    }
    const mediaType = item.media_type
    if (!IMAGE_TYPES.has(mediaType)) {
      throw new ApiError(400, 'invalid_request_error', 'unsupported_media_type', `不支持的图片类型 ${mediaType}`)
    }
    parts.push({ type: 'image', mediaType, data: item.data, ...(item.name ? { name: item.name } : {}) })
  }
  return parts
}

/** 渲染 agent.template 中的 {{var}}。 */
function renderTemplate(template, inputs) {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, name) => {
    const value = inputs?.[name]
    if (value === undefined || value === null) {
      throw new ApiError(400, 'invalid_request_error', 'missing_input', `缺少输入变量 ${name}`)
    }
    return String(value)
  })
}

/**
 * 解析模型声明：字符串 `provider/model[:effort]` 或对象 `{provider, model, reasoningEffort}`。
 * @returns {{provider: string, model: string, reasoningEffort?: string}}
 */
function parseModel(spec, where = 'model') {
  if (typeof spec === 'string') {
    const [target, effort] = spec.split(':')
    const slash = target.indexOf('/')
    if (slash <= 0 || slash === target.length - 1) {
      throw new ApiError(400, 'invalid_request_error', 'invalid_model',
        `${where} 需要 "provider/model" 形式，例如 deepseek-official/deepseek-flash:off`)
    }
    return {
      provider: target.slice(0, slash),
      model: target.slice(slash + 1),
      ...(effort ? { reasoningEffort: effort } : {}),
    }
  }
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    if (typeof spec.provider !== 'string' || typeof spec.model !== 'string') {
      throw new ApiError(400, 'invalid_request_error', 'invalid_model', `${where} 需要 provider 与 model 字符串`)
    }
    if (spec.reasoningEffort !== undefined && typeof spec.reasoningEffort !== 'string') {
      throw new ApiError(400, 'invalid_request_error', 'invalid_model', `${where}.reasoningEffort 必须是字符串`)
    }
    return {
      provider: spec.provider,
      model: spec.model,
      ...(spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort }),
    }
  }
  throw new ApiError(400, 'invalid_request_error', 'invalid_model', `${where} 必须是字符串或对象`)
}

/** `stream` 参数 → 三种输出模式。 */
function parseMode(stream) {
  if (stream === undefined || stream === false || stream === 'none') return 'blocking'
  if (stream === true || stream === 'sse' || stream === 'text') return 'streaming'
  if (stream === 'raw' || stream === 'events') return 'raw'
  throw new ApiError(400, 'invalid_request_error', 'invalid_stream',
    'stream 只能是 false / true / "raw"')
}

/** `?inline=1`：让浏览器直接预览而不是落盘（图片 / PDF 场景）。 */
function isInline(url) {
  const value = url.searchParams.get('inline')
  return value !== null && /^(1|true|yes|inline)$/i.test(value)
}

/**
 * 解码一个 URL 段。非法的 `%` 序列是调用方的输入问题（400），
 * 不该冒成 500 URIError。
 */
function decodeSegment(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ApiError(400, 'invalid_request_error', 'invalid_path', 'URL 里的路径编码非法')
  }
}

/** 模型对外标识：`provider/model[:effort]`，与创建会话时接受的写法一致，可原样回传。 */
function modelLabel(model) {
  if (!model) return undefined
  return `${model.provider}/${model.model}${model.reasoningEffort ? `:${model.reasoningEffort}` : ''}`
}

function sseChannel(res, requestId, heartbeatMs) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': requestId,
  })
  res.write(': connected\n\n')
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, heartbeatMs)
  timer.unref?.()
  return {
    send(payload) {
      if (res.writableEnded || res.destroyed) return
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    },
    close() {
      clearInterval(timer)
      if (!res.writableEnded && !res.destroyed) res.end()
    },
  }
}

/** 低基数路由标签，避免把会话 id 写进指标。 */
function routeLabel(path) {
  if (path === '/') return 'index'
  if (path === '/healthz') return 'healthz'
  if (path === '/metrics') return 'metrics'
  if (path === '/v1/agents') return 'agents'
  if (path === '/v1/models') return 'models'
  if (path === '/v1/usage') return 'usage'
  if (path === '/v1/sessions') return 'sessions'
  if (path === '/v1/runs') return 'runs.create'
  if (/^\/v1\/sessions\/[^/]+$/.test(path)) return 'sessions.get'
  if (/^\/v1\/sessions\/[^/]+\/messages$/.test(path)) return 'messages'
  if (/^\/v1\/sessions\/[^/]+\/cancel$/.test(path)) return 'sessions.cancel'
  if (/^\/v1\/sessions\/[^/]+\/files$/.test(path)) return 'files.list'
  if (/^\/v1\/sessions\/[^/]+\/files\/.+$/.test(path)) return 'files.download'
  if (/^\/v1\/files\/[^/]+$/.test(path)) return 'files.token'
  if (/^\/v1\/runs\/[^/]+$/.test(path)) return 'runs.get'
  if (/^\/v1\/runs\/[^/]+\/cancel$/.test(path)) return 'runs.cancel'
  return 'other'
}

/**
 * 创建网关服务。
 * @param {object} options
 * @param {object} options.config
 * @param {import('./dsh-client.mjs').DshClient} options.client
 */
export function createGateway({ config, client, log }) {
  const presets = new PresetCatalog(client)
  const store = new SessionStore(config.storage.conversationsFile, log)
  const usage = new UsageStore(config.storage.usageFile ?? 'data/usage.json', log)
  const locks = new SessionLocks()
  const limiter = new RateLimiter()
  const metrics = new Metrics()
  const files = new FileService({ config: config.files, client, log })
  // 签名密钥不配就每进程随机：下载链接本来就短命，重启作废是可接受代价。
  const signer = new DownloadSigner(config.files.signingSecret ?? randomSigningSecret())
  const filesEnabled = config.files.enabled
  /** 进行中的运行：runId → 控制信息（含 AbortController）。 */
  const activeRuns = new Map()
  /** 异步运行的终态记录：runId → 可查询结果。 */
  const asyncRuns = new Map()
  const activeByKey = new Map()
  let activeGlobal = 0

  const pruneAsyncRuns = () => {
    const deadline = Date.now() - ASYNC_RUN_TTL_MS
    for (const [id, record] of asyncRuns) {
      if ((record.finished_at ?? record.created_at) < deadline) asyncRuns.delete(id)
    }
    if (asyncRuns.size <= ASYNC_RUN_LIMIT) return
    const ordered = [...asyncRuns.entries()].sort((a, b) => a[1].created_at - b[1].created_at)
    for (const [id] of ordered.slice(0, asyncRuns.size - ASYNC_RUN_LIMIT)) asyncRuns.delete(id)
  }
  const pruneTimer = setInterval(pruneAsyncRuns, 60_000)
  pruneTimer.unref?.()

  const authenticate = (req) => {
    const secret = bearerOf(req)
    if (!secret) throw new ApiError(401, 'authentication_error', 'unauthenticated', '缺少 Authorization: Bearer <key>')
    const digest = hashSecret(secret)
    for (const key of config.auth.keys) {
      if (safeEqualHex(digest, key.secretSha256)) return key
    }
    throw new ApiError(401, 'authentication_error', 'invalid_api_key', 'API key 无效')
  }

  /** /metrics：admin key，或本机回环（便于 node_exporter 直采）。 */
  const authorizeMetrics = (req) => {
    if (bearerOf(req) !== undefined) {
      const key = authenticate(req)
      if (key.admin) return key
      throw new ApiError(403, 'permission_error', 'forbidden', '需要 admin 权限的 key')
    }
    if (isLoopback(req)) return undefined
    throw new ApiError(401, 'authentication_error', 'unauthenticated', '缺少 Authorization: Bearer <key>')
  }

  /** 当前密钥可用的 agent；不指定时取第一个。 */
  const resolveAgent = (key, agentId) => {
    const allowed = key.agents.includes('*')
      ? config.agents
      : config.agents.filter(agent => key.agents.includes(agent.id))
    const agent = agentId ? allowed.find(item => item.id === agentId) : allowed[0]
    if (!agent) {
      throw new ApiError(agentId ? 404 : 403, agentId ? 'not_found_error' : 'permission_error',
        'agent_unavailable',
        agentId ? `agent ${agentId} 不存在或当前密钥无权访问` : '当前密钥未绑定任何 agent')
    }
    return agent
  }

  /** 请求级模型覆盖：只改本次建会话的选择，不影响配置。 */
  const withModelOverride = (agent, spec) => {
    if (spec === undefined) return agent
    const model = parseModel(spec, 'model')
    return { ...agent, effectiveModel: model, modelSource: 'request' }
  }

  /**
   * 回显以会话实际固定的模型为准，而不是配置里的默认值。
   * 会话在创建时就 selectModel 固定过，之后默认值漂移不影响它，回显也不该跟着漂。
   */
  const withStoredModel = (agent, row) => {
    if (!row?.model) return agent
    try {
      return {
        ...agent,
        effectiveModel: parseModel(row.model, 'session.model'),
        modelSource: row.modelSource ?? 'session',
      }
    } catch {
      return agent
    }
  }

  const acquireRunSlot = (key) => {
    const maxConcurrent = key.maxConcurrentRuns ?? config.limits.maxConcurrentRuns
    const used = activeByKey.get(key.id) ?? 0
    if (used >= maxConcurrent) {
      throw new ApiError(429, 'rate_limit_error', 'concurrency_exceeded',
        `密钥 ${key.id} 并发上限 ${maxConcurrent} 已用尽`)
    }
    if (activeGlobal >= config.limits.maxConcurrentRuns * config.auth.keys.length) {
      throw new ApiError(429, 'rate_limit_error', 'gateway_busy', '网关并发已满')
    }
    activeByKey.set(key.id, used + 1)
    activeGlobal++
    return () => {
      activeByKey.set(key.id, Math.max(0, (activeByKey.get(key.id) ?? 1) - 1))
      activeGlobal--
    }
  }

  const assertSessionQuota = (key) => {
    if (store.countByKey(key.id) >= config.limits.maxSessionsPerKey) {
      throw new ApiError(429, 'rate_limit_error', 'session_quota_exceeded',
        `密钥 ${key.id} 的会话数已达上限 ${config.limits.maxSessionsPerKey}`)
    }
  }

  /** 新建会话并登记归属；模型在首轮之前就被固定，避免跟随部署默认漂移。 */
  const openSession = async (key, agent) => {
    assertSessionQuota(key)
    await presets.assertUsable(agent.preset)
    const sessionId = await createSession(client, agent)
    const row = store.create({
      id: sessionId,
      keyId: key.id,
      agent: agent.id,
      model: modelLabel(agent.effectiveModel),
      modelSource: agent.modelSource ?? 'dsh-default',
      cwd: agent.cwd,
    })
    return row
  }

  /** 会话在当前 DSH 中是否仍然存在（冷会话也可读）。 */
  const assertSessionAlive = async (sessionId) => {
    if (!await sessionExists(client, sessionId)) {
      throw new ApiError(404, 'not_found_error', 'session_not_found', `session ${sessionId} 不存在`)
    }
  }

  /** 从 session/list 拿标题、工作目录与运行态；拿不到就降级为空。 */
  const sessionSummary = async (sessionId) => {
    try {
      const list = await client.call('session/list', { _request: {} }, { timeoutMs: 15_000 })
      const item = (list?.items ?? []).find(row => row.sessionId === sessionId)
      if (!item) return {}
      const title = item.projections?.values?.title
      return {
        ...(typeof title === 'string' ? { title } : {}),
        ...(typeof item.cwd === 'string' && item.cwd.length > 0 ? { cwd: item.cwd } : {}),
        running: item.running === true,
      }
    } catch {
      return {}
    }
  }

  const sessionObject = (row, summary = {}) => {
    const cwd = summary.cwd ?? row.cwd
    return {
      object: 'session',
      id: row.id,
      agent: row.agent ?? row.app,
      ...(row.model ? { model: row.model } : {}),
      ...(row.model ? { model_source: row.modelSource ?? 'session' } : {}),
      // 工作目录就是下载接口的可见范围，直接回给调用方，省得它去猜。
      ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
      title: summary.title ?? row.title ?? null,
      created_at: Math.floor(row.createdAt / 1000),
      last_used_at: Math.floor(row.lastUsedAt / 1000),
      running: summary.running === true,
    }
  }

  const assertFilesEnabled = () => {
    if (!filesEnabled) {
      throw new ApiError(404, 'not_found_error', 'files_disabled',
        '本部署未开启文件下载（files.enabled=false）')
    }
  }

  /**
   * 会话的允许根目录。
   *
   * 建会话时 agent 声明了 cwd 就已记录；没声明（走 DSH 默认）时从 `session/list`
   * 的 header 里反查一次并写回档案。查不到就不猜——宁可 409，也不要退化成「整机可读」。
   */
  const guardFor = async (row) => {
    let cwd = typeof row?.cwd === 'string' && row.cwd.length > 0 ? row.cwd : undefined
    if (cwd === undefined && row?.id) {
      try {
        const list = await client.call('session/list', { _request: {} }, { timeoutMs: 15_000 })
        const item = (list?.items ?? []).find(entry => entry.sessionId === row.id)
        if (typeof item?.cwd === 'string' && item.cwd.length > 0) {
          cwd = item.cwd
          store.setCwd(row.id, cwd)
        }
      } catch {
        // 拿不到就落到下面的 409：下载失败比给出一个更宽的范围安全。
      }
    }
    const guard = new FileGuard({ cwd, roots: config.files.roots })
    if (guard.roots.length === 0) {
      throw new ApiError(409, 'conflict_error', 'session_cwd_unknown',
        `会话 ${row?.id ?? ''} 没有可用的工作目录，无法确定文件范围；`
        + '请给 agent 配置 cwd，或在 files.roots 里列出允许访问的目录')
    }
    return guard
  }

  /**
   * 把本轮产物变成可下载条目。
   *
   * 单个文件出问题不影响整轮：标 `downloadable:false` + 原因，
   * 而不是让「模型答得好、但顺带的附件越界」把整个回复变成 500。
   */
  const materializeFiles = async ({ row, items, keyId }) => {
    if (!filesEnabled || items.length === 0) return []
    let guard
    try {
      guard = await guardFor(row)
    } catch (error) {
      const apiError = toApiError(error)
      return items.map(item => ({
        object: 'file',
        name: basename(toSlashes(item.path)) || toSlashes(item.path),
        path: toSlashes(item.path),
        source: item.source,
        ...(item.description ? { description: item.description } : {}),
        downloadable: false,
        download_error: apiError.code,
      }))
    }
    const expiresAt = Math.floor((Date.now() + config.files.tokenTtlMs) / 1000)
    const out = []
    for (const item of items) {
      const fallbackName = basename(toSlashes(item.path)) || toSlashes(item.path)
      try {
        const target = guard.resolve(item.path)
        const info = await files.stat({ sessionId: row.id, cwd: guard.cwd, path: target })
        const canonical = typeof info.absolutePath === 'string' && info.absolutePath.length > 0
          ? info.absolutePath
          : target
        // 词法合法不等于真实合法：符号链接可能指到允许范围之外，用 reader 的 canonical 路径复核。
        guard.assertAllowed(canonical)
        const name = basename(toSlashes(canonical)) || fallbackName
        const token = signer.sign({ s: row.id, p: canonical, k: keyId, n: name }, config.files.tokenTtlMs)
        out.push({
          object: 'file',
          name,
          path: guard.display(canonical),
          source: item.source,
          ...(item.description ? { description: item.description } : {}),
          ...(typeof info.size === 'number' ? { size: info.size } : {}),
          content_type: contentTypeFor(name),
          downloadable: true,
          download_url: `${config.files.publicBaseUrl ?? ''}/v1/files/${token}`,
          expires_at: expiresAt,
        })
      } catch (error) {
        const apiError = toApiError(error)
        out.push({
          object: 'file',
          name: fallbackName,
          path: toSlashes(item.path),
          source: item.source,
          ...(item.description ? { description: item.description } : {}),
          downloadable: false,
          download_error: apiError.code,
        })
      }
    }
    return out
  }

  /**
   * 投递一个文件：Bearer 路由与签名链接共用同一条路径。
   *
   * 顺序是固定的——解析 → 词法护栏 → stat → canonical 复核 → 流式写。
   * 任何一步失败都在写响应头之前结束，不会出现「半个文件」。
   */
  const serveFile = async ({ req, res, requestId, row, requestPath, keyId, inline }) => {
    const guard = await guardFor(row)
    const target = guard.resolve(requestPath)
    const info = await files.stat({ sessionId: row.id, cwd: guard.cwd, path: target })
    const canonical = typeof info.absolutePath === 'string' && info.absolutePath.length > 0 ? info.absolutePath : target
    guard.assertAllowed(canonical)

    const name = basename(toSlashes(canonical)) || 'download'
    const size = typeof info.size === 'number' ? info.size : undefined
    const etag = info.version ? `"${info.version}"` : undefined

    if (etag !== undefined && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'x-request-id': requestId })
      res.end()
      return
    }

    const range = parseRange(req.headers.range, size)
    if (range !== undefined && range.invalid) {
      const body = Buffer.from(JSON.stringify({
        error: { code: 'invalid_range', message: `Range 无法满足（文件大小 ${size ?? '未知'}）` },
      }))
      res.writeHead(416, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'content-range': `bytes */${size ?? '*'}`,
        'x-request-id': requestId,
      })
      res.end(body)
      return
    }

    const headers = {
      'content-type': contentTypeFor(name),
      'content-disposition': contentDisposition(name, { inline }),
      'cache-control': 'private, max-age=0, must-revalidate',
      'accept-ranges': 'bytes',
      'x-request-id': requestId,
      ...(etag ? { etag } : {}),
    }
    if (range) {
      headers['content-range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`
      headers['content-length'] = String(range.length)
    } else if (size !== undefined) {
      headers['content-length'] = String(size)
    }
    res.writeHead(range ? 206 : 200, headers)

    let closed = false
    let written = 0
    const expected = range ? range.length : size
    const onClose = () => { closed = true }
    res.on('close', onClose)
    try {
      for await (const chunk of files.chunks({
        sessionId: row.id,
        cwd: guard.cwd,
        path: canonical,
        offset: range?.offset ?? 0,
        length: range?.length,
      })) {
        if (closed || res.writableEnded || res.destroyed) break
        written += chunk.length
        if (!res.write(chunk)) await waitForDrain(res)
      }
      // 客户端可能在收到最后一个字节的同一瞬间断开（curl 就是这样），
      // 所以「close 过」不等于「没送完」：用「承诺的字节数是否都写出去」判定结果。
      const delivered = expected === undefined ? !closed : written >= expected
      metrics.inc('dsh_gateway_files_total', {
        kind: 'download',
        outcome: delivered ? 'ok' : closed ? 'aborted' : 'failed',
      })
      if (delivered) {
        log('info', 'file.served', {
          request_id: requestId, key: keyId, session: row.id, name,
          bytes: written, range: range ? `${range.offset}+${range.length}` : 'full',
        })
      }
    } catch (error) {
      // 头已经发出去了，改不了状态码。此时**不能**安静地 end()——
      // 那会让调用方拿到一个「200 + 短读」的文件，比失败更难查。
      const apiError = toApiError(error)
      metrics.inc('dsh_gateway_files_total', { kind: 'download', outcome: 'failed' })
      log('warn', 'file.stream.failed', {
        request_id: requestId, key: keyId, session: row.id, name,
        code: apiError.code, message: apiError.message,
      })
      res.destroy()
      return
    } finally {
      res.off('close', onClose)
      if (!res.writableEnded && !res.destroyed) res.end()
    }
  }

  /** 构造本轮内容块：input + 模板变量 + 内联图片。 */
  const buildContent = (agent, body) => {
    const inputs = body.inputs ?? {}
    if (inputs !== null && (typeof inputs !== 'object' || Array.isArray(inputs))) {
      throw new ApiError(400, 'invalid_request_error', 'invalid_inputs', 'inputs 必须是对象')
    }
    let text = body.input
    if (Array.isArray(text)) {
      text = text.filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('')
    }
    if (typeof text !== 'string') text = ''
    if (agent.template) {
      text = renderTemplate(agent.template, { ...inputs, input: text })
    } else if (Object.keys(inputs).length > 0) {
      throw new ApiError(400, 'invalid_request_error', 'unsupported_inputs',
        `agent ${agent.id} 未声明 template，不接受 inputs（避免把变量静默丢掉）`)
    }
    const images = toPromptAttachments(body.attachments, config.limits.maxImagesPerRequest)
    if (text.trim().length === 0 && images.length === 0) {
      throw new ApiError(400, 'invalid_request_error', 'empty_input', 'input 不能为空')
    }
    return [...(text.length > 0 ? [{ type: 'text', text }] : []), ...images]
  }

  const runMetadata = (agent, result, startedAt) => ({
    agent: agent.id,
    preset: agent.preset,
    ...(agent.effectiveModel ? { model: modelLabel(agent.effectiveModel) } : {}),
    model_source: agent.modelSource,
    turn: result.turn,
    steps: result.steps,
    finish_reason: result.finishReason,
    usage: result.usage,
    elapsed_ms: Date.now() - startedAt,
  })

  const recordUsage = (key, usageValue) => {
    if (!usageValue) return
    usage.record(key.id, usageValue)
    for (const kind of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      metrics.add('dsh_gateway_tokens_total', { key: key.id, kind }, usageValue[kind] ?? 0)
    }
  }

  /**
   * 执行一轮并记录计量；抛出的错误由调用方决定如何回给客户端。
   *
   * 产物收集挂在本轮的事件流上（`onEvent` 只在本轮认领之后回调）。
   * 回合结束后**先放掉会话锁**再 stat + 签链接：给产物补元数据是多出来的 RPC，
   * 不该让同会话的下一轮排在它后面。
   */
  const executeRun = async ({ key, agent, sessionId, row, content, controller, timeoutMs, onDelta }) => {
    const releaseLock = await locks.acquire(sessionId)
    const startedAt = Date.now()
    const bag = new DeliverableBag({ includeWritten: config.files.includeWritten })
    let result
    let metadata
    try {
      result = await runTurn({
        client,
        sessionId,
        content,
        signal: controller.signal,
        timeoutMs,
        onDelta,
        onEvent: event => bag.observe(event),
      })
      metadata = runMetadata(agent, result, startedAt)
      recordUsage(key, result.usage)
      metrics.inc('dsh_gateway_runs_total', { agent: agent.id, outcome: 'succeeded' })
      metrics.observeMilliseconds('dsh_gateway_run_duration', { agent: agent.id }, metadata.elapsed_ms)
    } catch (error) {
      metrics.inc('dsh_gateway_runs_total', {
        agent: agent.id,
        outcome: error?.code === 'client_closed' ? 'cancelled' : 'failed',
      })
      throw error
    } finally {
      releaseLock()
    }
    const turnFiles = await materializeFiles({ row, items: bag.list(), keyId: key.id })
    return { result, metadata, files: turnFiles }
  }

  const json = (res, status, payload, requestId) => {
    const body = Buffer.from(JSON.stringify(payload))
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'x-request-id': requestId,
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  /**
   * 原样转发：不投影、不改写，把 DSH `session/follow` 的帧按到达顺序写成 SSE。
   *
   * 帧结构（`snapshot` / `event` / `assistant-stream`）与字段一律保留，
   * 因此工具调用、步骤、审批、子智能体都在里面。
   * 只有一处裁剪：`snapshot.cursor` 之前的历史事件属于订阅前的旧回合，不再重复外发。
   */
  const streamRawTurn = async ({ res, requestId, key, agent, sessionId, content, controller, timeoutMs, runId }) => {
    const stream = await client.openStream('session/follow', {
      request: { address: { kind: 'session', sessionId }, assistantStream: true },
    })

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': requestId,
    })
    const write = (payload) => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n')
    }, config.server.heartbeatMs)
    heartbeat.unref?.()

    const promptId = `gw-${randomUUID()}`
    const deadline = Date.now() + timeoutMs
    let cursor = -1
    let promptSent = false
    let targetTurn
    let confirmed = false
    let timedOut = false

    // 到点必须收尾：raw 通道没有“回合结束”之外的终止条件，否则外部连接会一直挂着。
    const timer = setTimeout(() => {
      timedOut = true
      void client.call('session/cancel', { request: { sessionId } }, { timeoutMs: 10_000 }).catch(() => {})
      stream.close()
    }, Math.max(1000, timeoutMs))
    timer.unref?.()

    const onAbort = () => {
      void client.call('session/cancel', { request: { sessionId } }, { timeoutMs: 10_000 }).catch(() => {})
      stream.close()
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })

    try {
      for await (const frame of stream.queue) {
        if (controller.signal.aborted) break
        if (Date.now() > deadline) {
          timedOut = true
          break
        }
        if (!frame || typeof frame !== 'object') continue

        if (frame.type === 'snapshot') {
          cursor = frame.cursor ?? 0
          if (!promptSent) {
            promptSent = true
            await client.call('session/prompt', {
              request: { requestId: promptId, sessionId, mode: 'queue', content },
            }, { timeoutMs: 30_000 })
          }
          write(frame)
          continue
        }

        // 订阅前就存在的事件已在 snapshot 里，避免重复外发。
        if (frame.type === 'event' && typeof frame.event?.seq === 'number' && frame.event.seq <= cursor) continue

        write(frame)

        if (frame.type === 'event') {
          const event = frame.event
          if (event.type === 'approval/asked') {
            // 原样转发已经发出该帧；但没人能应答，继续等只会挂到超时，这里补一条终止帧。
            write({
              type: 'gateway-error',
              status: 409,
              code: 'approval_required',
              message: `本轮需要人工审批（工具 ${event.data?.toolName ?? '未知'}），当前部署没有审批通道，已按拒绝处理。`,
              details: { tool: event.data?.toolName, reason: event.data?.reason, call_id: event.data?.callId },
            })
            void client.call('session/cancel', { request: { sessionId } }, { timeoutMs: 10_000 }).catch(() => {})
            stream.close()
            break
          }
          if (event.type === 'user/message' && event.data?.source?.rpcId === promptId) {
            confirmed = true
            targetTurn = event.data?.turn
          } else if (event.type === 'turn/end' && confirmed
            && (targetTurn === undefined || event.data?.turn === targetTurn)) {
            break
          }
        }
      }
    } catch (error) {
      const apiError = toApiError(error)
      if (apiError.code !== 'client_closed' && apiError.status !== 499) {
        write({ type: 'gateway-error', status: apiError.status, code: apiError.code, message: apiError.message })
      }
      log('warn', 'raw.failed', {
        request_id: requestId, key: key.id, agent: agent.id, session: sessionId, run: runId,
        code: apiError.code, message: apiError.message,
      })
    } finally {
      clearTimeout(timer)
      clearInterval(heartbeat)
      controller.signal.removeEventListener('abort', onAbort)
      stream.close()
      if (timedOut) {
        write({ type: 'gateway-error', status: 408, code: 'run_timeout', message: `等待回合结束超时（${timeoutMs}ms）` })
      }
      if (!res.writableEnded) res.end()
    }
  }

  /**
   * 向会话发一条消息（跑一轮）。
   * `stream: false` → JSON；`stream: true` → start/delta/done 事件；`stream: "raw"` → DSH 原生帧。
   */
  const handleCreateMessage = async (req, res, requestId, sessionId) => {
    const key = authenticate(req)
    if (!limiter.take(key.id, key.rpm)) {
      throw new ApiError(429, 'rate_limit_error', 'rate_limit_exceeded', `密钥 ${key.id} 超出 ${key.rpm} 次/分钟`)
    }
    const row = store.assertOwner(sessionId, key)
    const body = await readJsonBody(req, config.server.maxBodyBytes)
    usage.assertWithinQuota(key)

    const agent = withStoredModel(resolveAgent(key, row.agent ?? row.app), row)
    const content = buildContent(agent, body)
    const mode = parseMode(body.stream)
    const timeoutMs = body.timeout_ms === undefined
      ? agent.maxRunMs ?? config.server.runTimeoutMs
      : Math.max(1000, Number(body.timeout_ms) || 0) || config.server.runTimeoutMs

    await assertSessionAlive(sessionId)
    store.touch(sessionId)

    const releaseSlot = acquireRunSlot(key)
    const controller = new AbortController()
    const messageId = `msg_${randomUUID().replaceAll('-', '')}`
    const createdAt = Math.floor(Date.now() / 1000)
    let channel

    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    activeRuns.set(messageId, { controller, sessionId, keyId: key.id })
    try {
      if (mode === 'raw') {
        return await streamRawTurn({
          res, requestId, key, agent, sessionId, content, controller, timeoutMs, runId: messageId,
        })
      }

      const streaming = mode === 'streaming'
      if (streaming) {
        channel = sseChannel(res, requestId, config.server.heartbeatMs)
        channel.send({ type: 'start', session_id: sessionId, message_id: messageId, agent: agent.id, created_at: createdAt })
      }

      let sentDelta = false
      const startedAt = Date.now()
      let outcome
      try {
        outcome = await executeRun({
          key,
          agent,
          sessionId,
          row,
          content,
          controller,
          timeoutMs,
          onDelta: streaming
            ? (text) => {
              sentDelta = true
              channel.send({ type: 'delta', session_id: sessionId, message_id: messageId, text })
            }
            : undefined,
        })
      } catch (error) {
        // SSE 已经回了 200，错误必须作为事件帧发出去，不能靠 HTTP 状态码。
        const apiError = toApiError(error)
        if (!streaming || !channel) throw error
        if (apiError.status === 499 || apiError.code === 'client_closed') {
          channel.send({
            type: 'done',
            session_id: sessionId,
            message_id: messageId,
            content: '',
            finish_reason: 'aborted',
            elapsed_ms: Date.now() - startedAt,
          })
        } else {
          channel.send({
            type: 'error',
            session_id: sessionId,
            status: apiError.status,
            code: apiError.code,
            message: apiError.message,
            ...(apiError.details ? { details: apiError.details } : {}),
          })
        }
        channel.close()
        log('warn', 'run.failed', {
          request_id: requestId, key: key.id, agent: agent.id, session: sessionId,
          run: messageId, code: apiError.code, message: apiError.message,
        })
        return
      }

      if (streaming) {
        // 适配器不提供 token 增量时，至少保证客户端拿到完整答案。
        if (!sentDelta && outcome.result.answer.length > 0) {
          channel.send({ type: 'delta', session_id: sessionId, message_id: messageId, text: outcome.result.answer })
        }
        channel.send({
          type: 'done',
          session_id: sessionId,
          message_id: messageId,
          content: outcome.result.answer,
          ...outcome.metadata,
          ...(outcome.files.length > 0 ? { files: outcome.files } : {}),
        })
        channel.close()
      } else {
        json(res, 200, {
          object: 'message',
          id: messageId,
          session_id: sessionId,
          role: 'assistant',
          content: outcome.result.answer,
          created_at: createdAt,
          ...outcome.metadata,
          ...(outcome.files.length > 0 ? { files: outcome.files } : {}),
        }, requestId)
      }
      log('info', 'run.completed', {
        request_id: requestId, key: key.id, agent: agent.id, session: sessionId,
        run: messageId, steps: outcome.result.steps, finish: outcome.result.finishReason,
        ms: outcome.metadata.elapsed_ms,
      })
    } finally {
      activeRuns.delete(messageId)
      releaseSlot()
      if (channel && !res.writableEnded) channel.close()
    }
  }

  /** POST /v1/sessions：显式建会话，模型在这一步固定。 */
  const handleCreateSession = async (req, res, requestId) => {
    const key = authenticate(req)
    if (!limiter.take(key.id, key.rpm)) {
      throw new ApiError(429, 'rate_limit_error', 'rate_limit_exceeded', `密钥 ${key.id} 超出 ${key.rpm} 次/分钟`)
    }
    const body = await readJsonBody(req, config.server.maxBodyBytes)
    if (body.agent !== undefined && typeof body.agent !== 'string') {
      throw new ApiError(400, 'invalid_request_error', 'invalid_agent', 'agent 必须是字符串')
    }
    const agent = withModelOverride(resolveAgent(key, body.agent), body.model)
    const row = await openSession(key, agent)
    const summary = await sessionSummary(row.id)
    json(res, 201, sessionObject(row, summary), requestId)
    log('info', 'session.created', {
      request_id: requestId, key: key.id, agent: agent.id, session: row.id,
      model: modelLabel(agent.effectiveModel),
    })
  }

  /** GET /v1/sessions */
  const handleListSessions = async (req, res, requestId, url) => {
    const key = authenticate(req)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200)
    const rows = store.listByKey(key.id, limit)
    let summaries = new Map()
    try {
      const list = await client.call('session/list', { _request: {} }, { timeoutMs: 15_000 })
      summaries = new Map((list?.items ?? []).map(item => [item.sessionId, item]))
    } catch {
      // DSH 不可达时仍返回网关档案；running 等运行时信息降级为未知。
    }
    const data = rows.map((row) => {
      const item = summaries.get(row.id)
      const title = item?.projections?.values?.title
      return sessionObject(row, {
        ...(typeof title === 'string' ? { title } : {}),
        running: item?.running === true,
      })
    })
    json(res, 200, { object: 'list', data, has_more: false }, requestId)
  }

  /** GET /v1/sessions/{id} */
  const handleGetSession = async (req, res, requestId, sessionId) => {
    const key = authenticate(req)
    const row = store.assertOwner(sessionId, key)
    const summary = await sessionSummary(sessionId)
    // 顺手补上档案里缺的 cwd：之后下载不必每次都去问 DSH。
    if (summary.cwd !== undefined) store.setCwd(row.id, summary.cwd)
    json(res, 200, sessionObject(row, summary), requestId)
  }

  /** POST /v1/sessions/{id}/cancel：按会话取消，不必先记住 message_id。 */
  const handleCancelSession = async (req, res, requestId, sessionId) => {
    const key = authenticate(req)
    store.assertOwner(sessionId, key)
    let cancelled = 0
    for (const run of activeRuns.values()) {
      if (run.sessionId === sessionId && (key.admin || run.keyId === key.id) && !run.controller.signal.aborted) {
        run.controller.abort()
        cancelled++
      }
    }
    log('info', 'session.cancel', { request_id: requestId, key: key.id, session: sessionId, cancelled })
    json(res, 200, { object: 'session', id: sessionId, cancelled }, requestId)
  }

  /** GET /v1/sessions/{id}/messages */
  const handleMessages = async (req, res, requestId, url, sessionId) => {
    const key = authenticate(req)
    store.assertOwner(sessionId, key)
    const raw = Number(url.searchParams.get('limit') ?? '50')
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 100) : 50
    const records = await readHistory(client, sessionId, { limit })
    if (records === undefined) {
      throw new ApiError(404, 'not_found_error', 'session_not_found', `session ${sessionId} 不存在`)
    }
    const data = []
    for (const record of records) {
      const event = record.event
      if (event?.type === 'user/message') {
        // 只要真人输入：runtime-context / skill-catalog / time-context 都是宿主注入的合成消息，
        // 对外暴露会污染对话历史。
        if (event.data?.source?.kind !== 'user') continue
        const text = (event.data?.content ?? []).filter(block => block?.type === 'text')
          .map(block => block.text).join('')
        data.push({
          object: 'message',
          id: `seq_${event.seq}`,
          session_id: sessionId,
          role: 'user',
          content: text,
          created_at: Math.floor(event.time / 1000),
        })
      } else if (event?.type === 'assistant/message') {
        const message = event.data?.message
        const text = (message?.content ?? []).filter(block => block?.type === 'text')
          .map(block => block.text).join('')
        data.push({
          object: 'message',
          id: `seq_${event.seq}`,
          session_id: sessionId,
          role: 'assistant',
          content: text,
          created_at: Math.floor(event.time / 1000),
          turn: event.data?.turn,
          step: event.data?.step,
        })
      }
    }
    json(res, 200, { object: 'list', data, has_more: false }, requestId)
  }

  /**
   * GET /v1/sessions/{id}/files?path=&limit=
   *
   * 浏览会话工作目录（默认根目录）。`path` 相对则按 cwd 解析，绝对则必须落在允许范围内。
   */
  const handleListFiles = async (req, res, requestId, url, sessionId) => {
    const key = authenticate(req)
    const row = store.assertOwner(sessionId, key)
    assertFilesEnabled()
    const guard = await guardFor(row)
    const requested = url.searchParams.get('path')
    const rawLimit = Number(url.searchParams.get('limit') ?? '200')
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000) : 200
    const dir = guard.resolve(requested === null || requested === '' ? '.' : requested)
    const listing = await files.list({ sessionId, cwd: guard.cwd, path: dir, limit })
    const data = listing.entries.map(entry => ({
      object: 'file',
      name: entry.name,
      path: guard.display(join(dir, entry.name)),
      type: entry.type,
      ...(entry.size === undefined ? {} : { size: entry.size }),
    }))
    metrics.inc('dsh_gateway_files_total', { kind: 'list', outcome: 'ok' })
    json(res, 200, {
      object: 'list',
      data,
      path: guard.display(dir),
      truncated: listing.truncated === true,
    }, requestId)
  }

  /** GET /v1/sessions/{id}/files/{path}：Bearer 鉴权 + 归属校验。 */
  const handleDownloadFile = async (req, res, requestId, url, sessionId, rawPath) => {
    const key = authenticate(req)
    const row = store.assertOwner(sessionId, key)
    assertFilesEnabled()
    await serveFile({
      req, res, requestId, row, requestPath: rawPath, keyId: key.id, inline: isInline(url),
    })
  }

  /**
   * GET /v1/files/{token}：链接本身就是授权。
   *
   * 令牌绑定「会话 + 绝对路径 + key + 过期时间」，所以可以安全地交给浏览器直接点；
   * 这里仍然重新走一遍护栏——链接签发之后 `files.roots` 可能被收紧过。
   */
  const handleSignedDownload = async (req, res, requestId, url, token) => {
    assertFilesEnabled()
    const payload = signer.verify(token)
    if (!payload) {
      throw new ApiError(403, 'permission_error', 'invalid_signature', '下载链接无效或已过期')
    }
    const key = config.auth.keys.find(item => item.id === payload.k)
    if (!key) {
      throw new ApiError(404, 'not_found_error', 'file_not_found', '下载链接对应的密钥已不存在')
    }
    const row = store.get(payload.s)
    // 与「不存在」统一成 404：不确认某个 session id 是否曾经存在。
    if (!row || (!key.admin && row.keyId !== key.id)) {
      throw new ApiError(404, 'not_found_error', 'session_not_found', `session ${payload.s} 不存在`)
    }
    await serveFile({
      req, res, requestId, row, requestPath: payload.p, keyId: key.id, inline: isInline(url),
    })
  }

  /** GET /v1/agents */
  const handleAgents = async (req, res, requestId) => {
    const key = authenticate(req)
    let roster = []
    let rosterError
    try {
      roster = await presets.list()
    } catch (error) {
      rosterError = error.message
    }
    const byId = new Map(roster.map(row => [row.id, row]))
    const allowed = key.agents.includes('*')
      ? config.agents
      : config.agents.filter(agent => key.agents.includes(agent.id))
    const data = allowed.map((agent) => {
      const row = byId.get(agent.preset)
      return {
        object: 'agent',
        id: agent.id,
        name: agent.name,
        description: agent.description,
        preset: agent.preset,
        ...(agent.effectiveModel ? { model: modelLabel(agent.effectiveModel) } : {}),
        model_source: agent.modelSource,
        available: Boolean(row) && !row.broken,
        ...(row?.broken ? { unavailable_reason: String(row.broken).slice(0, 300) } : {}),
        ...(row ? {} : { unavailable_reason: '当前 profile 未注册该预设' }),
      }
    })
    json(res, 200, {
      object: 'list',
      data,
      ...(rosterError ? { roster_error: rosterError } : {}),
    }, requestId)
  }

  /** GET /v1/models */
  const handleModels = async (req, res, requestId) => {
    authenticate(req)
    const catalog = await client.call('session/modelCatalog', {}, { timeoutMs: 15_000 })
    const data = []
    for (const group of catalog?.groups ?? []) {
      for (const model of group.models ?? []) {
        data.push({
          object: 'model',
          id: `${group.id}/${model.id}`,
          owned_by: group.id,
          name: model.name ?? model.id,
          context_window: model.contextWindow,
          reasoning_efforts: (model.reasoning?.efforts ?? []).map(effort => effort.id),
          is_default: catalog?.default?.provider === group.id && catalog?.default?.model === model.id,
        })
      }
    }
    json(res, 200, { object: 'list', data, default: catalog?.default }, requestId)
  }

  /** POST /v1/runs：异步跑一轮；不带 session_id 时按 agent 新建会话。 */
  const handleCreateRun = async (req, res, requestId) => {
    const key = authenticate(req)
    if (!limiter.take(key.id, key.rpm)) {
      throw new ApiError(429, 'rate_limit_error', 'rate_limit_exceeded', `密钥 ${key.id} 超出 ${key.rpm} 次/分钟`)
    }
    const body = await readJsonBody(req, config.server.maxBodyBytes)
    usage.assertWithinQuota(key)

    let sessionId = body.session_id
    if (sessionId !== undefined && typeof sessionId !== 'string') {
      throw new ApiError(400, 'invalid_request_error', 'invalid_session_id', 'session_id 必须是字符串')
    }

    const releaseSlot = acquireRunSlot(key)
    const controller = new AbortController()
    const runId = `run_${randomUUID().replaceAll('-', '')}`
    const createdAt = Date.now()

    let agent
    let content
    let row
    try {
      if (sessionId) {
        row = store.assertOwner(sessionId, key)
        agent = withStoredModel(resolveAgent(key, row.agent ?? row.app), row)
        content = buildContent(agent, body)
        await assertSessionAlive(sessionId)
        store.touch(sessionId)
      } else {
        if (body.agent !== undefined && typeof body.agent !== 'string') {
          throw new ApiError(400, 'invalid_request_error', 'invalid_agent', 'agent 必须是字符串')
        }
        agent = withModelOverride(resolveAgent(key, body.agent), body.model)
        content = buildContent(agent, body)
        row = await openSession(key, agent)
        sessionId = row.id
      }
    } catch (error) {
      releaseSlot()
      throw error
    }

    const record = {
      run_id: runId,
      status: 'queued',
      session_id: sessionId,
      agent: agent.id,
      created_at: createdAt,
      keyId: key.id,
    }
    asyncRuns.set(runId, record)
    activeRuns.set(runId, { controller, sessionId, keyId: key.id })
    pruneAsyncRuns()

    json(res, 202, {
      object: 'run',
      id: runId,
      status: record.status,
      session_id: sessionId,
      agent: agent.id,
      created_at: Math.floor(createdAt / 1000),
    }, requestId)

    const timeoutMs = body.timeout_ms === undefined
      ? agent.maxRunMs ?? config.server.runTimeoutMs
      : Math.max(1000, Number(body.timeout_ms) || 0) || config.server.runTimeoutMs

    setImmediate(() => {
      record.status = 'running'
      record.started_at = Date.now()
      void executeRun({ key, agent, sessionId, row, content, controller, timeoutMs })
        .then(({ result, metadata, files: turnFiles }) => {
          record.status = 'succeeded'
          record.content = result.answer
          record.metadata = metadata
          if (turnFiles.length > 0) record.files = turnFiles
          record.finished_at = Date.now()
          log('info', 'run.async.succeeded', {
            request_id: requestId, key: key.id, agent: agent.id, session: sessionId,
            run: runId, ms: metadata.elapsed_ms, files: turnFiles.length,
          })
        })
        .catch((error) => {
          const apiError = toApiError(error)
          record.status = apiError.code === 'client_closed' ? 'cancelled' : 'failed'
          record.error = { code: apiError.code, message: apiError.message, ...(apiError.details ? { details: apiError.details } : {}) }
          record.finished_at = Date.now()
          if (record.status === 'failed') {
            log('warn', 'run.async.failed', {
              request_id: requestId, key: key.id, agent: agent.id, run: runId,
              code: apiError.code, message: apiError.message,
            })
          }
        })
        .finally(() => {
          activeRuns.delete(runId)
          releaseSlot()
        })
    })
  }

  /** GET /v1/runs/{id} */
  const handleGetRun = async (req, res, requestId, runId) => {
    const key = authenticate(req)
    const record = asyncRuns.get(runId)
    if (!record) throw new ApiError(404, 'not_found_error', 'run_not_found', `run ${runId} 不存在或已过期`)
    if (!key.admin && record.keyId !== key.id) {
      throw new ApiError(404, 'not_found_error', 'run_not_found', `run ${runId} 不存在或已过期`)
    }
    json(res, 200, {
      object: 'run',
      id: record.run_id,
      status: record.status,
      session_id: record.session_id,
      agent: record.agent,
      created_at: Math.floor(record.created_at / 1000),
      ...(record.started_at ? { started_at: Math.floor(record.started_at / 1000) } : {}),
      ...(record.finished_at ? { finished_at: Math.floor(record.finished_at / 1000) } : {}),
      ...(record.content !== undefined ? { content: record.content } : {}),
      ...(record.files !== undefined ? { files: record.files } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      ...(record.error ? { error: record.error } : {}),
    }, requestId)
  }

  /** POST /v1/runs/{id}/cancel */
  const handleCancelRun = async (req, res, requestId, runId) => {
    const key = authenticate(req)
    await readJsonBody(req, config.server.maxBodyBytes)
    const active = activeRuns.get(runId)
    const record = asyncRuns.get(runId)
    const keyId = active?.keyId ?? record?.keyId
    if (keyId === undefined) throw new ApiError(404, 'not_found_error', 'run_not_found', `run ${runId} 不存在或已结束`)
    if (!key.admin && keyId !== key.id) {
      throw new ApiError(404, 'not_found_error', 'run_not_found', `run ${runId} 不存在或已结束`)
    }
    if (!active) {
      json(res, 200, { object: 'run', id: runId, status: record.status }, requestId)
      return
    }
    active.controller.abort()
    json(res, 200, { object: 'run', id: runId, status: 'cancelling' }, requestId)
  }

  /** GET /v1/usage */
  const handleUsage = async (req, res, requestId) => {
    const key = authenticate(req)
    const used = usage.get(key.id)
    const quota = key.tokenQuota || 0
    json(res, 200, {
      object: 'usage',
      key_id: key.id,
      usage: used,
      quota,
      remaining: quota > 0 ? Math.max(0, quota - used.totalTokens) : null,
    }, requestId)
  }

  const handleMetrics = async (req, res, requestId) => {
    authorizeMetrics(req)
    metrics.setGauge('dsh_gateway_active_runs', {}, activeRuns.size)
    const pending = [...asyncRuns.values()].filter(row => row.status === 'queued' || row.status === 'running').length
    metrics.setGauge('dsh_gateway_pending_async_runs', {}, pending)
    const body = Buffer.from(metrics.render())
    res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': body.length,
      'x-request-id': requestId,
    })
    res.end(body)
  }

  const handleHealth = async (req, res, requestId) => {
    let dsh = { reachable: false }
    try {
      const roster = await Promise.race([
        presets.list(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000)),
      ])
      dsh = { reachable: true, presets: roster.length, base_url: client.baseUrl }
    } catch (error) {
      dsh = { reachable: false, error: error.message, base_url: client.baseUrl }
    }
    const ok = dsh.reachable
    json(res, ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', version: VERSION, dsh }, requestId)
  }

  const server = createServer(async (req, res) => {
    const requestId = requestIdOf(req)
    const startedAt = Date.now()
    const url = new URL(req.url ?? '/', 'http://gateway.internal')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    try {
      if (req.method === 'GET' && path === '/healthz') return await handleHealth(req, res, requestId)
      if (req.method === 'GET' && path === '/metrics') return await handleMetrics(req, res, requestId)
      if (req.method === 'GET' && path === '/') {
        return json(res, 200, {
          name: 'dsh-api-gateway',
          version: VERSION,
          endpoints: [
            'GET  /healthz',
            'GET  /metrics',
            'GET  /v1/agents',
            'GET  /v1/models',
            'GET  /v1/usage',
            'POST /v1/sessions                        { agent?, model?, title? }',
            'GET  /v1/sessions?limit=',
            'GET  /v1/sessions/{id}',
            'POST /v1/sessions/{id}/cancel',
            'POST /v1/sessions/{id}/messages          { input, stream?: false|true|"raw" }',
            'GET  /v1/sessions/{id}/messages?limit=',
            'GET  /v1/sessions/{id}/files?path=&limit=',
            'GET  /v1/sessions/{id}/files/{path}       (?inline=1)',
            'GET  /v1/files/{token}                    签名链接，免 Bearer',
            'POST /v1/runs                            { agent?, session_id?, input }',
            'GET  /v1/runs/{id}',
            'POST /v1/runs/{id}/cancel',
          ],
        }, requestId)
      }

      if (req.method === 'GET' && path === '/v1/agents') return await handleAgents(req, res, requestId)
      if (req.method === 'GET' && path === '/v1/models') return await handleModels(req, res, requestId)
      if (req.method === 'GET' && path === '/v1/usage') return await handleUsage(req, res, requestId)
      if (req.method === 'GET' && path === '/v1/sessions') return await handleListSessions(req, res, requestId, url)
      if (req.method === 'POST' && path === '/v1/sessions') return await handleCreateSession(req, res, requestId)
      if (req.method === 'POST' && path === '/v1/runs') return await handleCreateRun(req, res, requestId)

      let match = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(path)
      if (match) {
        const sessionId = decodeSegment(match[1])
        if (req.method === 'POST') return await handleCreateMessage(req, res, requestId, sessionId)
        if (req.method === 'GET') return await handleMessages(req, res, requestId, url, sessionId)
      }

      match = /^\/v1\/sessions\/([^/]+)\/cancel$/.exec(path)
      if (req.method === 'POST' && match) {
        return await handleCancelSession(req, res, requestId, decodeSegment(match[1]))
      }

      // 文件：先精确匹配目录列举，再匹配带路径的下载。
      match = /^\/v1\/sessions\/([^/]+)\/files$/.exec(path)
      if (req.method === 'GET' && match) {
        return await handleListFiles(req, res, requestId, url, decodeSegment(match[1]))
      }

      match = /^\/v1\/sessions\/([^/]+)\/files\/(.+)$/.exec(path)
      if (req.method === 'GET' && match) {
        return await handleDownloadFile(
          req, res, requestId, url, decodeSegment(match[1]), decodeSegment(match[2]),
        )
      }

      match = /^\/v1\/files\/([^/]+)$/.exec(path)
      if (req.method === 'GET' && match) {
        return await handleSignedDownload(req, res, requestId, url, decodeSegment(match[1]))
      }

      match = /^\/v1\/sessions\/([^/]+)$/.exec(path)
      if (req.method === 'GET' && match) {
        return await handleGetSession(req, res, requestId, decodeSegment(match[1]))
      }

      match = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path)
      if (req.method === 'POST' && match) {
        return await handleCancelRun(req, res, requestId, decodeSegment(match[1]))
      }

      match = /^\/v1\/runs\/([^/]+)$/.exec(path)
      if (req.method === 'GET' && match) {
        return await handleGetRun(req, res, requestId, decodeSegment(match[1]))
      }

      throw new ApiError(404, 'not_found_error', 'route_not_found', `没有这个接口: ${req.method} ${path}`)
    } catch (error) {
      const apiError = toApiError(error)
      if (apiError.status !== 499) {
        log('warn', 'request.failed', {
          request_id: requestId, method: req.method, path, status: apiError.status,
          code: apiError.code, message: apiError.message, ms: Date.now() - startedAt,
        })
      }
      sendError(res, apiError, requestId)
    } finally {
      metrics.inc('dsh_gateway_requests_total', {
        route: routeLabel(path),
        status: String(res.statusCode),
      })
      if (config.server.accessLog) {
        log('info', 'access', {
          request_id: requestId, method: req.method, path, status: res.statusCode,
          ms: Date.now() - startedAt,
        })
      }
    }
  })

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    log('warn', 'client.error', { message: error.message })
  })

  return {
    server,
    store,
    presetCatalog: presets,
    async close() {
      clearInterval(pruneTimer)
      for (const run of activeRuns.values()) run.controller.abort()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
