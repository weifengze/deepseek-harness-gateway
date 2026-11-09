#!/usr/bin/env node
/**
 * 文件能力的离线单测：不需要 DSH，也不需要网关在跑。
 *
 * 覆盖三块最容易出事的逻辑：
 *   1. 路径护栏（越界、`..`、盘符大小写、符号链接复核）；
 *   2. 签名下载链接（伪造、篡改、过期）；
 *   3. 产物识别（present 事件、写工具结果、去重与排序）。
 *
 * 用法：node scripts/test-files.mjs
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DownloadSigner, FileGuard, LocalFileReader, containsPath, contentDisposition, contentTypeFor,
  displayPathOf, isFileSupportMissing, parseRange, pathKey, toSlashes,
} from '../src/files.mjs'
import { DeliverableBag } from '../src/deliverables.mjs'

let failures = 0
let checks = 0

function check(name, ok, detail) {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

/** 断言抛出的是期望的 API 错误码（护栏的错误码就是对外契约，不能随手改）。 */
function throwsCode(fn, expected) {
  try {
    fn()
    return { ok: false, detail: '没有抛错' }
  } catch (error) {
    return { ok: error?.code === expected, detail: `${error?.code ?? error?.name}: ${error?.message}` }
  }
}

async function testPaths(root) {
  check('containsPath 同一目录', containsPath(root, root))
  check('containsPath 子目录', containsPath(root, join(root, 'a', 'b.txt')))
  check('containsPath 前缀相同的兄弟目录不算包含', !containsPath(join(root, 'a'), join(root, 'ab')))

  const guard = new FileGuard({ cwd: root })
  check('相对路径按 cwd 解析', guard.resolve('a/b.txt') === join(root, 'a', 'b.txt'), guard.resolve('a/b.txt'))
  check('cwd 内绝对路径放行', guard.resolve(join(root, 'report.docx')) === join(root, 'report.docx'))
  check('根目录 `.` 解析成 cwd', guard.resolve('.') === root)

  const escape = throwsCode(() => guard.resolve('../../etc/passwd'), 'file_outside_scope')
  check('`..` 逃逸被拒', escape.ok, escape.detail)

  const absolute = throwsCode(() => guard.resolve('/etc/passwd'), 'file_outside_scope')
  check('绝对路径越界被拒', absolute.ok, absolute.detail)

  const nul = throwsCode(() => guard.resolve('a\0b'), 'invalid_path')
  check('NUL 路径被拒', nul.ok, nul.detail)

  const empty = throwsCode(() => guard.resolve('   '), 'invalid_path')
  check('空路径被拒', empty.ok, empty.detail)

  const noCwd = throwsCode(() => new FileGuard({}).resolve('a.txt'), 'session_cwd_unknown')
  check('无 cwd 且给相对路径被拒', noCwd.ok, noCwd.detail)

  const extra = new FileGuard({ cwd: root, roots: [join(root, 'out')] })
  check('files.roots 内的绝对路径放行', extra.resolve(join(root, 'out', 'x.txt')).endsWith('x.txt'))

  check('display 给出 cwd 相对路径', guard.display(join(root, 'a', 'b.txt')) === 'a/b.txt', guard.display(join(root, 'a', 'b.txt')))
  check('display 对 cwd 自身给 .', guard.display(root) === '.')
  const outsidePath = toSlashes(resolve(join(root, '..', 'other')))
  check('displayPathOf 对 cwd 外给绝对路径', displayPathOf(root, join(root, '..', 'other')) === outsidePath)

  // 符号链接：词法上在 cwd 内，真实路径在 cwd 外，必须由 canonical 复核拦住。
  const outside = join(root, '..', `${pathKey(root).split('/').pop()}-outside`)
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.txt'), 'top secret')
  const reader = new LocalFileReader({ maxBytes: 1024 * 1024 })

  const link = join(root, 'link.txt')
  let viaFileLink = await symlink(join(outside, 'secret.txt'), link).then(() => true).catch(() => false)
  let probe = link
  if (!viaFileLink) {
    // Windows 上文件符号链接要管理员或开发者模式；目录 junction 不需要。
    const junction = join(root, 'link-dir')
    viaFileLink = await symlink(outside, junction, 'junction').then(() => true).catch(() => false)
    probe = join(junction, 'secret.txt')
  }
  if (!viaFileLink) {
    console.log('SKIP  符号链接逃逸  Windows 不允许非特权创建链接')
  } else {
    const info = await reader.stat(probe)
    check('符号链接的 canonical 路径被识别为越界', !guard.contains(info.absolutePath), info.absolutePath)
    check('词法路径本身仍在 cwd 内', guard.contains(probe))
  }
  await rm(outside, { recursive: true, force: true })
}

