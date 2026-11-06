/**
 * 可选：由网关自己拉起 `dsh --profile web`。
 *
 * 存在的唯一理由：DSH 的 /connect 令牌是**每进程随机**的，只打印在启动日志里，
 * 没有环境变量或配置文件入口。单机部署时让网关托管进程并解析那行 URL，
 * 比人工复制 token 可靠得多（重启即失效是必然的，网关会自动重新握手）。
 */

import { spawn } from 'node:child_process'

const URL_LINE = /dsh web:\s+(https?:\/\/\S+)/

/**
 * 启动 dsh web 并等待它打印带 token 的 URL。
 * @param {object} spec
 * @param {string} spec.command 可执行文件，如 node 或 dsh
 * @param {string[]} spec.args 参数，须包含 --profile web 与 --no-open
 * @param {string} [spec.cwd]
 * @param {Record<string,string>} [spec.env]
 * @param {number} spec.startupTimeoutMs
 * @param {(level: string, message: string, extra?: object) => void} log
 * @returns {Promise<{baseUrl: string, token: string, stop: () => Promise<void>}>}
 */
export function spawnDshWeb(spec, log) {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void stop()
      reject(new Error(`等待 dsh web 启动超时（${spec.startupTimeoutMs}ms）`))
    }, spec.startupTimeoutMs)

    const onData = (chunk) => {
      const text = chunk.toString()
      buffer += text
      // 启动诊断走 stderr，原样透传，便于定位 profile 激活失败。
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) log('debug', `dsh: ${line}`)
      }
      const match = URL_LINE.exec(buffer)
      if (!match || settled) return
      settled = true
      clearTimeout(timer)
      const url = new URL(match[1])
      const token = url.searchParams.get('token')
      url.searchParams.delete('token')
      url.search = ''
      resolve({ baseUrl: url.toString().replace(/\/+$/, ''), token: token ?? '', stop })
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      spec.onExit?.(code)
      if (settled) {
        log('warn', `dsh: 子进程退出，code=${code}`)
        return
      }
      settled = true
      clearTimeout(timer)
      reject(new Error(`dsh web 在打印 URL 前退出，code=${code}`))
    })
  })
}
