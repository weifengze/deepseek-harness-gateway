/**
 * 回合编排：把 DSH 的「提交提示词 + 事件流」折叠成一次可对外返回的 run。
 *
 * 关键时序（顺序不能换）：
 *   1. 先 openStream('session/follow')，拿到 snapshot 的 cursor；
 *   2. 再 session/prompt，用自带的 requestId 在事件流里认领本轮；
 *   3. 认领后只收该 turn 的 assistant/message 与增量；
 *   4. 遇到该 turn 的 turn/end 才收敛结果。
 * 先订阅再提问是为了不漏掉 prompt 之后立刻产生的事件；用 requestId 认领是为了
 * 在会话里已有旧 turn 正在跑（queue 模式）时不会把别人的结束当成自己的结束。
 */

import { randomUUID } from 'node:crypto'
import { ApiError } from './errors.mjs'

const PRESET_TTL_MS = 10_000

/** 预设清单缓存：用于在创建会话前拦住 broken 的 app。 */
export class PresetCatalog {
  #client
  #cache
  #expiresAt = 0

  constructor(client) {
    this.#client = client
  }

  async list() {
    if (this.#cache && Date.now() < this.#expiresAt) return this.#cache
    const value = await this.#client.call('agentPresets/list', {}, { timeoutMs: 10_000 })
    this.#cache = value?.presets ?? []
    this.#expiresAt = Date.now() + PRESET_TTL_MS
    return this.#cache
  }

  async assertUsable(preset) {
    const presets = await this.list()
    const row = presets.find(item => item.id === preset)
    if (!row) {
      throw new ApiError(404, 'not_found_error', 'agent_unavailable', `DSH 中不存在预设 ${preset}`, {
        available: presets.map(item => item.id),
      })
    }
    if (row.broken) {
      throw new ApiError(503, 'service_unavailable', 'agent_unavailable',
        `预设 ${preset} 在当前 profile 中激活失败：${String(row.broken).slice(0, 300)}`, { preset })
    }
    return row
  }
}

/** 确认会话是否存在（冷会话也可读）。 */
export async function sessionExists(client, sessionId) {
  const value = await client.call('session/projections', { request: { sessionId } }, { timeoutMs: 20_000 })
  return value !== null && value !== undefined
}

/** 创建一个绑定到指定预设的会话；agent.effectiveModel 存在时同时固定本轮模型。 */
export async function createSession(client, agent) {
  const request = { agentPreset: agent.preset }
  if (agent.workspaceId) request.workspaceId = agent.workspaceId
  else if (agent.cwd) request.cwd = agent.cwd
  const value = await client.call('session/create', { request }, { timeoutMs: 30_000 })
  if (!value?.sessionId) throw new ApiError(502, 'upstream_error', 'session_create_failed', 'DSH 未返回会话 id')

  const pinned = agent.effectiveModel ?? agent.model
  if (pinned) {
    try {
      // DSH 只有 selectModel 一个入口，且它会顺带把选择写成部署默认（后台保存）。
      // 这里在首轮之前就固定，因此本会话后续回合不受默认漂移影响；
      // 未声明 model 的 agent 由 models.default 兜底，同样被固定。
      await client.call('session/selectModel', {
        request: { sessionId: value.sessionId, ...pinned },
      }, { timeoutMs: 30_000 })
    } catch (error) {
      throw new ApiError(502, 'upstream_error', error.code ?? 'model_unavailable',
        `agent ${agent.id} 绑定模型 ${pinned.provider}/${pinned.model} 失败：${error.message}`,
        { provider: pinned.provider, model: pinned.model })
    }
  }
  return value.sessionId
}

/** 读取会话历史（供 GET /v1/sessions/{id}/messages 使用）。 */
export async function readHistory(client, sessionId, { limit = 20 } = {}) {
  const projections = await client.call('session/projections', { request: { sessionId } }, { timeoutMs: 20_000 })
  if (!projections) return undefined
  const throughSeq = projections.asOfSeq ?? 0
  if (throughSeq === 0) return []
  const page = await client.call('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: Math.max(1, Math.min(limit, 100)) },
  }, { timeoutMs: 30_000 })
  return page?.records ?? []
}

function textOfMessage(message) {
  if (!message?.content) return ''
  return message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

function addUsage(total, usage) {
  if (!usage) return total
  const out = total ?? {}
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number') out[key] = (out[key] ?? 0) + value
  }
  return out
}

/**
 * 执行一轮对话。
 * @param {object} options
 * @param {import('./dsh-client.mjs').DshClient} options.client
 * @param {string} options.sessionId
 * @param {{type: string, text?: string, mediaType?: string, data?: string}[]} options.content
 * @param {(text: string) => void} [options.onDelta] 文本增量回调（SSE 用）
 * @param {AbortSignal} [options.signal]
 * @param {number} options.timeoutMs
 * @returns {Promise<{answer: string, finishReason: string, usage?: object, steps: number, turn?: number}>}
 */
