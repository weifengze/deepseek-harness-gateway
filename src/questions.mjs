/**
 * 提问中枢：把 `ask_user_question` 的待答请求变成可 HTTP 提交的表单。
 *
 * 背景（实测，非推断）：DSH 的 `user-questions/request` 是 **waterfall** 事件，
 * 只由「声明了 interactions=answer 且打开了 `$events` 流」的客户端应答。
 * 网关以前用 interactions=none 连接，事件既没人应答也不会自动结算——
 * Host 把 pending 事件一直挂在内存里，于是模型那一轮永远等下去（实测 150s 无响应）。
 *
 * 所以这里做两件事：
 *   1. 订阅 `$events`，让每个 waterfall 都有确定结局（应答 / 放行），不再悬挂；
 *   2. 把 `user-questions/request` 挂起成一张待填表单，等调用方 POST 答案。
 *
 * 只支持 legacy（阻塞）形态：legacy 的请求里没有 `callId`，答案必须走本进程内存，
 * 进程重启即丢失——这也是为什么表单有 `waitMs` 上限，超时按「放行」处理，
 * 让工具以 `NO_PROVIDER` 快速失败，而不是把回合拖到全局超时。
 */

import { randomUUID } from 'node:crypto'
import { ApiError } from './errors.mjs'

/** 一个待答问题的存活上限；到点自动放行，避免调用方忘了答而拖死回合。 */
const DEFAULT_WAIT_MS = 120_000

/**
 * 校验并归一答案批量。
 *
 * DSH 自己的 `answer()` 会校验「每个问题恰好被回答一次」，但我们走的是直接应答
 * waterfall，绕过了那道校验——所以这份约束必须在网关侧重新建立，否则模型会收到
 * 一个形状不对的 tool result。
 *
 * @param {readonly {id: string, question: string, options?: {label: string}[], multiSelect?: boolean}[]} questions
 * @param {unknown} answers 调用方提交的答案
 * @returns {{answers: {id: string, selected: string[], custom?: string}[]}}
 */
export function normalizeAnswers(questions, answers) {
  if (!Array.isArray(answers)) {
    throw new ApiError(400, 'invalid_request_error', 'invalid_answers', 'answers 必须是数组')
  }
  const byId = new Map(questions.map(question => [question.id, question]))
  const seen = new Set()
  const out = []
  for (const item of answers) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ApiError(400, 'invalid_request_error', 'invalid_answers', 'answers 的每一项必须是对象')
    }
    if (typeof item.id !== 'string' || item.id === '') {
      throw new ApiError(400, 'invalid_request_error', 'invalid_answers', 'answers[].id 必须是非空字符串')
    }
    const question = byId.get(item.id)
    if (question === undefined) {
      throw new ApiError(400, 'invalid_request_error', 'unknown_question',
        `问题 ${item.id} 不属于本次提问`, { question_id: item.id })
    }
    if (seen.has(item.id)) {
      throw new ApiError(400, 'invalid_request_error', 'duplicate_answer',
        `问题 ${item.id} 被回答了多次`, { question_id: item.id })
    }
    seen.add(item.id)

    const selected = item.selected ?? []
    if (!Array.isArray(selected) || selected.some(label => typeof label !== 'string')) {
      throw new ApiError(400, 'invalid_request_error', 'invalid_selection',
        `问题 ${item.id} 的 selected 必须是字符串数组`, { question_id: item.id })
    }
    if (item.custom !== undefined && typeof item.custom !== 'string') {
      throw new ApiError(400, 'invalid_request_error', 'invalid_custom',
        `问题 ${item.id} 的 custom 必须是字符串`, { question_id: item.id })
    }

    const options = Array.isArray(question.options) ? question.options : []
    if (options.length > 0) {
      const labels = new Set(options.map(option => option.label))
      for (const label of selected) {
        if (!labels.has(label)) {
          throw new ApiError(400, 'invalid_request_error', 'unknown_option',
            `问题 ${item.id} 没有选项 ${JSON.stringify(label)}`, {
              question_id: item.id, option: label, options: [...labels],
            })
        }
      }
      if (question.multiSelect !== true && selected.length > 1) {
        throw new ApiError(400, 'invalid_request_error', 'too_many_selected',
          `问题 ${item.id} 只允许选择一个选项`, { question_id: item.id, selected })
      }
    }
    out.push({
      id: item.id,
      selected: [...selected],
      ...(item.custom !== undefined ? { custom: item.custom } : {}),
    })
  }
  if (out.length !== questions.length) {
    throw new ApiError(400, 'invalid_request_error', 'incomplete_answers',
      `本次提问有 ${questions.length} 个问题，需要逐个回答；收到 ${out.length} 个`, {
        expected: questions.map(question => question.id),
        received: out.map(answer => answer.id),
      })
  }
  return { answers: out }
}