function testMisc() {
  check('docx 的 content-type',
    contentTypeFor('报告.docx') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  check('未知扩展名回退 octet-stream', contentTypeFor('blob.xyz') === 'application/octet-stream')

  const ascii = contentDisposition('report.docx')
  check('Content-Disposition 附件形式', ascii.startsWith('attachment;'), ascii)
  const chinese = contentDisposition('会议预案.docx')
  check('中文文件名给出 filename* 编码', chinese.includes("filename*=UTF-8''%E4%BC%9A"), chinese)
  check('inline 形式', contentDisposition('a.png', { inline: true }).startsWith('inline;'))
  check('文件名里的引号被剥掉', contentDisposition('a"b.txt').includes('filename="ab.txt"'))

  check('Range 正常段', JSON.stringify(parseRange('bytes=10-19', 100)) === '{"offset":10,"length":10}')
  check('Range 后缀段', JSON.stringify(parseRange('bytes=-10', 100)) === '{"offset":90,"length":10}')
  check('Range 开区间', JSON.stringify(parseRange('bytes=90-', 100)) === '{"offset":90,"length":10}')
  check('Range 越界判无效', parseRange('bytes=200-300', 100)?.invalid === true)
  check('Range 语法不认识就忽略', parseRange('bytes=abc', 100) === undefined)
  check('无 Range 头返回 undefined', parseRange(undefined, 100) === undefined)
}

function testSigner() {
  const signer = new DownloadSigner('test-secret-at-least-16-chars')
  const token = signer.sign({ s: 'session-1', p: '/tmp/a.docx', k: 'dev' }, 60_000)
  const payload = signer.verify(token)
  check('签名可验证', payload?.s === 'session-1' && payload?.p === '/tmp/a.docx')
  check('篡改载荷后验签失败', signer.verify(`x${token}`) === undefined)
  check('换密钥后验签失败', new DownloadSigner('another-secret-16chars').verify(token) === undefined)

  const expired = signer.sign({ s: 's', p: '/p', k: 'k' }, -1000)
  check('过期链接失效', signer.verify(expired) === undefined)
  check('乱码令牌不抛异常', signer.verify('not-a-token') === undefined)
  check('空令牌不抛异常', signer.verify(undefined) === undefined)
}

async function testLocalReader(root) {
  const reader = new LocalFileReader({ maxBytes: 1024 * 1024 })
  const file = join(root, 'hello.txt')
  await writeFile(file, '0123456789abcdef')

  const info = await reader.stat(file)
  check('stat 报出大小与版本', info.size === 16 && typeof info.version === 'string', `${info.size}/${info.version}`)

  const dirName = join(root, 'listing')
  await mkdir(dirName, { recursive: true })
  await writeFile(join(dirName, 'b.txt'), 'b')
  await mkdir(join(dirName, 'sub'))
  const listing = await reader.list(dirName, 10)
  check('list 按名字排序并区分类型',
    listing.entries.map(entry => entry.name).join(',') === 'b.txt,sub'
      && listing.entries[1].type === 'directory',
    listing.entries.map(entry => `${entry.name}:${entry.type}`).join(','))
  check('list 截断标记', (await reader.list(dirName, 1)).truncated === true)

  const chunks = []
  for await (const chunk of reader.chunks(file, { offset: 4, length: 6 })) chunks.push(chunk)
  check('按窗口读字节', Buffer.concat(chunks).toString() === '456789', Buffer.concat(chunks).toString())

  const missing = await reader.stat(join(root, 'nope.txt')).then(() => undefined).catch(error => error)
  check('不存在的文件是 404', missing?.code === 'file_not_found', String(missing?.code))

  const big = new LocalFileReader({ maxBytes: 4 })
  const tooLarge = await big.stat(file).then(() => undefined).catch(error => error)
  check('超过 maxBytes 是 413', tooLarge?.code === 'file_too_large', String(tooLarge?.code))
}

function testDeliverables() {
  const bag = new DeliverableBag({ includeWritten: true })
  bag.observe({
    type: 'tool/call',
    data: { callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: 'out/a.md', content: 'x' }) },
  })
  bag.observe({
    type: 'tool/result',
    data: { message: { toolCallId: 'call-1' }, meta: { path: '/abs/out/a.md' } },
  })
  bag.observe({
    type: 'tool/call',
    data: { callId: 'call-2', name: 'read', arguments: JSON.stringify({ file_path: 'out/b.md' }) },
  })
  bag.observe({ type: 'tool/result', data: { message: { toolCallId: 'call-2' } } })
  bag.observe({
    type: 'tool/call',
    data: { callId: 'call-3', name: 'write', arguments: JSON.stringify({ file_path: 'out/fail.md' }) },
  })
  bag.observe({ type: 'tool/result', data: { message: { toolCallId: 'call-3', isError: true } } })
  bag.observe({ type: 'tool/call', data: { callId: 'call-4', name: 'write', arguments: '{bad json' } })
  bag.observe({ type: 'tool/result', data: { message: { toolCallId: 'call-4' } } })
  bag.observe({
    type: 'deliverables/presented',
    data: { files: [{ path: '/abs/out/report.docx', description: '会议预案' }] },
  })
  // 同一文件既写过又交付：只留一条，且必须是 present。
  bag.observe({
    type: 'deliverables/presented',
    data: { files: [{ path: '/abs/out/a.md', description: '附录' }] },
  })

  const list = bag.list()
  check('产物去重', list.length === 2, list.map(item => item.path).join(','))
  check('present 排在最前', list[0].source === 'present' && list[0].path === '/abs/out/report.docx')
  check('重复文件被 present 覆盖', list[1].source === 'present' && list[1].description === '附录')
  check('非写工具与失败结果被忽略', !list.some(item => item.path.includes('b.md') || item.path.includes('fail.md')))

  const noWritten = new DeliverableBag({ includeWritten: false })
  noWritten.observe({
    type: 'tool/call',
    data: { callId: 'c', name: 'write', arguments: JSON.stringify({ file_path: 'x.md' }) },
  })
  noWritten.observe({ type: 'tool/result', data: { message: { toolCallId: 'c' }, meta: { path: '/x.md' } } })
  check('includeWritten=false 时不收集写工具结果', noWritten.list().length === 0)
}

