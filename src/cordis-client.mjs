/**
 * 进程内 DSH 客户端：与 `DshClient` 同接口，但直接调用宿主的 Cordis 服务。
 *
 * 为什么需要它：DSH 的 `/api` 只认 `/connect` 换来的 per-process 令牌 + Cookie，
 * 而插件跑在宿主进程内，拿不到那个令牌（`browser-auth` 的 launchToken 是私有的）。
 * 因此在插件模式下，直接把 Remote 线名映射成服务方法调用，跳过 HTTP 与握手。
 *
 * 线名与实现的对应关系来自 `@Remote(...)` 装饰器：
 *   - `session/*`        → `ctx.sessionController.<method>`
 *   - `agentPresets/list` → `ctx.agentPresets.remoteExportList`（装饰器把线名 list 映射到该方法）
 */

import { RemoteStream } from './dsh-client.mjs'
import { ApiError } from './errors.mjs'

/**
 * 线名 → 服务方法名 + 参数装配。
 *
 * 参数键必须与 `@Remote` 方法的**形参名**一致：Cordis 按名字对号入座，
 * 例如 `list(_request, signal)` 的线名参数是 `_request`，而 `create(request)` 是 `request`。
 * 显式列出，避免把任意字符串拼进服务调用。
 *
 * `build` 用于带 Typert lookup 参数的方法：线上只有 `workspaceFileScopeId`（会话 id），
 * 由 Host 解析成 `WorkspaceFileScope`；进程内调用没有这层解析，所以由网关自己拼出来。
 * `workspaceRoot` 用会话 cwd——网关每次传的都是绝对路径，它只影响相对路径解析与目录列举。
 */
const METHODS = new Map([
  ['session/create', { service: 'sessionController', method: 'create', arg: 'request' }],
  ['session/selectModel', { service: 'sessionController', method: 'selectModel', arg: 'request' }],
  ['session/prompt', { service: 'sessionController', method: 'prompt', arg: 'request' }],
  ['session/cancel', { service: 'sessionController', method: 'cancel', arg: 'request' }],
  ['session/list', { service: 'sessionController', method: 'list', arg: '_request' }],
  ['session/page', { service: 'sessionController', method: 'page', arg: 'request' }],
  ['session/projections', { service: 'sessionController', method: 'projections', arg: 'request' }],
  ['session/modelCatalog', { service: 'sessionController', method: 'modelCatalog' }],
  ['agentPresets/list', { service: 'agentPresets', method: 'remoteExportList' }],
  ['workspaceFiles/stat', {
    service: 'workspaceFiles',
    method: 'stat',
    build: (args, options) => [fileScope(args, options), args.path],
  }],
  ['workspaceFiles/list', {
    service: 'workspaceFiles',
    method: 'list',
    build: (args, options) => [fileScope(args, options), args.path],
  }],
  ['workspaceFiles/readBytes', {
    service: 'workspaceFiles',
    method: 'readBytes',
    build: (args, options) => [fileScope(args, options), args.path, args.options ?? {}],
  }],
])

/**
 * 拼出 `WorkspaceFileScope`。
 *
 * 线上只有 `workspaceFileScopeId`，由 Host 的 lookup 解析成 scope；进程内没有这层，
 * 所以 workspaceRoot 由调用方作为**带外选项**传进来（HTTP 适配层会忽略它）。
 */
function fileScope(args, options) {
  return { sessionId: args.workspaceFileScopeId, workspaceRoot: options?.workspaceRoot }
}

/** 流式线名 → 服务方法名。 */
const STREAMS = new Map([
  ['session/follow', { service: 'sessionController', method: 'follow', arg: 'request' }],
])

export class CordisDshClient {
  #ctx
  #log

  /**
   * @param {object} ctx Cordis 上下文（插件 apply 的入参）
   * @param {{ log?: (level: string, message: string, extra?: object) => void }} [options]
   */
  constructor(ctx, { log } = {}) {
    this.#ctx = ctx
    this.#log = log ?? (() => {})
  }

  get baseUrl() {
    return 'cordis:in-process'
  }

