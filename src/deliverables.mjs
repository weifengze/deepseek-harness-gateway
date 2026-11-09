/**
 * 一轮对话里「产出了哪些文件」。
 *
 * 只认两个来源，都在 `session/follow` 的既有事件流里，不需要额外 RPC：
 *
 *   1. `deliverables/presented` —— `present` 工具写下的**权威交付声明**，
 *      `files[].path` 已经是 `processPath` 之后的绝对路径，模型说「这是交付物」就是它。
 *   2. `tool/call` + `tool/result` —— `write` / `edit` 这类写文件工具成功落盘的结果。
 *      模型没声明交付时，这一层保证「改了文件却拿不到」不会发生。
 *
 * 都拿不到才算没有产物；不猜、不扫目录（扫工作区在大仓库里既慢又会把 node_modules 抖出来）。
 */

import { toSlashes } from './files.mjs'

/** 会落盘的写工具。名字取自 DSH 内置工具，`str_replace_editor` 是兼容 Claude 风格的别名。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'str_replace_editor', 'create_file'])

/** 工具参数里表示目标文件的键，按优先级取第一个存在的。 */
const PATH_KEYS = ['file_path', 'path', 'target_file', 'notebook_path']

function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    // 工具调用参数是流式拼出来的字符串，残缺是常态；残缺就当没看见，不影响本轮结果。
    return undefined
  }
}

function pathFromArguments(args) {
  if (!args) return undefined
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** 去重键：Windows 大小写不敏感，其余平台按原样。 */
function dedupeKey(path) {
  const normalized = toSlashes(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 产物收集器。喂事件即可，顺序无关（`present` 与写工具谁先到都行）。
 *
 * 只应该喂**属于本轮**的事件：跨轮的事件会把上一轮的交付物混进这一轮的响应。
 */
export class DeliverableBag {
  #calls = new Map()
  #entries = new Map()
  #order = 0
  #includeWritten

  /**
   * @param {{includeWritten?: boolean}} [options] 是否把 write/edit 落盘的文件也算进来
   */
  constructor({ includeWritten = true } = {}) {
    this.#includeWritten = includeWritten
  }

  get size() {
    return this.#entries.size
  }

  /**
   * 观察一个会话事件。
   * @param {{type?: string, data?: object}} event
   */
  observe(event) {
    if (!event || typeof event !== 'object') return
    const data = event.data ?? {}
    switch (event.type) {
      case 'tool/call': {
        if (typeof data.callId !== 'string') return
        this.#calls.set(data.callId, { name: data.name, args: parseArguments(data.arguments) })
        return
      }
      case 'tool/result': {
        if (!this.#includeWritten) return
        const call = this.#calls.get(data.message?.toolCallId)
        // 失败的写操作没有产物；重建失败（isError）同样不算。
        if (!call || !WRITE_TOOLS.has(call.name)) return
        if (data.message?.isError === true) return
        // result.meta.path 是 filesystem 的 canonical 绝对路径，比调用参数可靠。
        const path = typeof data.meta?.path === 'string' && data.meta.path.length > 0
          ? data.meta.path
          : pathFromArguments(call.args)
        if (!path) return
        this.#add({ path, source: call.name })
        return
      }
      case 'deliverables/presented': {
        for (const file of data.files ?? []) {
          if (typeof file?.path !== 'string' || file.path.length === 0) continue
          this.#add({
            path: file.path,
            source: 'present',
            ...(typeof file.description === 'string' && file.description.length > 0
              ? { description: file.description }
              : {}),
          })
        }
        return
      }
      default:
    }
  }

  #add(entry) {
    const key = dedupeKey(entry.path)
    const existing = this.#entries.get(key)
    if (!existing) {
      this.#entries.set(key, { ...entry, seq: ++this.#order })
      return
    }
    // 同一文件先被写、后被声明为交付：以交付为准，并把它挪到「声明顺序」的位置上，
    // 否则排序会按写盘时间而不是模型声明的顺序，调用方取第一个时会拿到次要产物。
    if (entry.source === 'present' && existing.source !== 'present') {
      this.#entries.set(key, { ...existing, ...entry, source: 'present', seq: ++this.#order })
      return
    }
    if (existing.description === undefined && entry.description !== undefined) {
      this.#entries.set(key, { ...existing, description: entry.description })
    }
  }

  /**
   * 交付物优先，组内按「成为交付物」的顺序。
   * 调用方通常只取第一个，所以模型显式声明的必须排在最前。
   * @returns {{path: string, source: string, description?: string}[]}
   */
  list() {
    const all = [...this.#entries.values()]
    const ordered = [
      ...all.filter(entry => entry.source === 'present').sort((a, b) => a.seq - b.seq),
      ...all.filter(entry => entry.source !== 'present').sort((a, b) => a.seq - b.seq),
    ]
    return ordered.map(({ seq, ...entry }) => entry)
  }
}