function testFallbackDetection() {
  check('服务缺失判定', isFileSupportMissing({ code: 'dsh_service_missing' }))
  check('接口未映射判定', isFileSupportMissing({ code: 'unsupported_endpoint' }))
  check('HTTP 404 判定', isFileSupportMissing(new Error('调用 workspaceFiles/list 返回 HTTP 404: not found')))
  check('业务错误不算缺失', !isFileSupportMissing({ code: 'workspace-file/not-found' }))
  check('会话查不到不算缺失', !isFileSupportMissing({ code: 'gateway/lookup-not-found' }))
}

/**
 * 插件（进程内）形态的参数装配。
 *
 * 这是唯一一处「线上参数名」与「服务形参」不一致的地方：线上是 `workspaceFileScopeId`
 * （Typert lookup），服务收的是 `{sessionId, workspaceRoot}`。装错不会报错，只会读到
 * 错的目录，所以单独立个用例钉死它。
 */
async function testCordisMapping() {
  const { CordisDshClient } = await import('../src/cordis-client.mjs')
  const seen = []
  const service = {
    async stat(scope, path) {
      seen.push({ method: 'stat', scope, path })
      return { absolutePath: path, version: 'v1', bytes: 7 }
    },
    async list(scope, path) {
      seen.push({ method: 'list', scope, path })
      return { path: '', entries: [{ name: 'a.txt', type: 'file', size: 7 }], truncated: false }
    },
    async readBytes(scope, path, options) {
      seen.push({ method: 'readBytes', scope, path, options })
      return { absolutePath: path, version: 'v1', bytes: 2, offset: 0, data: new Uint8Array([1, 2]), eof: true }
    },
  }
  const client = new CordisDshClient({ get: name => (name === 'workspaceFiles' ? service : undefined) })

  const info = await client.call(
    'workspaceFiles/stat',
    { workspaceFileScopeId: 'session-9', path: '/ws/a.txt' },
    { workspaceRoot: '/ws' },
  )
  check('插件模式 stat 拼出 WorkspaceFileScope',
    info?.bytes === 7 && info?.absolutePath === '/ws/a.txt'
      && seen[0].scope.sessionId === 'session-9' && seen[0].scope.workspaceRoot === '/ws',
    JSON.stringify(seen[0]?.scope))

  const listing = await client.call(
    'workspaceFiles/list',
    { workspaceFileScopeId: 'session-9', path: '/ws' },
    { workspaceRoot: '/ws' },
  )
  check('插件模式 list 透传路径', listing?.entries?.[0]?.name === 'a.txt' && seen[1].path === '/ws')

  const bytes = await client.call('workspaceFiles/readBytes', {
    workspaceFileScopeId: 'session-9', path: '/ws/a.txt', options: { range: { offset: 0, length: 2 } },
  }, { workspaceRoot: '/ws' })
  check('插件模式 readBytes 传 options 且回 Uint8Array',
    seen[2]?.options?.range?.length === 2 && bytes?.data instanceof Uint8Array && bytes.data[0] === 1,
    JSON.stringify(seen[2]?.options))
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gw-files-'))
  const workspace = join(root, 'ws')
  await mkdir(join(workspace, 'a'), { recursive: true })
  await writeFile(join(workspace, 'a', 'b.txt'), 'x')
  try {
    await testPaths(workspace)
    testMisc()
    testSigner()
    await testLocalReader(workspace)
    testDeliverables()
    testFallbackDetection()
    await testCordisMapping()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  console.log(failures === 0 ? `\n${checks} 项全部通过` : `\n${failures}/${checks} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('单测异常:', error)
  process.exit(1)
})
