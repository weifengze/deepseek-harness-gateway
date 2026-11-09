/**
 * 提问中枢的离线单测：不碰 DSH，只验证「表单」这一层的边界。
 *
 * 重点不是 happy path，而是那些会让模型收到畸形 tool result 的路径：
 * 少答一个、重复答、选了不存在的选项、单选选了多个、答案来晚了。
 */

import { strict as assert } from 'node:assert'
import { QuestionBroker, normalizeAnswers } from '../src/questions.mjs'

let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

/** 期待抛 ApiError 且 code 匹配。 */
function throwsCode(fn, code, name) {
  try {
    fn()
    check(name, false, '没有抛错')
  } catch (error) {
    check(name, error?.code === code, `code=${error?.code} status=${error?.status}`)
  }
}

const questions = [
  {
    id: 'q1',
    question: '选 A 还是 B',
    header: '确认',
    options: [{ label: 'A', description: '选 A' }, { label: 'B', description: '选 B' }],
  },
  { id: 'q2', question: '补充说明', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
]

function testNormalize() {
  const ok = normalizeAnswers(questions, [
    { id: 'q1', selected: ['B'] },
    { id: 'q2', selected: ['X', 'Y'], custom: '补充' },
  ])
  check('合法答案逐项保留', ok.answers.length === 2
    && ok.answers[0].selected[0] === 'B' && ok.answers[1].custom === '补充')

  const skipped = normalizeAnswers(questions, [
    { id: 'q1', selected: [] },
    { id: 'q2', selected: [] },
  ])
  check('空选择等于跳过（DSH 认可的形状）', skipped.answers.every(item => item.selected.length === 0))

  throwsCode(() => normalizeAnswers(questions, [{ id: 'q1', selected: ['A'] }]),
    'incomplete_answers', '少答一个问题被拒')
  throwsCode(() => normalizeAnswers(questions, [
    { id: 'q1', selected: ['A'] }, { id: 'q1', selected: ['B'] },
  ]), 'duplicate_answer', '同一个问题答两次被拒')
  throwsCode(() => normalizeAnswers(questions, [
    { id: 'q9', selected: ['A'] }, { id: 'q2', selected: [] },
  ]), 'unknown_question', '未知问题 id 被拒')
  throwsCode(() => normalizeAnswers(questions, [
    { id: 'q1', selected: ['C'] }, { id: 'q2', selected: [] },
  ]), 'unknown_option', '不存在的选项被拒')
  throwsCode(() => normalizeAnswers(questions, [
    { id: 'q1', selected: ['A', 'B'] }, { id: 'q2', selected: [] },
  ]), 'too_many_selected', '单选多选被拒')
  throwsCode(() => normalizeAnswers(questions, 'nope'), 'invalid_answers', '非数组被拒')
}

async function testBroker() {
  const events = []
  const broker = new QuestionBroker({ waitMs: 200 })
  const off = broker.subscribe(event => events.push(event.kind))
  check('waitMs 透出', broker.waitMs === 200)

  const first = broker.open({ sessionId: 'session-1', questions, eventId: 'evt-1' })
  check('登记后出现在列表里', broker.list('session-1').length === 1
    && broker.list('session-2').length === 0)
  const row = broker.list('session-1')[0]
  check('投影字段是下划线风格', row.id.startsWith('q_') && row.session_id === 'session-1'
    && row.questions[0].multi_select === undefined && row.questions[1].multi_select === true)

  const answered = broker.answer(first.id, [
    { id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['Y'] },
  ], 'session-1')
  const value = await first.promise
  check('提交答案后 promise 解析为答案批量', value?.answers?.[0]?.selected?.[0] === 'A'
    && answered.session_id === 'session-1')
  check('提交后被移出列表', broker.list('session-1').length === 0)

  // 重复提交必须失败，否则调用方会以为还能改。
  throwsCode(() => broker.answer(first.id, [
    { id: 'q1', selected: ['B'] }, { id: 'q2', selected: [] },
  ]), 'question_not_pending', '已经答过的问题再答被拒')

  // 跨会话提交：与「不存在」同码，避免探测别人有没有表单。
  const second = broker.open({ sessionId: 'session-1', questions, eventId: 'evt-2' })
  throwsCode(() => broker.answer(second.id, [
    { id: 'q1', selected: ['A'] }, { id: 'q2', selected: [] },
  ], 'session-2'), 'question_not_pending', '跨会话提交被拒')
  broker.decline(second.id)
  check('放弃后 promise 解析为 null', await second.promise === null)

  // 超时：不发答案，到点必须自己放行，否则调用方一直挂着。
  const third = broker.open({ sessionId: 'session-3', questions })
  const startedAt = Date.now()
  const timedOut = await third.promise
  check('超时自动放行', timedOut === null && Date.now() - startedAt >= 190,
    `waited=${Date.now() - startedAt}ms`)

  // Host 侧取消：按事件 id 对账，promise 同样要落地。
  const fourth = broker.open({ sessionId: 'session-4', questions, eventId: 'evt-4' })
  broker.withdraw('evt-4')
  check('事件撤销后 promise 落地', await fourth.promise === null)

  check('订阅收到 open/close', events.filter(kind => kind === 'open').length >= 3
    && events.filter(kind => kind === 'close').length >= 3)
  off()

  // 关闭网关时不能留悬挂 promise。
  const fifth = broker.open({ sessionId: 'session-5', questions })
  broker.close()
  check('关闭后未答问题立即放行', await fifth.promise === null)
  const afterClose = broker.open({ sessionId: 'session-6', questions })
  check('关闭后不再登记新问题', await afterClose.promise === null && broker.size === 0)
}

async function main() {
  testNormalize()
  await testBroker()
  console.log(`\n${passed} 项通过${failed > 0 ? `，${failed} 项失败` : ''}`)
  if (failed > 0) process.exitCode = 1
}

await main()
assert.ok(true)
