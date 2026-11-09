/**
 * 产物文件的读取与投递。
 *
 * 三件事必须在这一层定死，否则「文件下载」等于给调用方开了一个任意读的后门：
 *
 *   1. **路径护栏**：请求路径先归一化（`..`、分隔符、Windows 盘符大小写），再判包含关系；
 *      读取前还要用 reader 返回的 canonical 路径复核一次，防止符号链接把范围捅穿。
 *   2. **两种 reader**：宿主 `workspaceFiles` 是权威读面（能跨容器、走 DSH 的 composed fs），
 *      本地 `node:fs` 是零依赖兜底（网关与 DSH 同机时永远可用）。`auto` 先探后者再降级。
 *   3. **签名下载链接**：把「一次性授权」从 Bearer 头里拿出来，浏览器点开就能下；
 *      令牌绑定 `会话 + 绝对路径 + key`，过期即废。
 *
 * DSH 的 `workspaceFiles.readBytes` 明确允许读工作区之外的文件（它服务于 Web UI 的预览），
 * 所以**范围收窄这件事只能由网关做**，不能指望上游。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { ApiError } from './errors.mjs'

/** DSH 单次字节窗口的默认上限（`workspaceFiles.maxBytes`），超过会被判 too-large。 */
const DSH_WINDOW_BYTES = 2 * 1024 * 1024

const WINDOWS = process.platform === 'win32'