  /**
   * 补答一个已经超时的 timed 提问。
   *
   * 进程内没有 Typert 的 SessionId→Agent 解析，只能自己从 `agents` 注册表取**精确那一份**
   * ——`assertLiveRoot` 要求 `agents.get(agent.id) === agent`，拿错实例会抛 `CALLER_NOT_LIVE`。
   * 会话没有活着 runtime（冷会话）时无法补答，这是 DSH 的语义，不是网关的限制。
   *
   * @param {{sessionId: string, callId: string, answer: {answers: object[]}}} request
   */
  async answerQuestion({ sessionId, callId, answer }) {
    const service = this.#service('userQuestions')
    const agents = this.#ctx.get('agents')
    const agent = agents?.get?.(sessionId)
    if (agent === undefined) {
      throw new ApiError(409, 'conflict_error', 'agent_not_live',
        `会话 ${sessionId} 没有活着的 runtime，无法补答；timed 补答只对正在运行的会话有效`,
        { session_id: sessionId })
    }
    return service.answer(agent, callId, answer)
  }

  /**
   * 接管提问：在宿主进程内挂 `user-questions/request` 瀑布监听。
   *
   * 与 sidecar 模式的差别：这里拿到的是原始事件（含 `agent` 实例），不需要
   * `$events` 流，也不需要 `interactions=answer`——但两边的表单状态是同一份，
   * HTTP 路由由 `server.mjs` 统一暴露。
   *
   * @param {import('./questions.mjs').QuestionBroker} broker
   * @param {(level: string, message: string, extra?: object) => void} [log]
   * @param {boolean} [hold] false = 直接放行
   */
  async attachQuestionChannel(broker, log, hold = true) {
    const { attachCordisQuestions } = await import('./questions.mjs')
    return attachCordisQuestions({ ctx: this.#ctx, broker, log, hold })
  }

  /** 服务缺失多半是 profile 没挂载对应插件；给出可定位的错误而不是 undefined 调用。 */
  #service(name) {
    const service = this.#ctx.get(name)
    if (service === undefined) {
      throw new ApiError(503, 'upstream_error', 'dsh_service_missing',
        `宿主未挂载服务 ${name}；请确认 profile 里包含对应插件`)
    }
    return service
  }

  /**
   * 调用一个非流式 Remote 方法。
   * @param {string} endpoint 线名，如 `session/create`
   * @param {object} [args] 网关侧统一用 `{ request }` 信封
   * @param {{ timeoutMs?: number, workspaceRoot?: string }} [options] 带外选项（workspaceRoot 只给 lookup 参数用）
   */
  async call(endpoint, args = {}, options = {}) {
    const entry = METHODS.get(endpoint)
    if (!entry) {
      throw new ApiError(500, 'upstream_error', 'unsupported_endpoint', `插件模式未映射的接口：${endpoint}`)
    }
    const service = this.#service(entry.service)
    // 按线名声明的参数装配；无参方法（如 modelCatalog）保持 undefined。
    const positional = entry.build
      ? entry.build(args ?? {}, options)
      : [entry.arg === undefined ? undefined : args?.[entry.arg]]
    // 服务方法的第二个参数是取消信号；超时用它表达，避免留下悬挂的调用。
    const signal = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
    try {
      const value = await service[entry.method](...positional, signal)
      return value
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new ApiError(504, 'timeout_error', 'dsh_timeout', `DSH 调用超时：${endpoint}`)
      }
      throw error
    }
  }

  /**
   * 打开一个流式 Remote（当前只有 `session/follow`）。
   * 返回结构与 `DshClient.openStream` 一致：`{ queue, close() }`。
   * @param {string} endpoint 线名
   * @param {object} [args] `{ request }` 信封
   */
  async openStream(endpoint, args = {}) {
    const entry = STREAMS.get(endpoint)
    if (!entry) {
      throw new ApiError(500, 'upstream_error', 'unsupported_endpoint', `插件模式未映射的流接口：${endpoint}`)
    }
    const service = this.#service(entry.service)
    const request = entry.arg === undefined ? undefined : args?.[entry.arg]
    const controller = new AbortController()
    const stream = new RemoteStream(() => {
      if (controller.signal.aborted) return
      controller.abort()
      stream.queue.end()
    })

    // 用一条独立任务泵送帧：服务返回 AsyncIterable，关闭时由 abort 让它退出。
    // 注意必须推进 `stream.queue`——RemoteStream 自带队列，另建一个队列会让消费者永远等不到帧。
    void (async () => {
      try {
        for await (const frame of service[entry.method](request, controller.signal)) {
          if (controller.signal.aborted) break
          stream.queue.push(frame)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.#log('warn', 'cordis.follow.failed', { endpoint, error: String(error?.message ?? error) })
          stream.queue.fail(error)
        }
      } finally {
        stream.queue.end()
      }
    })()

    return stream
  }

  /** 进程内没有连接可关；保留方法以满足网关的 close() 约定。 */
  close() {}
}