/** 对外投影：不暴露内部 promise / 事件 id。 */
function project(entry) {
  return {
    id: entry.id,
    ...(entry.callId !== undefined ? { call_id: entry.callId } : {}),
    session_id: entry.sessionId,
    state: 'open',
    questions: entry.questions.map(question => ({
      id: question.id,
      question: question.question,
      ...(question.header !== undefined ? { header: question.header } : {}),
      ...(Array.isArray(question.options) ? { options: question.options } : {}),
      ...(question.multiSelect !== undefined ? { multi_select: question.multiSelect } : {}),
    })),
    created_at: Math.floor(entry.createdAt / 1000),
    expires_at: Math.floor(entry.expiresAt / 1000),
  }
}

/** DSH 的 `AskUserQuestionItem` → 网关的下划线形状。 */
function projectQuestion(question) {
  return {
    id: question.id,
    question: question.question,
    ...(question.header !== undefined ? { header: question.header } : {}),
    ...(Array.isArray(question.options) ? { options: question.options } : {}),
    ...(question.multiSelect !== undefined ? { multi_select: question.multiSelect } : {}),
  }
}

/**
 * 从 `session/projections` 的 `userQuestions` 视图里取出「还能补答」的问题。
 *
 * 只有 `state: 'continued'` 可补答——它表示那次调用已经以 pending 结束（timed 超时），
 * 答案会作为一条 `user-question-reply` 用户消息 steer 回会话。
 * `state: 'open'` 是调用还在前台等，只能走 waterfall（broker 那条路）。
 *
 * @param {unknown} value `session/projections` 的返回值
 * @returns {{id: string, call_id: string, questions: object[], state: string, raw: object[]}[]}
 */
export function mapTimedQuestions(value) {
  const view = value?.values?.userQuestions
  const active = Array.isArray(view?.active) ? view.active : []
  return active
    .filter(question => question?.state === 'continued' && typeof question.callId === 'string')
    .map(question => {
      const raw = Array.isArray(question.questions) ? question.questions : []
      return {
        id: question.callId,
        call_id: question.callId,
        state: 'continued',
        questions: raw.map(projectQuestion),
        raw,
      }
    })
}

/**
 * 读会话投影里的可补答问题。
 * @param {object} options
 * @param {{ call: Function }} options.client
 * @param {string} options.sessionId
 */
export async function readTimedQuestions({ client, sessionId }) {
  const value = await client.call('session/projections', { request: { sessionId } }, { timeoutMs: 15_000 })
  return mapTimedQuestions(value)
}

/**
 * 补答一个已经超时（`continued`）的 timed 提问。
 *
 * 这条路绕过 waterfall，直接调 `userQuestions.answer(agent, callId, answer)`：
 * DSH 会把答案包成一条 `user-question-reply` 用户消息 steer 进会话，并据此结算投影。
 *
 * @param {object} options
 * @param {{ call: Function, answerQuestion: Function }} options.client
 * @param {string} options.sessionId
 * @param {string} options.callId
 * @param {unknown} options.answers 调用方提交的答案
 */