const MIME = new Map([
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['doc', 'application/msword'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['xls', 'application/vnd.ms-excel'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pdf', 'application/pdf'],
  ['csv', 'text/csv; charset=utf-8'],
  ['tsv', 'text/tab-separated-values; charset=utf-8'],
  ['md', 'text/markdown; charset=utf-8'],
  ['txt', 'text/plain; charset=utf-8'],
  ['log', 'text/plain; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['xml', 'application/xml; charset=utf-8'],
  ['yaml', 'text/yaml; charset=utf-8'],
  ['yml', 'text/yaml; charset=utf-8'],
  ['html', 'text/html; charset=utf-8'],
  ['htm', 'text/html; charset=utf-8'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['svg', 'image/svg+xml'],
  ['bmp', 'image/bmp'],
  ['zip', 'application/zip'],
  ['7z', 'application/x-7z-compressed'],
  ['gz', 'application/gzip'],
  ['tar', 'application/x-tar'],
  ['mp4', 'video/mp4'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['py', 'text/x-python; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['ts', 'text/typescript; charset=utf-8'],
])

/** 由文件名推断 Content-Type；认不出就给二进制流，让调用方自己看。 */
export function contentTypeFor(name) {
  const ext = extname(String(name ?? '')).slice(1).toLowerCase()
  return MIME.get(ext) ?? 'application/octet-stream'
}

/** 统一分隔符：Windows 下 DSH 与网关都可能给出反斜杠。 */
export function toSlashes(value) {
  return String(value ?? '').replaceAll('\\', '/')
}

/**
 * 路径的比较键：绝对化 → 统一分隔符 → Windows 统一盘符与大小写 → 去掉末尾分隔符。
 * 只用于判等与判包含，不用于展示或读取。
 */
export function pathKey(value) {
  let out = toSlashes(resolve(String(value)))
  if (WINDOWS) out = out.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`).toLowerCase()
  if (out.length > 1 && !/^[a-z]:$/i.test(out)) out = out.replace(/\/+$/, '')
  return out === '' ? '/' : out
}

/** `target` 是否落在 `root` 内部（含 root 自身）。 */
export function containsPath(root, target) {
  const r = pathKey(root)
  const t = pathKey(target)
  if (t === r) return true
  return t.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/** 相对路径；不在 `root` 内时原样返回绝对路径。展示用，不参与安全判定。 */
export function displayPathOf(root, target) {
  const absolute = toSlashes(resolve(String(target)))
  if (!root) return absolute
  if (!containsPath(root, target)) return absolute
  if (pathKey(root) === pathKey(target)) return '.'
  const base = toSlashes(resolve(String(root))).replace(/\/+$/, '')
  // containsPath 已保证前缀一致；这里按原始大小写切，长度与 pathKey 相同。
  return absolute.slice(base.length + 1)
}

/**
 * 一次请求允许触碰的目录集合。
 *
 * 顺序即优先级：先看会话 cwd，再看 `files.roots`（部署方显式放开的外部目录）。
 * 构造后不可变，避免运行期被改出一个更宽的范围。
 */
export class FileGuard {
  #cwd
  #roots

  /**
   * @param {{cwd?: string, roots?: string[]}} options
   */
  constructor({ cwd, roots = [] } = {}) {
    this.#cwd = cwd === undefined || cwd === null || cwd === '' ? undefined : resolve(String(cwd))
    this.#roots = roots.filter(item => typeof item === 'string' && item.length > 0).map(item => resolve(item))
  }

  get cwd() {
    return this.#cwd
  }

  get roots() {
    return this.#cwd === undefined ? [...this.#roots] : [this.#cwd, ...this.#roots]
  }

  /** 展示用：cwd 内给相对路径，其余给绝对路径。 */
  display(target) {
    return displayPathOf(this.#cwd, target)
  }

  /**
   * 请求路径 → 绝对路径。相对路径按会话 cwd 解析。
   * 越界抛 403，格式非法抛 400；这里只做词法判定，符号链接由 `contains` 复核。
   * @param {string} requestPath
   * @returns {string}
   */
  resolve(requestPath) {
    if (typeof requestPath !== 'string' || requestPath.trim().length === 0) {
      throw new ApiError(400, 'invalid_request_error', 'invalid_path', '文件路径不能为空')
    }
    if (requestPath.includes('\0')) {
      throw new ApiError(400, 'invalid_request_error', 'invalid_path', '文件路径不能包含 NUL')
    }
    const raw = toSlashes(requestPath.trim())
    const absolute = isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)
      ? resolve(raw)
      : this.#cwd === undefined
        ? undefined
        : resolve(this.#cwd, raw)
    if (absolute === undefined) {
      throw new ApiError(409, 'conflict_error', 'session_cwd_unknown',
        '会话没有工作目录，无法解析相对路径；请改用绝对路径（且需落在 files.roots 内）')
    }
    this.assertAllowed(absolute)
    return absolute
  }

  /** 不做解析，只判定是否落在允许范围内。 */
  contains(target) {
    const roots = this.roots
    if (roots.length === 0) return false
    return roots.some(root => containsPath(root, target))
  }

  /**
   * 断言落在允许范围内。用于两种场合：词法解析后，以及拿到 canonical 路径后复核。
   * @param {string} target
   * @returns {string} 原样返回，便于链式使用
   */
  assertAllowed(target) {
    const roots = this.roots
    if (roots.length === 0) {
      throw new ApiError(403, 'permission_error', 'file_outside_scope',
        '会话没有工作目录且未配置 files.roots，拒绝访问任何文件')
    }
    if (!this.contains(target)) {
      throw new ApiError(403, 'permission_error', 'file_outside_scope',
        '文件不在会话工作目录（或 files.roots）内，拒绝访问', { path: target, roots })
    }
    return target
  }
}

/** 把 fs 的 errno 收敛成对外错误码，避免把 Windows 路径塞进 500。 */
function wrapFsError(error, target) {
  const code = error?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new ApiError(404, 'not_found_error', 'file_not_found', `文件不存在: ${target}`)
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new ApiError(403, 'permission_error', 'file_not_readable', `没有读取权限: ${target}`)
  }
  if (code === 'EISDIR') {
    return new ApiError(400, 'invalid_request_error', 'file_not_regular', `${target} 是目录，不是文件`)
  }
  if (code === 'ELOOP') {
    return new ApiError(400, 'invalid_request_error', 'file_not_regular', `${target} 的符号链接层级过深`)
  }
  return error
}

/**
 * 把 DSH 的 `workspace-file/*` 收敛成网关自己的码。
 *
 * 对外错误码是契约：换一个 reader 不该换一套错误处理。所以 `not-found` 在两种读面下
 * 都必须是 `file_not_found`，而不是把上游的码原样透出去。
 */
function wrapUpstreamFileError(error, target) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (!code.startsWith('workspace-file/')) return error
  const message = error.message ?? `读取 ${target} 失败`
  switch (code) {
    case 'workspace-file/not-found':
      return new ApiError(404, 'not_found_error', 'file_not_found', message, { path: target })
    case 'workspace-file/outside-workspace':
      return new ApiError(403, 'permission_error', 'file_outside_scope', message, { path: target })
    case 'workspace-file/too-large':
      return new ApiError(413, 'invalid_request_error', 'file_too_large', message, { path: target })
    case 'workspace-file/not-regular-file':
      return new ApiError(400, 'invalid_request_error', 'file_not_regular', message, { path: target })
    case 'workspace-file/not-directory':
      return new ApiError(400, 'invalid_request_error', 'file_not_directory', message, { path: target })
    default:
      return new ApiError(502, 'upstream_error', code, message, { path: target })
  }
}

/** 本地文件系统 reader：网关与 DSH 同机时零依赖可用。 */
export class LocalFileReader {
  #maxBytes

  constructor({ maxBytes }) {
    this.#maxBytes = maxBytes
  }

  async stat(target) {
    let info
    try {
      info = await stat(target)
    } catch (error) {
      throw wrapFsError(error, target)
    }
    if (!info.isFile()) {
      throw new ApiError(400, 'invalid_request_error', 'file_not_regular', `${target} 不是普通文件`)
    }
    if (info.size > this.#maxBytes) {
      throw new ApiError(413, 'invalid_request_error', 'file_too_large',
        `文件 ${info.size} 字节，超过 files.maxBytes=${this.#maxBytes}`, { size: info.size, limit: this.#maxBytes })
    }
    // realpath 会把符号链接解开：这是护栏的最后一道自证，越界由调用方复核。
    const canonical = await realpath(target).catch(() => target)
    return { absolutePath: canonical, size: info.size, version: `${info.size}-${Math.round(info.mtimeMs)}` }
  }

  async list(dir, limit) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      throw wrapFsError(error, dir)
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const out = []
    for (const entry of entries) {
      if (out.length >= limit) break
      const type = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'
      let size
      if (type === 'file') {
        size = await stat(resolve(dir, entry.name)).then(info => info.size).catch(() => undefined)
      }
      out.push({ name: entry.name, type, ...(size === undefined ? {} : { size }) })
    }
    return { entries: out, truncated: entries.length > out.length }
  }

  async *chunks(target, { offset = 0, length } = {}) {
    const end = length === undefined ? undefined : offset + length - 1
    const stream = createReadStream(target, { start: offset, ...(end === undefined ? {} : { end }) })
    for await (const chunk of stream) yield chunk
  }
}

/**
 * 宿主 `workspaceFiles` reader。
 *
 * 读面接受「绝对路径或相对 workspaceRoot 的路径」，且**不做工作区包含判定**——
 * 包含判定在网关侧（FileGuard），这里只负责取字节。
 * `readBytes` 的窗口上限是 `maxBytes`（默认 2 MiB），所以大文件按窗口翻页。
 *
 * 线上参数是 `workspaceFileScopeId`（Typert 的 lookup 参数）：Host 会把它解析成
 * `{sessionId, workspaceRoot}`。进程内调用没有这层解析，所以把 workspaceRoot 走
 * 一个带外选项交给 Cordis 适配层——多出来的字段会被 HTTP 适配层忽略。
 */
export class DshFileReader {
  #client
  #maxBytes
  #log
  #window = DSH_WINDOW_BYTES

  constructor({ client, maxBytes, log }) {
    this.#client = client
    this.#maxBytes = maxBytes
    this.#log = log ?? (() => {})
  }

  async stat({ sessionId, cwd, path }) {
    let value
    try {
      value = await this.#client.call('workspaceFiles/stat', {
        workspaceFileScopeId: sessionId, path,
      }, { timeoutMs: 30_000, workspaceRoot: cwd })
    } catch (error) {
      throw wrapUpstreamFileError(error, path)
    }
    const size = typeof value?.bytes === 'number' ? value.bytes : undefined
    if (size !== undefined && size > this.#maxBytes) {
      throw new ApiError(413, 'invalid_request_error', 'file_too_large',
        `文件 ${size} 字节，超过 files.maxBytes=${this.#maxBytes}`, { size, limit: this.#maxBytes })
    }
    return {
      absolutePath: typeof value?.absolutePath === 'string' ? value.absolutePath : path,
      size,
      version: typeof value?.version === 'string' ? value.version : undefined,
    }
  }

  async list({ sessionId, cwd, path, limit }) {
    let value
    try {
      value = await this.#client.call('workspaceFiles/list', {
        workspaceFileScopeId: sessionId, path,
      }, { timeoutMs: 30_000, workspaceRoot: cwd })
    } catch (error) {
      throw wrapUpstreamFileError(error, path)
    }
    const entries = (value?.entries ?? []).slice(0, limit).map(entry => ({
      name: entry.name,
      type: entry.type,
      ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
    }))
    return {
      entries,
      truncated: value?.truncated === true || (value?.entries ?? []).length > entries.length,
    }
  }

  /** 翻页取字节：窗口大小自适应当前部署的 `maxBytes`，不会因为 2 MiB 写死而整段失败。 */
  async *chunks({ sessionId, cwd, path, offset = 0, length }) {
    let cursor = offset
    let remaining = length
    let window = Math.min(this.#window, Math.max(this.#maxBytes, 64 * 1024))
    while (remaining === undefined || remaining > 0) {
      const want = remaining === undefined ? window : Math.min(window, remaining)
      let value
      try {
        value = await this.#client.call('workspaceFiles/readBytes', {
          workspaceFileScopeId: sessionId, path, options: { range: { offset: cursor, length: want } },
        }, { timeoutMs: 60_000, workspaceRoot: cwd })
      } catch (error) {
        // 部署把 maxBytes 调小过：窗口退一半重试，别让整个下载失败。
        if (error?.code === 'workspace-file/too-large' && window > 4096) {
          window = Math.max(4096, Math.floor(window / 2))
          continue
        }
        throw wrapUpstreamFileError(error, path)
      }
      const data = value?.data
      if (data === undefined || data === null) {
        // 上游没给 data 就当成传输失败：静默返回空体会让调用方拿到一个"成功但没内容"的文件。
        this.#log('warn', 'files.readBytes.no-data', {
          path, fields: value && typeof value === 'object' ? Object.keys(value) : typeof value,
        })
        throw new ApiError(502, 'upstream_error', 'file_transfer_failed',
          `读取 ${path} 的字节失败：上游未返回 data`, { expected: want })
      }
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      if (bytes.length === 0) return
      yield bytes
      cursor += bytes.length
      if (remaining !== undefined) remaining -= bytes.length
      if (value?.eof === true) return
    }
  }
}

/** 上游明确表示「没有这个能力」时才降级；会话/路径类的业务错误说明服务是活的。 */
export function isFileSupportMissing(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === '') return /HTTP 40[45]/.test(String(error?.message ?? ''))
  if (code === 'dsh_service_missing' || code === 'unsupported_endpoint') return true
  return /^gateway\/(method-unavailable|definition-unavailable|lookup-unavailable)$/.test(code)
}

/**
 * 读面门面：对上层只暴露 `stat / list / chunks`，内部按 `files.reader` 选实现。
 *
 * `auto` 只探测一次：探测拿到的任何一个业务错误都说明 `workspaceFiles` 存在；
 * 只有「方法/服务不存在」才降级到本地 fs，并记住结论。
 */
export class FileService {
  #config
  #local
  #dsh
  #log
  #decision

  constructor({ config, client, log }) {
    this.#config = config
    this.#log = log ?? (() => {})
    this.#local = new LocalFileReader({ maxBytes: config.maxBytes })
    this.#dsh = new DshFileReader({ client, maxBytes: config.maxBytes, log: this.#log })
  }

  /** 当前生效的读面（未探测时为配置值）。 */
  get reader() {
    return this.#decision ?? this.#config.reader
  }

  async #pick(sessionId, cwd) {
    const configured = this.#config.reader
    if (configured === 'local') return 'local'
    if (configured === 'dsh') return 'dsh'
    if (this.#decision) return this.#decision
    if (!sessionId || !cwd) {
      this.#decision = 'local'
      this.#log('info', 'files.reader.decided', { reader: 'local', reason: 'no-session-scope' })
      return this.#decision
    }
    try {
      await this.#dsh.list({ sessionId, cwd, path: cwd, limit: 1 })
      this.#decision = 'dsh'
    } catch (error) {
      const missing = isFileSupportMissing(error)
      this.#decision = missing ? 'local' : 'dsh'
      this.#log('info', 'files.reader.decided', {
        reader: this.#decision, reason: missing ? 'workspaceFiles-unavailable' : 'probe-answered',
        code: error?.code, message: error?.message,
      })
    }
    return this.#decision
  }

  async stat({ sessionId, cwd, path }) {
    const reader = await this.#pick(sessionId, cwd)
    return reader === 'dsh' ? this.#dsh.stat({ sessionId, cwd, path }) : this.#local.stat(path)
  }

  async list({ sessionId, cwd, path, limit }) {
    const reader = await this.#pick(sessionId, cwd)
    return reader === 'dsh'
      ? this.#dsh.list({ sessionId, cwd, path, limit })
      : this.#local.list(path, limit)
  }

  async *chunks({ sessionId, cwd, path, offset, length }) {
    const reader = await this.#pick(sessionId, cwd)
    if (reader === 'dsh') {
      yield * this.#dsh.chunks({ sessionId, cwd, path, offset, length })
      return
    }
    yield * this.#local.chunks(path, { offset, length })
  }
}

