#!/usr/bin/env node
/**
 * 冒烟测试：按真实调用顺序打一遍对外接口。
 * 用法：
 *   node scripts/smoke.mjs http://127.0.0.1:8787 <key> [agentId] [otherKey]
 * `otherKey` 用于租户隔离检查：必须是**另一个** key，且无权访问第一个 key 的会话。
 * 不传则该项标记为 SKIP（而不是假装通过）。
 * 会真实触发若干次（很短的）模型调用。
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const key = process.argv[3] ?? 'dsh_dev_local_key_0001'
const agent = process.argv[4] ?? 'assistant'
const otherKey = process.argv[5]

const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
let failures = 0

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

/** 缺少前置条件时如实标 SKIP，避免用“没测”冒充“通过”。 */
function skip(name, reason) {
  console.log(`SKIP  ${name}  ${reason}`)
}

async function getJson(path, init) {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body, headers: response.headers }
}

/** 读完一条 SSE，返回数据帧数组。 */
async function readSse(response, stopWhen) {
  const frames = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const line = block.split('\n').find(item => item.startsWith('data: '))
        if (!line) continue
        let payload
        try {
          payload = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        frames.push(payload)
        if (stopWhen(payload)) return frames
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return frames
}

async function main() {
  const health = await getJson('/healthz')
  check('GET /healthz', health.status === 200 && health.body?.status === 'ok',
    JSON.stringify(health.body?.dsh ?? {}))

  const unauthorized = await getJson('/v1/agents', { headers: { authorization: 'Bearer nope' } })
  check('401 无效 key', unauthorized.status === 401, `status=${unauthorized.status}`)

  const agents = await getJson('/v1/agents', { headers })
  check('GET /v1/agents', agents.status === 200 && Array.isArray(agents.body?.data),
    `agents=${(agents.body?.data ?? []).map(row => `${row.id}:${row.available}`).join(',')}`)

  const models = await getJson('/v1/models', { headers })
  check('GET /v1/models', models.status === 200 && (models.body?.data ?? []).length > 0,
    `models=${(models.body?.data ?? []).length}`)

  const modelRows = (agents.body?.data ?? []).filter(row => row.model)
  check('agent 报告生效模型与来源',
    modelRows.length > 0
      && modelRows.every(row => ['agent', 'models.default', 'dsh-default'].includes(row.model_source)),
    modelRows.map(row => `${row.id}:${row.model}(${row.model_source})`).join(','))

  const created = await getJson('/v1/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ agent }),
  })
  const sessionId = created.body?.id
  check('POST /v1/sessions 返回 201',
    created.status === 201 && typeof sessionId === 'string' && sessionId.startsWith('session-'),
    `session=${sessionId} agent=${created.body?.agent} model=${created.body?.model}`)

  const blocking = await getJson(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: '不要调用工具，只回复两个字：收到' }),
  })
  check('POST /messages (blocking)',
    blocking.status === 200 && blocking.body?.object === 'message'
      && typeof blocking.body?.content === 'string' && blocking.body.content.length > 0,
    `content=${JSON.stringify(blocking.body?.content)} ms=${blocking.body?.elapsed_ms}`)

  const followUp = await getJson(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: '刚才让你回复什么？只回答那两个字' }),
  })
  check('同一 session 续聊',
    followUp.status === 200 && followUp.body?.session_id === sessionId && followUp.body?.turn === 2,
    `turn=${followUp.body?.turn}`)

  const history = await getJson(`/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=10`, { headers })
  check('GET /sessions/{id}/messages',
    history.status === 200 && (history.body?.data ?? []).length >= 4,
    `messages=${(history.body?.data ?? []).length}`)

  const detail = await getJson(`/v1/sessions/${encodeURIComponent(sessionId)}`, { headers })
  check('GET /v1/sessions/{id}',
    detail.status === 200 && detail.body?.id === sessionId && detail.body?.object === 'session',
    `agent=${detail.body?.agent} title=${JSON.stringify(detail.body?.title)}`)

  const list = await getJson('/v1/sessions?limit=10', { headers })
  check('GET /v1/sessions',
    list.status === 200 && (list.body?.data ?? []).some(row => row.id === sessionId),
    `count=${(list.body?.data ?? []).length}`)

  // SSE：start → delta… → done
  const streamResponse = await fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: '用一句话说明什么是网关，不要调用工具', stream: true }),
  })
  check('POST stream=true 返回 SSE',
    streamResponse.status === 200 && (streamResponse.headers.get('content-type') ?? '').includes('text/event-stream'),
    streamResponse.headers.get('content-type') ?? '')
  const sseFrames = await readSse(streamResponse, payload => payload.type === 'done')
  const sawStart = sseFrames.some(frame => frame.type === 'start')
  const sawDone = sseFrames.some(frame => frame.type === 'done')
  const deltas = sseFrames.filter(frame => frame.type === 'delta').length
  check('SSE 事件序列 start/delta/done', sawStart && sawDone, `deltas=${deltas}`)

  // raw：原样转发 DSH 帧，必须出现 snapshot + turn/end
  const rawResponse = await fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: '只回复一个字：生', stream: 'raw' }),
  })
  check('POST stream="raw" 返回 SSE',
    rawResponse.status === 200 && (rawResponse.headers.get('content-type') ?? '').includes('text/event-stream'),
    rawResponse.headers.get('content-type') ?? '')
  const rawFrames = await readSse(rawResponse,
    frame => frame.type === 'event' && frame.event?.type === 'turn/end')
  const sawSnapshot = rawFrames.some(frame => frame.type === 'snapshot')
  const sawTurnEnd = rawFrames.some(frame => frame.type === 'event' && frame.event?.type === 'turn/end')
  check('raw 帧原样转发（snapshot → turn/end）', sawSnapshot && sawTurnEnd, `frames=${rawFrames.length}`)

  const missing = await getJson('/v1/sessions/session-does-not-exist/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: 'hi' }),
  })
  check('未知 session 返回 404', missing.status === 404, `status=${missing.status}`)

  const badAgent = await getJson('/v1/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ agent: 'no-such-agent' }),
  })
  check('未知 agent 返回 404', badAgent.status === 404, `status=${badAgent.status}`)

  // 租户隔离：换一个无权访问该 session 的 key
  if (!otherKey) {
    skip('跨 key 读 session 返回 404', '未提供第 5 个参数 otherKey')
  } else {
    const other = await getJson(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${otherKey}` },
    })
    check('跨 key 读 session 返回 404', other.status === 404, `status=${other.status}`)
  }

  // 异步 run：202 → 轮询 → succeeded
  const runCreated = await getJson('/v1/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ session_id: sessionId, input: '不要调用工具，只回复：异步OK' }),
  })
  check('POST /v1/runs 返回 202',
    runCreated.status === 202 && typeof runCreated.body?.id === 'string',
    `run=${runCreated.body?.id}`)
  let runStatus = runCreated.body?.status
  let runBody
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const polled = await getJson(`/v1/runs/${runCreated.body.id}`, { headers })
    runBody = polled.body
    runStatus = polled.body?.status
    if (runStatus !== 'queued' && runStatus !== 'running') break
  }
  check('异步 run 收敛', runStatus === 'succeeded' && typeof runBody?.content === 'string',
    `status=${runStatus} content=${JSON.stringify(runBody?.content)}`)

  const usage = await getJson('/v1/usage', { headers })
  check('GET /v1/usage', usage.status === 200 && (usage.body?.usage?.runs ?? 0) > 0,
    `runs=${usage.body?.usage?.runs} tokens=${usage.body?.usage?.totalTokens}`)

  // /metrics 的访问规则是「admin key 或回环」。容器里抓取方来自网桥，回环免鉴权不成立，
  // 所以先带 key 请求；只有 403 才说明这是权限问题（跳过），不代表接口坏了。
  let metrics = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${key}` } })
  if (metrics.status === 401 || metrics.status === 403) {
    metrics = await fetch(`${base}/metrics`)
  }
  const metricsText = await metrics.text()
  if (metrics.status === 403) {
    skip('GET /metrics', '当前 key 不是 admin，且非回环访问（在容器内属正常）')
  } else {
    check('GET /metrics', metrics.status === 200 && metricsText.includes('dsh_gateway_runs_total'),
      `bytes=${metricsText.length}`)
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('冒烟测试异常:', error)
  process.exit(1)
})
