/**
 * 用量账本：按 API key 累计 token，供配额判断与对账。
 *
 * DSH 的每次 assistant/message 都带 usage（inputTokens / outputTokens / cache*），
 * 网关只做累加与持久化，不重新估算 token。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { ApiError } from './errors.mjs'

const EMPTY = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  runs: 0,
}

export class UsageStore {
  #file
  #data = { keys: {} }
  #timer
  #log

  constructor(file, log) {
    this.#file = file
    this.#log = log ?? (() => {})
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object' && parsed.keys) this.#data = parsed
      } catch (error) {
        const backup = `${file}.corrupt-${Date.now()}`
        try {
          renameSync(file, backup)
          this.#log('error', `用量账本无法解析，已备份为 ${backup}: ${error.message}`)
        } catch {
          this.#log('error', `用量账本无法解析且备份失败: ${error.message}`)
        }
      }
    }
  }

  #save() {
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      try {
        mkdirSync(dirname(this.#file), { recursive: true })
        const tmp = `${this.#file}.tmp`
        writeFileSync(tmp, JSON.stringify(this.#data, null, 2), { mode: 0o600 })
        renameSync(tmp, this.#file)
      } catch (error) {
        this.#log('error', `写用量账本失败: ${error.message}`)
      }
    }, 300)
    this.#timer.unref?.()
  }

  get(keyId) {
    return { ...EMPTY, ...this.#data.keys[keyId] }
  }

  /**
   * 累加一次运行的用量。
   * @param {string} keyId
   * @param {object} [usage] DSH TokenUsage
   */
  record(keyId, usage) {
    const row = { ...EMPTY, ...this.#data.keys[keyId] }
    for (const [name, value] of Object.entries(usage ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) row[name] = (row[name] ?? 0) + value
    }
    row.runs += 1
    row.updatedAt = Date.now()
    this.#data.keys[keyId] = row
    this.#save()
    return { ...row }
  }

  /** 配额检查：超限直接拒绝，避免“先跑后扣”造成不可控消费。 */
  assertWithinQuota(key) {
    const quota = key.tokenQuota ?? 0
    if (quota <= 0) return
    const used = this.get(key.id).totalTokens
    if (used >= quota) {
      throw new ApiError(429, 'rate_limit_error', 'quota_exceeded',
        `密钥 ${key.id} 的 token 配额已用尽（${used}/${quota}）`,
        { used, quota })
    }
  }
}
