/**
 * 会话归属与并发闸门。
 *
 * DSH 的 session 是“owner 级”的：同一个 API Cookie 能看到并操作所有 session。
 * 对外暴露时必须补一层租户边界，否则任何调用方拿到 conversation_id 就能续写别人的对话。
 * 这里保存 key → conversation 的归属，并给每个 session 一把串行锁。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { ApiError } from './errors.mjs'

export class SessionStore {
  #file
  #data = { conversations: {} }
  #saveTimer
  #log

  constructor(file, log) {
    this.#file = file
    this.#log = log ?? (() => {})
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object' && parsed.conversations) this.#data = parsed
      } catch (error) {
        // 归档案损坏不阻塞启动：改名留证后用空表继续。
        const backup = `${file}.corrupt-${Date.now()}`
        try {
          renameSync(file, backup)
          this.#log('error', `会话档案无法解析，已备份为 ${backup}: ${error.message}`)
        } catch {
          this.#log('error', `会话档案无法解析且备份失败: ${error.message}`)
        }
      }
    }
  }

  #save() {
    if (this.#saveTimer) return
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined
      try {
        mkdirSync(dirname(this.#file), { recursive: true })
        const tmp = `${this.#file}.tmp`
        writeFileSync(tmp, JSON.stringify(this.#data, null, 2), { mode: 0o600 })
        renameSync(tmp, this.#file)
      } catch (error) {
        this.#log('error', `写会话档案失败: ${error.message}`)
      }
    }, 200)
    this.#saveTimer.unref?.()
  }

  get(id) {
    return this.#data.conversations[id]
  }

  /** 记录一个新会话的归属。 */
  create({ id, keyId, agent, model, modelSource, title }) {
    const now = Date.now()
    this.#data.conversations[id] = { id, keyId, agent, model, modelSource, title, createdAt: now, lastUsedAt: now }
    this.#save()
    return this.#data.conversations[id]
  }

  touch(id) {
    const row = this.#data.conversations[id]
    if (!row) return
    row.lastUsedAt = Date.now()
    this.#save()
  }

  countByKey(keyId) {
    let count = 0
    for (const row of Object.values(this.#data.conversations)) {
      if (row.keyId === keyId) count++
    }
    return count
  }

  listByKey(keyId, limit = 50) {
    return Object.values(this.#data.conversations)
      .filter(row => row.keyId === keyId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, limit)
  }

  /** 会话归属校验；管理员可跨 key 访问。 */
  assertOwner(id, key) {
    const row = this.#data.conversations[id]
    if (!row) {
      // 与“属于别人”返回同一个 404：不向外泄露某个 session id 是否存在。
      throw new ApiError(404, 'not_found_error', 'session_not_found', `session ${id} 不存在`)
    }
    if (key.admin) return row
    if (row.keyId !== key.id) {
      throw new ApiError(404, 'not_found_error', 'session_not_found', `session ${id} 不存在`)
    }
    return row
  }
}

/** 每个 session 一把串行锁：同一会话同时只跑一个 turn，其余排队。 */
export class SessionLocks {
  #locks = new Map()

  /**
   * 取得某会话的独占执行权。
   * @param {string} id
   * @returns {Promise<() => void>} 释放函数
   */
  async acquire(id) {
    const previous = this.#locks.get(id) ?? Promise.resolve()
    let release
    const current = new Promise((resolve) => { release = resolve })
    this.#locks.set(id, previous.then(() => current))
    await previous
    return () => {
      release()
      // 队列走空后清理，避免长跑的网关堆积空 promise。
      queueMicrotask(() => {
        if (this.#locks.get(id) === current) this.#locks.delete(id)
      })
    }
  }
}