export async function answerTimedQuestion({ client, sessionId, callId, answers }) {
  const pending = await readTimedQuestions({ client, sessionId })
  const target = pending.find(question => question.call_id === callId)
  if (target === undefined) {
    throw new ApiError(409, 'conflict_error', 'question_not_pending',
      `问题 ${callId} 不在等待答案（可能已回答、已撤销，或不属于该会话）`, { question_id: callId })
  }
  const value = normalizeAnswers(target.raw, answers)
  const accepted = await client.answerQuestion({ sessionId, callId, answer: value })
  if (accepted !== true) {
    throw new ApiError(409, 'conflict_error', 'question_not_answerable',
      `问题 ${callId} 已不能再接受答案（DSH 返回 false）`, { question_id: callId })
  }
  return { id: callId, session_id: sessionId, mode: 'late', answered_at: Math.floor(Date.now() / 1000) }
}

/**
 * 待答问题登记簿。
 *
 * 与传输无关：sidecar 模式由 `$events` 帧喂进来，插件模式由宿主 Cordis 事件喂进来，
 * 两者都调 `open()` 拿到一个 promise，再把结果按各自协议的形状回给 DSH。
 */
export class QuestionBroker {
  #pending = new Map()
  #listeners = new Set()
  #waitMs
  #log
  #metrics
  #closed = false

  /**
   * @param {object} options
   * @param {number} [options.waitMs] 单个问题的最长等待时间
   * @param {(level: string, message: string, extra?: object) => void} [options.log]
   * @param {import('./metrics.mjs').Metrics} [options.metrics]
   */
  constructor({ waitMs = DEFAULT_WAIT_MS, log, metrics } = {}) {
    this.#waitMs = waitMs
    this.#log = log ?? (() => {})
    this.#metrics = metrics
  }

  get waitMs() {
    return this.#waitMs
  }

  /** 有会话正在等答案时，调用方可以先 GET 一次再决定怎么答。 */
  list(sessionId) {
    const rows = []
    for (const entry of this.#pending.values()) {
      if (sessionId === undefined || entry.sessionId === sessionId) rows.push(project(entry))
    }
    return rows
  }

  get size() {
    return this.#pending.size
  }

