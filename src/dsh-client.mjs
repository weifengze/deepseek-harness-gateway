/**
 * DSH Host 适配层。
 *
 * 只做三件 DSH 自己已经定义好的事：
 *   1. GET /connect?token=... 换取签名 API Cookie（owner 级 Peer）；
 *   2. POST /api/<namespace>/<method> 发送 client-request 信封，取 server-response；
 *   3. WS /api/remote.mux 打开 Remote 流（session/follow、assistant-stream 增量）。
 *
 * 这一层刻意不认识任何业务语义，只把 wire 细节收敛在文件内。
 */

/** DSH 返回的结构化失败（RemoteError 的 wire 形态）。 */
export class DshError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DshError'
    this.code = code
    this.details = details
  }
}

/** 传输层失败：DNS、连接被拒、超时、进程重启等。 */
export class DshTransportError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'DshTransportError'
    this.cause = cause
  }
}

/** 简单的异步队列，把 WS 帧转成 for-await 可消费的流。 */
export class AsyncQueue {
  #items = []
  #waiters = []
  #done = false
  #failure

  push(value) {
    if (this.#done) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.#items.push(value)
  }

  end() {
    if (this.#done) return
    this.#done = true
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  fail(error) {
    if (this.#done) return
    this.#failure = error
    this.#done = true
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  next() {
    if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift(), done: false })
    if (this.#failure) return Promise.reject(this.#failure)
    if (this.#done) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }

  [Symbol.asyncIterator]() {
    return { next: () => this.next() }
  }
}

/** 一个已打开的 Remote 流。close() 等价于向上游发送 cancel。 */
export class RemoteStream {
  #queue = new AsyncQueue()
  #close

  constructor(close) {
    this.#close = close
  }

  get queue() {
    return this.#queue
  }

  /** 关闭流。幂等；重复调用只发一次 cancel。 */
  close() {
    this.#close()
  }
}

const CONNECT_PATH = '/connect'
const MUX_PATH = '/api/remote.mux'

/** 校验 `server-response` 信封并取出成功值；业务失败转成 DshError。 */
function unwrapEnvelope(envelope, endpoint) {
  const result = envelope?.result
  if (!result || typeof result.ok !== 'boolean') {
    throw new DshTransportError(`调用 ${endpoint} 返回了无效信封`)
  }
  if (!result.ok) {
    const error = result.error ?? {}
    throw new DshError(error.code ?? 'gateway/internal', error.message ?? '未知错误', error.details ?? {})
  }
  return result.value
}

/**
 * 把附件写回信封里它原本的占位位置。
 *
 * Connection 在传输二进制结果时会把 `Uint8Array` 摘出来，跑一次 `multipart/form-data`：
 * `metadata` 是原信封（占位处为 null），`bytes-N` 是裸字节，`attachments[].path`
 * 是**相对结果值**的键路径（实测 `readBytes` 给的是 `["data"]`）。
 * 三个候选基准按「从具体到整体」试，并且要求占位键真实存在——否则宁可判失败，
 * 也不要悄悄把字节塞到一个没人读的字段上。
 */
function applyAttachment(envelope, segments, bytes) {
  if (!Array.isArray(segments) || segments.length === 0) return false
  const leaf = segments[segments.length - 1]
  for (const base of [envelope?.result?.value, envelope?.result, envelope]) {
    let cursor = base
    let reachable = cursor !== null && typeof cursor === 'object'
    for (const key of segments.slice(0, -1)) {
      if (!reachable || cursor === null || typeof cursor !== 'object' || !(key in cursor)) {
        reachable = false
        break
      }
      cursor = cursor[key]
    }
    if (!reachable || cursor === null || typeof cursor !== 'object') continue
    // 占位键必须已经存在：这是「找对了基准」的唯一证据。
    if (!(leaf in cursor)) continue
    cursor[leaf] = bytes
    return true
  }
  return false
}

/** 解析二进制 RPC 的分段响应，还原成与普通调用同构的信封。 */
async function readMultipartEnvelope(response) {
  const form = await response.formData()
  const metadata = form.get('metadata')
  if (typeof metadata !== 'string') {
    throw new DshTransportError('二进制响应缺少 metadata 部分')
  }
  let envelope
  try {
    envelope = JSON.parse(metadata)
  } catch (error) {
    throw new DshTransportError(`二进制响应的 metadata 不是合法 JSON: ${error.message}`)
  }
  const attachments = Array.isArray(envelope?.attachments) ? envelope.attachments : []
  const unplaced = []
  for (const attachment of attachments) {
    const part = form.get(attachment?.part)
    if (part === null || typeof part === 'string') continue
    const bytes = new Uint8Array(await part.arrayBuffer())
    if (!applyAttachment(envelope, attachment.path, bytes)) unplaced.push(bytes)
  }
  // 路径对不上时退一步：只有一个附件且结果里有 data 占位，就认它。
  if (unplaced.length === 1 && envelope?.result?.value?.data === null) {
    envelope.result.value.data = unplaced[0]
  }
  delete envelope.attachments
  return envelope
}


/** 把 http(s) 基址换成 ws(s) 基址。 */
function toWsBase(baseUrl) {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

/** 从 Set-Cookie 头里挑出 DSH 的认证 Cookie（name 由 authority 派生，不做硬编码）。 */
function pickSessionCookie(headers) {
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean)
  for (const entry of list) {
    const pair = entry.split(';', 1)[0]
    const index = pair.indexOf('=')
    if (index > 0) return { name: pair.slice(0, index), value: pair.slice(index + 1) }
  }
  return undefined
}

export class DshClient {
  #baseUrl
  #getToken
  #interactions
  #cookie
  #authInFlight
  #ws
  #wsOpening
  #streams = new Map()
  #counter = 0
  #log

  /**
   * @param {object} options
   * @param {string} options.baseUrl DSH web 监听地址，如 http://127.0.0.1:3080
   * @param {string} [options.token] 固定令牌（与 getToken 二选一）
   * @param {() => Promise<string | undefined>} [options.getToken] 每次握手重新解析令牌，支持文件热更新
   * @param {'none' | 'answer'} [options.interactions] 是否声明「能替人应答」（见 `attachQuestionChannel`）
   * @param {(level: string, message: string, extra?: object) => void} [options.log]
   */
  constructor({ baseUrl, token, getToken, interactions = 'answer', log }) {
    this.#baseUrl = (baseUrl ?? '').replace(/\/+$/, '')
    this.#getToken = getToken ?? (async () => token)
    this.#interactions = interactions
    this.#log = log ?? (() => {})
  }

  get baseUrl() {
    return this.#baseUrl
  }

  /** 托管模式下 dsh 重启可能换端口/令牌。 */
  setBaseUrl(baseUrl) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
    this.#cookie = undefined
  }

  /** 运行时替换令牌（网关自己拉起 dsh 时，重启会换 token）。 */
  setToken(token) {
    this.#getToken = async () => token
    this.#cookie = undefined
  }

  /** 丢弃当前凭据，下次调用重新握手。 */
  invalidate() {
    this.#cookie = undefined
  }

  async #authenticate() {
    if (this.#cookie) return this.#cookie
    if (this.#authInFlight) return this.#authInFlight
    this.#authInFlight = (async () => {
      const token = await this.#getToken()
      if (!token) {
        throw new DshTransportError(
          '缺少 DSH 访问令牌：设置 DSH_API_TOKEN（或 DSH_TOKEN / dsh.tokenFile / dsh.token）',
        )
      }
      const url = new URL(`${this.#baseUrl}${CONNECT_PATH}`)
      url.searchParams.set('token', token)
      // `interactions` 决定这个 Peer 能不能打开 `$events`、能不能替人应答 waterfall。
      // 网关现在确实会应答（提问表单），所以默认 answer；关掉提问通道时仍保持 answer，
      // 否则任何转发事件都不会投递给网关，宿主只能挂到天荒地老。
      url.searchParams.set('interactions', this.#interactions)
      let response
      try {
        response = await fetch(url, { redirect: 'manual' })
      } catch (error) {
        throw new DshTransportError(`connect 失败: ${error.message}`, error)
      }
      if (response.status !== 302) {
        const body = await response.text().catch(() => '')
        throw new DshTransportError(`connect 被拒绝: HTTP ${response.status} ${body.slice(0, 200)}`)
      }
      const cookie = pickSessionCookie(response.headers)
      if (!cookie) throw new DshTransportError('connect 未返回认证 Cookie')
      this.#cookie = `${cookie.name}=${cookie.value}`
      this.#log('info', 'dsh: 已换取 API Cookie')
      return this.#cookie
    })().finally(() => {
      this.#authInFlight = undefined
    })
    return this.#authInFlight
  }

  /**
   * 调用一个一元 Remote 方法。
   * @param {string} endpoint `<namespace>/<method>`，如 session/prompt
   * @param {object} args 具名参数对象，字段必须与 DSH 描述符完全一致
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<unknown>} 成功值；失败抛 DshError
   */
  async call(endpoint, args, { signal, timeoutMs = 60_000 } = {}) {
    const run = async (retry) => {
      const cookie = await this.#authenticate()
      const rpcId = `gw-${process.pid}-${++this.#counter}`
      const body = JSON.stringify({
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload: { args },
      })
      let response
      try {
        response = await fetch(`${this.#baseUrl}/api/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body,
          signal: signal ?? AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          throw new DshTransportError(`调用 ${endpoint} 超时`, error)
        }
        throw new DshTransportError(`调用 ${endpoint} 失败: ${error.message}`, error)
      }
      if (response.status === 401 && retry) {
        this.invalidate()
        return run(false)
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new DshTransportError(`调用 ${endpoint} 返回 HTTP ${response.status}: ${text.slice(0, 200)}`)
      }
      // `workspaceFiles/readBytes` 这类带二进制的 RPC 回的是 multipart，不是 JSON 信封。
      const contentType = response.headers.get('content-type') ?? ''
      const envelope = contentType.includes('multipart/form-data')
        ? await readMultipartEnvelope(response)
        : await response.json()
      return unwrapEnvelope(envelope, endpoint)
    }
    return run(true)
  }

  async #ensureSocket() {
    if (this.#ws?.readyState === 1) return this.#ws
    if (this.#wsOpening) return this.#wsOpening

    this.#wsOpening = (async () => {
      const cookie = await this.#authenticate()
      const url = toWsBase(this.#baseUrl)
      url.pathname = MUX_PATH
      const socket = new WebSocket(url, { headers: { cookie } })
      socket.addEventListener('message', (event) => this.#onMessage(String(event.data)))
      socket.addEventListener('close', () => {
        const wasOpen = this.#ws === socket
        this.#ws = undefined
        if (wasOpen) this.#failAllStreams(new DshTransportError('DSH Remote 流连接已关闭'))
      })
      socket.addEventListener('error', () => {
        // close 会随后触发，错误细节统一由 close 分支上报。
      })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new DshTransportError('打开 Remote 流 WebSocket 超时')), 15_000)
        socket.addEventListener('open', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
        socket.addEventListener('close', (event) => {
          clearTimeout(timer)
          reject(new DshTransportError(`打开 Remote 流 WebSocket 失败: code ${event.code}`))
        }, { once: true })
      })
      this.#ws = socket
      this.#log('info', 'dsh: Remote 流通道已建立')
      return socket
    })().finally(() => {
      this.#wsOpening = undefined
    })
    return this.#wsOpening
  }

  #onMessage(text) {
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    const entry = this.#streams.get(frame.streamId)
    if (!entry) return
    if (frame.type === 'item') {
      entry.stream.queue.push(frame.value)
    } else if (frame.type === 'error') {
      const error = frame.error ?? {}
      entry.stream.queue.fail(new DshError(error.code ?? 'gateway/internal', error.message ?? '流失败', error.details ?? {}))
      this.#streams.delete(frame.streamId)
    } else if (frame.type === 'end') {
      entry.stream.queue.end()
      this.#streams.delete(frame.streamId)
    }
  }

  #failAllStreams(error) {
    for (const [id, entry] of this.#streams) {
      entry.stream.queue.fail(error)
      this.#streams.delete(id)
    }
  }

  /**
   * 打开一个 Remote 流。
   * @param {string} endpoint 如 session/follow
   * @param {object} args 具名参数
   * @returns {Promise<RemoteStream>}
   */
  async openStream(endpoint, args) {
    const socket = await this.#ensureSocket()
    const streamId = `s${++this.#counter}`
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      const entry = this.#streams.get(streamId)
      if (entry) {
        this.#streams.delete(streamId)
        try {
          if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'cancel', streamId }))
        } catch {
          // 连接已断时无需上报：cancel 只是尽力释放上游资源。
        }
        entry.stream.queue.end()
      }
    }
    const stream = new RemoteStream(close)
    this.#streams.set(streamId, { stream, endpoint })
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    return stream
  }

  /**
   * 打开转发事件流（`$events`）。
   *
   * 这条流承载 Host 主动推给客户端的事件：`ready`（带 clientId）、`waterfall`
   * （需要当面给结论）与 `cancel`。**必须**有人在听：DSH 会把未被应答的 waterfall
   * 一直挂在内存里，导致发起那一轮永远不结束。
   *
   * @returns {Promise<RemoteStream>} 帧原样透出，由 `attachRemoteQuestions` 解释
   */
  async openEvents() {
    return this.openStream('$events', {})
  }

  /**
   * 回一个 waterfall 的结论。
   * @param {string} clientId `ready` 帧里的身份
   * @param {string} eventId `waterfall` 帧里的事件 id
   * @param {{kind: 'next'} | {kind: 'result', value?: unknown} | {kind: 'rejected', error: object}} outcome
   */
  async replyEvent(clientId, eventId, outcome) {
    return this.call('$events/result', { clientId, eventId, outcome }, { timeoutMs: 15_000 })
  }

  /**
   * 接管提问：订阅 `$events`，把 `user-questions/request` 变成本进程里的待答表单。
   * @param {import('./questions.mjs').QuestionBroker} broker
   * @param {(level: string, message: string, extra?: object) => void} [log]
   * @param {boolean} [hold] false = 只保证不悬挂，提问直接放行
   */
  async attachQuestionChannel(broker, log, hold = true) {
    const { attachRemoteQuestions } = await import('./questions.mjs')
    return attachRemoteQuestions({
      openEvents: () => this.openEvents(),
      replyEvent: (clientId, eventId, outcome) => this.replyEvent(clientId, eventId, outcome),
      broker,
      log,
      hold,
    })
  }

  close() {
    this.#failAllStreams(new DshTransportError('网关正在关闭'))
    try {
      this.#ws?.close()
    } catch {
      // 关闭阶段的异常不影响退出。
    }
    this.#ws = undefined
  }
}