/**
 * 下载链接签名器。
 *
 * 令牌是 `base64url(payload).base64url(hmac)`，payload 里带过期时间（秒）。
 * 用 HMAC 而不是把 payload 加密：里面只有会话 id、绝对路径和 key id，都不算秘密，
 * 需要的只是「不可伪造 + 不可延长」。
 */
export class DownloadSigner {
  #key

  /** @param {string|Buffer} secret */
  constructor(secret) {
    this.#key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8')
    if (this.#key.length === 0) throw new Error('DownloadSigner 需要非空密钥')
  }

  /**
   * @param {{s: string, p: string, k: string, n?: string}} payload 会话、绝对路径、key、文件名
   * @param {number} ttlMs
   * @returns {string}
   */
  sign(payload, ttlMs) {
    const body = { ...payload, e: Math.floor((Date.now() + ttlMs) / 1000) }
    const data = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
    const mac = createHmac('sha256', this.#key).update(data).digest('base64url')
    return `${data}.${mac}`
  }

  /**
   * @param {string} token
   * @returns {{s: string, p: string, k: string, n?: string, e: number}|undefined}
   */
  verify(token) {
    const raw = String(token ?? '')
    const index = raw.indexOf('.')
    if (index <= 0 || index === raw.length - 1) return undefined
    const data = raw.slice(0, index)
    const mac = raw.slice(index + 1)
    const expected = createHmac('sha256', this.#key).update(data).digest('base64url')
    const left = Buffer.from(mac, 'utf8')
    const right = Buffer.from(expected, 'utf8')
    if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined
    let body
    try {
      body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
    } catch {
      return undefined
    }
    if (!body || typeof body !== 'object') return undefined
    if (typeof body.e !== 'number' || body.e * 1000 <= Date.now()) return undefined
    if (typeof body.s !== 'string' || typeof body.p !== 'string' || typeof body.k !== 'string') return undefined
    return body
  }
}

/** 部署没配签名密钥时用它：进程级随机，重启作废（链接本来就是短期的）。 */
export function randomSigningSecret() {
  return randomBytes(32).toString('hex')
}

/**
 * RFC 6266 / 5987 的 Content-Disposition。
 * 同时给 ASCII 回退名和 UTF-8 编码名，中文文件名才不会在旧客户端上变成乱码。
 */
export function contentDisposition(name, { inline = false } = {}) {
  const type = inline ? 'inline' : 'attachment'
  const safe = basename(String(name ?? 'download')).replace(/[\r\n]/g, '')
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '')
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * 单段 Range 解析。多段或语法不认识时按整体返回（RFC 允许忽略 Range）。
 * @param {string|undefined} header
 * @param {number|undefined} size
 * @returns {{offset: number, length: number}|{invalid: true}|undefined}
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return undefined
  if (size === undefined) return undefined
  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true }
    end = Math.min(end, size - 1)
  }
  if (start >= size || start > end) return { invalid: true }
  return { offset: start, length: end - start + 1 }
}