  /**
   * 订阅待答问题（SSE 用）。回调收到 `{kind:'open'|'close', question}`。
   * @param {(event: {kind: 'open' | 'close', question: object, reason?: string}) => void} listener
   * @returns {() => void} 退订
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch (error) {
        this.#log('warn', 'question.listener.failed', { error: error.message })
      }
    }
  }

  /**
   * 登记一次提问并等待答案。
   * @param {object} options
   * @param {string} options.sessionId 提问所属会话（= 线帧里的 agentId）
   * @param {{id: string, question: string}[]} options.questions
   * @param {string} [options.eventId] waterfall 事件 id，用于取消时对账
   * @param {string} [options.callId] timed 模式下请求里带 `wait.callId`；有就用它当 id，
   *   这样调用方在「窗口内」和「超时后补答」两个阶段用的是同一个标识
   * @returns {{promise: Promise<object|null>, id: string}}
   *   `promise` 解析为 `{answers:[...]}` 或 `null`（放行 / 超时 / 撤销）
   */
  open({ sessionId, questions, eventId, callId }) {
    if (this.#closed) return { id: 'closed', promise: Promise.resolve(null) }
    const id = typeof callId === 'string' && callId.length > 0 ? callId : `q_${randomUUID()}`
    const createdAt = Date.now()
    const expiresAt = createdAt + this.#waitMs
    let settle
    const promise = new Promise((resolve) => { settle = resolve })
    const entry = {
      id, sessionId, questions, eventId, callId, createdAt, expiresAt,
      settled: false,
      settle: (value, reason) => {
        if (entry.settled) return false
        entry.settled = true
        clearTimeout(entry.timer)
        this.#pending.delete(id)
        this.#emit({ kind: 'close', question: project(entry), reason })
        if (this.#metrics !== undefined) {
          this.#metrics.inc('dsh_gateway_questions_total', { outcome: reason })
        }
        this.#log('info', 'question.closed', {
          question: id, session: sessionId, reason, ms: Date.now() - createdAt,
        })
        settle(value)
        return true
      },
      timer: undefined,
    }
    entry.timer = setTimeout(() => {
      entry.settle(null, 'timeout')
    }, this.#waitMs)
    // 刻意不 unref：有表单在等答案时，进程提前退出会让调用方永远收不到回应。
    // 正常关闭走 close()，那里会把所有定时器清掉。
    this.#pending.set(id, entry)
    this.#emit({ kind: 'open', question: project(entry) })
    this.#log('info', 'question.opened', {
      question: id, session: sessionId, count: questions.length, wait_ms: this.#waitMs,
    })
    return { id, promise }
  }

  /**
   * 提交答案。校验不通过抛 ApiError（400），问题不存在/已结束抛 409。
   * @param {string} questionId
   * @param {unknown} answers
   * @param {string} [sessionId] 传了就同时校验归属
   */
  answer(questionId, answers, sessionId) {
    const entry = this.#pending.get(questionId)
    if (entry === undefined) {
      throw new ApiError(409, 'conflict_error', 'question_not_pending',
        `问题 ${questionId} 不在等待答案（可能已超时或被撤销）`, { question_id: questionId })
    }
    if (sessionId !== undefined && entry.sessionId !== sessionId) {
      // 与「不存在」同码，避免跨会话探测。
      throw new ApiError(409, 'conflict_error', 'question_not_pending',
        `问题 ${questionId} 不在等待答案（可能已超时或被撤销）`, { question_id: questionId })
    }
    const value = normalizeAnswers(entry.questions, answers)
    entry.settle(value, 'answered')
    return { id: entry.id, session_id: entry.sessionId, answered_at: Math.floor(Date.now() / 1000) }
  }

  /** 主动放弃某个提问：宿主侧会收到「无人应答」，工具以 NO_PROVIDER 结束。 */
  decline(questionId, reason = 'declined') {
    const entry = this.#pending.get(questionId)
    if (entry === undefined) return false
    return entry.settle(null, reason)
  }

  /** 按 waterfall 事件 id 撤销（Host 侧已经取消，不必再回包）。 */
  withdraw(eventId, reason = 'cancelled') {
    for (const entry of [...this.#pending.values()]) {
      if (entry.eventId === eventId) entry.settle(null, reason)
    }
  }

  /** 关闭：所有未答问题一律放行，别让宿主那边的回合挂在内存里。 */
  close() {
    this.#closed = true
    for (const entry of [...this.#pending.values()]) entry.settle(null, 'shutdown')
    this.#listeners.clear()
  }
}

/**
 * sidecar 模式：订阅 `$events` 转发流，代替浏览器客户端应答 waterfall。
 *
 * 两个细节决定成败（都实测过）：
 *   - `/connect` 必须带 `interactions=answer`，否则打开 `$events` 会被
 *     `gateway/interactions-forbidden` 拒掉；
 *   - 回包走**一元接口** `$events/result`，不是流：`{clientId, eventId, outcome}`。
 *
 * 不属于提问的 waterfall（例如 `approval/request`）一律回 `next`：
 * 宿主会按自己的兜底策略收尾（审批是 `unavailable`，即 fail-closed），
 * 与「没有客户端」时完全一致，绝不会因为网关在场而改变语义。
 *
 * @param {object} options
 * @param {() => Promise<import('./dsh-client.mjs').RemoteStream>} options.openEvents
 * @param {(clientId: string, eventId: string, outcome: object) => Promise<unknown>} options.replyEvent
 * @param {QuestionBroker} options.broker
 * @param {(level: string, message: string, extra?: object) => void} [options.log]
 * @param {boolean} [options.hold] false 时提问也直接放行（只保证不悬挂）
 */
export async function attachRemoteQuestions({ openEvents, replyEvent, broker, log, hold = true }) {
  let closed = false
  let clientId
  let stream
  let retryTimer

  const reply = async (eventId, outcome) => {
    if (clientId === undefined) throw new Error('事件流尚未 ready')
    await replyEvent(clientId, eventId, outcome)
  }

  const handle = async (frame) => {
    if (frame.event !== 'user-questions/request' || !hold) {
      try {
        await reply(frame.eventId, { kind: 'next' })
      } catch (error) {
        log?.('warn', 'question.passthrough.failed', { event: frame.event, error: error.message })
      }
      return
    }
    const questions = Array.isArray(frame.request?.questions) ? frame.request.questions : []
    const callId = typeof frame.request?.wait?.callId === 'string' ? frame.request.wait.callId : undefined
    const waiter = broker.open({ sessionId: frame.agentId, questions, eventId: frame.eventId, callId })
    const value = await waiter.promise
    try {
      await reply(frame.eventId, value === null ? { kind: 'next' } : { kind: 'result', value })
    } catch (error) {
      log?.('warn', 'question.reply.failed', { question: waiter.id, error: error.message })
    }
  }

  const pump = async () => {
    while (!closed) {
      try {
        stream = await openEvents()
        // `RemoteStream` 本身不可迭代，帧在它的 `queue` 上（见 dsh-client 的 AsyncQueue）。
        for await (const frame of stream.queue) {
          if (closed) break
          if (frame?.type === 'ready') {
            clientId = frame.clientId
            log?.('info', 'questions.channel.ready', { client: clientId })
            continue
          }
          if (frame?.type === 'cancel') {
            broker.withdraw(frame.eventId)
            continue
          }
          if (frame?.type === 'waterfall') void handle(frame)
        }
        if (!closed) throw new Error('事件流已结束')
      } catch (error) {
        if (closed) break
        clientId = undefined
        log?.('warn', 'questions.channel.broken', { error: error.message })
        // 断线期间待答的问题已无意义：宿主那边的事件会随连接一起释放。
        for (const row of broker.list()) broker.decline(row.id, 'channel_closed')
        await new Promise((resolve) => { retryTimer = setTimeout(resolve, 5_000) })
      }
    }
  }

  void pump()
  return {
    close: async () => {
      closed = true
      clearTimeout(retryTimer)
      try {
        stream?.close()
      } catch {
        // 关闭阶段的异常不影响退出。
      }
    },
  }
}

/**
 * 插件模式：直接在宿主进程内挂 waterfall 监听。
 *
 * 不需要 `$events`、不需要 `interactions=answer`，拿到的是原始
 * `AskUserQuestionRequestEvent`（含 `agent` 实例）。返回 `undefined` 之外的
 * 值会被服务当成答案；放行必须显式调用 `next()`。
 *
 * @param {object} options
 * @param {any} options.ctx Cordis 上下文
 * @param {QuestionBroker} options.broker
 * @param {(level: string, message: string, extra?: object) => void} [options.log]
 * @param {boolean} [options.hold]
 */
export function attachCordisQuestions({ ctx, broker, log, hold = true }) {
  const handler = async (request, next) => {
    const sessionId = request?.agent?.id
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (!hold || typeof sessionId !== 'string' || questions.length === 0) return next()
    const callId = typeof request?.wait?.callId === 'string' ? request.wait.callId : undefined
    const waiter = broker.open({ sessionId, questions, callId })
    const value = await waiter.promise
    return value === null ? next() : value
  }
  let dispose
  try {
    dispose = ctx.on('user-questions/request', handler)
  } catch (error) {
    log?.('warn', 'questions.channel.unsupported', { error: error.message })
    return { close: async () => {} }
  }
  log?.('info', 'questions.channel.ready', { mode: 'cordis' })
  return {
    close: async () => {
      try {
        dispose?.()
      } catch {
        // 卸载阶段的异常不影响退出。
      }
    },
  }
}