export async function runTurn({ client, sessionId, content, onDelta, signal, timeoutMs }) {
  const requestId = `gw-${randomUUID()}`
  const stream = await client.openStream('session/follow', {
    request: { address: { kind: 'session', sessionId }, assistantStream: true },
  })

  const deadline = Date.now() + timeoutMs
  let cursor = -1
  let promptSent = false
  let targetTurn
  let candidateTurn
  let confirmed = false
  let answer = ''
  let usage
  let steps = 0
  let finishReason = 'stop'
  let ended = false
  const attemptTurns = new Map()

  const onAbort = () => {
    void client.call('session/cancel', { request: { sessionId } }, { timeoutMs: 10_000 }).catch(() => {})
    stream.close()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for await (const frame of stream.queue) {
      if (signal?.aborted) throw new ApiError(499, 'timeout_error', 'client_closed', '运行已取消（调用方断开或显式 cancel）')
      if (Date.now() > deadline) {
        void client.call('session/cancel', { request: { sessionId } }, { timeoutMs: 10_000 }).catch(() => {})
        throw new ApiError(408, 'timeout_error', 'run_timeout', `等待模型响应超时（${timeoutMs}ms）`)
      }
      if (!frame || typeof frame !== 'object') continue

      if (frame.type === 'snapshot') {
        cursor = frame.cursor ?? 0
        if (!promptSent) {
          promptSent = true
          await client.call('session/prompt', {
            request: { requestId, sessionId, mode: 'queue', content },
          }, { timeoutMs: 30_000 })
        }
        continue
      }

      if (frame.type === 'assistant-stream') {
        const inner = frame.frame
        if (!inner) continue
        if (inner.type === 'start') {
          attemptTurns.set(inner.attemptId, inner.turn)
        } else if (inner.type === 'chunk') {
          const turn = attemptTurns.get(inner.attemptId)
          const ours = targetTurn === undefined || turn === undefined || turn === targetTurn
          if (ours && inner.chunk?.type === 'text-delta' && typeof inner.chunk.text === 'string' && onDelta) {
            onDelta(inner.chunk.text)
          }
        } else if (inner.type === 'end') {
          attemptTurns.delete(inner.attemptId)
        }
        continue
      }

      if (frame.type !== 'event') continue
      const event = frame.event
      if (!event || typeof event.seq !== 'number') continue
      // snapshot 之前的都是历史，不参与本轮判定。
      if (event.seq <= cursor) continue

      switch (event.type) {
        case 'approval/asked': {
          // 无人值守部署没有审批应答者：继续等只会把整轮挂到超时，这里显式失败并说明原因。
          void client.call('session/cancel', { request: { sessionId } }, { timeoutMs: 10_000 }).catch(() => {})
          const asked = event.data ?? {}
          throw new ApiError(409, 'conflict_error', 'approval_required',
            `本轮需要人工审批（工具 ${asked.toolName ?? '未知'}${asked.reason ? `：${asked.reason}` : ''}），`
            + '当前部署没有审批通道，已按拒绝处理。请在 DSH profile 把 approval.policy 设为 never，'
            + '并让 Agent 只在会话 cwd 内操作。',
            { tool: asked.toolName, reason: asked.reason, call_id: asked.callId })
        }
        case 'turn/start': {
          if (!confirmed) candidateTurn = event.data?.turn
          break
        }
        case 'user/message': {
          const source = event.data?.source
          if (source?.rpcId === requestId) {
            confirmed = true
            targetTurn = event.data?.turn ?? candidateTurn
          }
          break
        }
        case 'assistant/message': {
          const turn = event.data?.turn
          if (targetTurn !== undefined && turn !== targetTurn) break
          // 认领之前不采集：可能是旧 turn 的尾部。
          if (!confirmed) break
          steps++
          answer += textOfMessage(event.data?.message)
          usage = addUsage(usage, event.data?.usage)
          break
        }
        case 'turn/end': {
          const turn = event.data?.turn
          if (!confirmed || (targetTurn !== undefined && turn !== targetTurn)) break
          const reason = event.data?.reason ?? { kind: 'completed' }
          ended = true
          switch (reason.kind) {
            case 'completed': finishReason = 'stop'; break
            case 'max-tokens': finishReason = 'length'; break
            case 'aborted': finishReason = 'aborted'; break
            case 'blocked': finishReason = 'blocked'; break
            case 'interrupted':
            case 'forked': finishReason = reason.kind; break
            case 'error': {
              const failure = reason.error ?? {}
              throw new ApiError(502, 'upstream_error', failure.code ?? 'provider_error',
                failure.message ?? '模型调用失败', failure)
            }
            default: finishReason = 'stop'
          }
          break
        }
        default:
          break
      }
      if (ended) break
    }

    if (signal?.aborted) {
      throw new ApiError(499, 'timeout_error', 'client_closed', '运行已取消（调用方断开或显式 cancel）')
    }
    if (!confirmed) {
      throw new ApiError(502, 'upstream_error', 'run_not_accepted',
        'DSH 未确认本轮提示词（会话可能已关闭或预设不可用）')
    }
    if (!ended) {
      throw new ApiError(502, 'upstream_error', 'run_incomplete', '事件流在轮次结束前关闭')
    }
    return { answer, finishReason, usage, steps, turn: targetTurn, requestId }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    stream.close()
  }
}
