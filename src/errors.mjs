/**
 * 错误模型：把 DSH 的 RemoteError 码收敛成稳定的对外契约。
 *
 * 对外同时给出两套字段：
 *   - error.type / error.code / error.details：给程序判断；
 *   - code / message / status：Dify 客户端本来就按这三个字段解析。
 * 两套字段始终一致，避免“换个 SDK 就换一套错误处理”。
 */

import { randomUUID } from 'node:crypto'

/** 对外 API 错误。 */
export class ApiError extends Error {
  constructor(status, type, code, message, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.type = type
    this.code = code
    this.details = details ?? {}
  }
}

const RULES = [
  // 参数 / 协议
  [/^gateway\/(bad-request|arguments-invalid|input-invalid|signature-invalid|protocol)$/, 400, 'invalid_request_error'],
  [/^gateway\/(method-unavailable|definition-unavailable|invocation-unavailable|service-unavailable|lookup-unavailable|context-unavailable)$/, 503, 'service_unavailable'],
  [/^gateway\/(lookup-not-found|context-not-found)$/, 404, 'not_found_error'],
  [/^gateway\/peer-disposed$/, 410, 'peer_disposed'],
  [/^gateway\/cancelled$/, 408, 'timeout_error'],
  [/^gateway\//, 500, 'internal_error'],
  // 业务
  [/^session\/not-found$/, 404, 'not_found_error'],
  [/^session\/(agent-busy|migration-required|projections-unavailable)$/, 409, 'conflict_error'],
  [/^workspace\/not-found$/, 404, 'not_found_error'],
  // 文件读面（DSH workspaceFiles）：网关自己也会归一，这里是兜底，
  // 避免漏网点把 404 抖成 502。
  [/^workspace-file\/not-found$/, 404, 'not_found_error'],
  [/^workspace-file\/outside-workspace$/, 403, 'permission_error'],
  [/^workspace-file\/too-large$/, 413, 'invalid_request_error'],
  [/^workspace-file\/(not-text|not-regular-file|not-directory|unsupported-address)$/, 400, 'invalid_request_error'],
  [/^workspace-file\/(unknown-workspace|watch-unsupported)$/, 409, 'conflict_error'],
  [/^workspace-file\//, 502, 'upstream_error'],
  [/^agent-preset\/(not-found)$/, 404, 'not_found_error'],
  [/^agent-preset\/locked$/, 409, 'conflict_error'],
  [/^session\/provider-models-unavailable$/, 503, 'service_unavailable'],
  [/^session\/invalid-time-zone$/, 400, 'invalid_request_error'],
]

/** Dify 客户端认识的错误码。 */
function difyCode(type) {
  switch (type) {
    case 'invalid_request_error': return 'invalid_param'
    case 'authentication_error': return 'unauthorized'
    case 'permission_error': return 'forbidden'
    case 'not_found_error': return 'not_found'
    case 'conflict_error': return 'conflict'
    case 'rate_limit_error': return 'rate_limit_exceeded'
    case 'timeout_error': return 'timeout'
    case 'service_unavailable': return 'service_unavailable'
    case 'upstream_error': return 'provider_error'
    default: return 'internal_error'
  }
}

/**
 * 把任意异常归一成 ApiError。
 * @param {unknown} error
 * @returns {ApiError}
 */
export function toApiError(error) {
  if (error instanceof ApiError) return error
  const code = typeof error?.code === 'string' ? error.code : undefined
  if (code) {
    for (const [pattern, status, type] of RULES) {
      if (pattern.test(code)) {
        return new ApiError(status, type, code, error.message ?? code, error.details)
      }
    }
    return new ApiError(502, 'upstream_error', code, error.message ?? code, error.details)
  }
  if (error?.name === 'DshTransportError') {
    return new ApiError(503, 'service_unavailable', 'dsh_unreachable', error.message)
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new ApiError(408, 'timeout_error', 'timeout', '请求超时')
  }
  return new ApiError(500, 'internal_error', 'internal_error', error?.message ?? '未知错误')
}

/**
 * 生成/透传请求 id。
 * @param {import('node:http').IncomingMessage} req
 */
export function requestIdOf(req) {
  const incoming = req.headers['x-request-id']
  if (typeof incoming === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(incoming)) return incoming
  return `req_${randomUUID().replaceAll('-', '')}`
}

/**
 * 写出错误响应。
 * @param {import('node:http').ServerResponse} res
 * @param {ApiError} error
 * @param {string} requestId
 */
export function sendError(res, error, requestId) {
  if (res.destroyed) return
  if (res.headersSent) {
    res.end()
    return
  }
  const body = {
    // Dify 兼容字段
    code: difyCode(error.type),
    message: error.message,
    status: error.status,
    // 结构化字段
    error: {
      type: error.type,
      code: error.code,
      message: error.message,
      details: error.details,
      request_id: requestId,
    },
  }
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(error.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'x-request-id': requestId,
    'cache-control': 'no-store',
  })
  res.end(payload)
}
