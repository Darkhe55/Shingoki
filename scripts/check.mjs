/**
 * 信号旗题库审计（node 端，直接跑游戏规则）
 *
 * 对 src/game/puzzles-data.ts 里的每一题：
 *  1. 题面/参考解编码合法；
 *  2. 参考解通过完整校验（单一闭环 + 圆方向 + 数字）；
 *  3. 解唯一（求解器最多找 2 个解，必须只有 1 个）；
 *  4. 逻辑解题计划能纯规则推完（saturated 且终态通过校验）；
 *  5. 自定义题编解码 round-trip（把内置题当作自定义题存取一次）。
 *
 * 另外检查题库至少有 6 题，且 id 唯一。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { decodePuzzle } from '../src/game/puzzles.ts'
import { checkSolution, ON, OFF, valuesFromState } from '../src/game/rules.ts'
import { countSolutions } from '../src/game/solver.ts'
import { planLogicSolve } from '../src/game/logic.ts'
import { createEmptyState, deserializeState, serializeState, stateFromSolution } from '../src/game/state.ts'
import {
  circleColor,
  circleNumber,
  decodeCircles,
  decodeSolution,
  encodeCircles,
  horizontalEdgeIndex,
  layoutFor,
  makeCircle,
  verticalEdgeIndex,
} from '../src/game/types.ts'

const DATA_FILE = path.resolve('src/game/puzzles-data.ts')
const text = readFileSync(DATA_FILE, 'utf8')

const entries = []
const re =
  /\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*width:\s*(\d+),\s*height:\s*(\d+),\s*difficulty:\s*"([^"]+)",\s*series:\s*"([^"]+)",\s*board:\s*"([^"]*)",\s*solution:\s*"([^"]*)"\s*\}/g
let m
while ((m = re.exec(text)) !== null) {
  entries.push({
    id: m[1],
    name: m[2],
    width: Number(m[3]),
    height: Number(m[4]),
    difficulty: m[5],
    series: m[6],
    board: m[7],
    solution: m[8],
  })
}

let errors = 0
let warnings = 0
const ids = new Set()

function fail(msg) {
  console.error(`[check] ✗ ${msg}`)
  errors++
}

function warn(msg) {
  console.warn(`[check] ! ${msg}`)
  warnings++
}

for (const e of entries) {
  if (ids.has(e.id)) fail(`重复 id：${e.id}`)
  ids.add(e.id)

  const puzzle = decodePuzzle(e)
  if (!puzzle) {
    fail(`${e.id} 题面编码非法`)
    continue
  }
  if (!['easy', 'medium', 'hard', 'custom'].includes(e.difficulty)) {
    fail(`${e.id} 难度非法：${e.difficulty}`)
    continue
  }
  const layout = layoutFor(puzzle)
  const circleCount = puzzle.circles.filter((c) => c !== 0).length
  if (circleCount < 3) fail(`${e.id} 只有 ${circleCount} 个圆，太少了`)

  // 参考解
  const solValues = decodeSolution(e.solution, layout.count)
  if (!solValues) {
    fail(`${e.id} 参考解编码非法（期望长度 ${layout.count}）`)
    continue
  }
  const refCheck = checkSolution(solValues.map((v) => (v ? 1 : 0)), puzzle)
  if (!refCheck.ok) {
    fail(
      `${e.id} 参考解不合法：bad=${refCheck.badCells.length} orientation=${refCheck.badOrientation.length} number=${refCheck.badNumber.length} components=${refCheck.componentCount}`,
    )
    continue
  }

  // 唯一解
  const counted = countSolutions(puzzle, 2, 500_000, 15_000)
  if (counted.timedOut) {
    warn(`${e.id} 唯一解检查超时（${counted.nodes} 节点）`)
  } else if (counted.count !== 1) {
    fail(`${e.id} 解不唯一：找到 ${counted.count} 个`)
    continue
  }

  // 逻辑可推完
  const plan = planLogicSolve(puzzle, createEmptyState(puzzle))
  let logicOk = false
  if (plan.saturated && plan.finalState) {
    logicOk = checkSolution(valuesFromState(plan.finalState), puzzle).ok
  }
  if (!logicOk) {
    fail(`${e.id} 逻辑解题未能纯规则推完（saturated=${plan.saturated}，帧=${plan.frames.length}）`)
    continue
  }

  // 自定义题编解码 round-trip（把内置题当自定义题存取一次）
  const roundBoard = encodeCircles(puzzle.circles)
  const backCircles = decodeCircles(roundBoard, puzzle.width * puzzle.height)
  const roundOk =
    !!backCircles && backCircles.every((v, i) => v === puzzle.circles[i])
  if (!roundOk) fail(`${e.id} 圆编码 round-trip 失败`)

  // 进度序列化 round-trip
  const solState = stateFromSolution(puzzle, e.solution)
  if (!solState) {
    fail(`${e.id} 无法由参考解构造状态`)
    continue
  }
  const restored = deserializeState(serializeState(solState))
  if (!restored || restored.edges.length !== layout.count || restored.edges.some((v, i) => v !== solState.edges[i])) {
    fail(`${e.id} 进度序列化 round-trip 失败`)
  }

  console.log(
    `[check] ✓ ${e.id.padEnd(22)} ${e.width}×${e.height} 圆 ${String(circleCount).padStart(2)} 个 · 解唯一 · 逻辑纯推 ${String(plan.frames.length).padStart(4)} 帧 / ${counted.nodes} 节点`,
  )
}

/* ── 圆编码扩展自检：旧紧凑格式逐字节兼容 + 0..99 两位数字往返 ── */
{
  const checks = [
    [
      'makeCircle 0..9 保持旧紧凑编码',
      makeCircle(1, 0) === 10 && makeCircle(1, 9) === 19 && makeCircle(2, 5) === 25,
    ],
    [
      'makeCircle 10..99 使用扩展编码',
      makeCircle(1, 10) === 110 && makeCircle(2, 14) === 214 && makeCircle(1, 99) === 199 && makeCircle(2, 99) === 299,
    ],
    [
      'circleColor / circleNumber 识别扩展编码',
      circleColor(114) === 1 && circleNumber(114) === 14 && circleColor(225) === 2 && circleNumber(225) === 25,
    ],
    ['旧紧凑 board 编码逐字节稳定', encodeCircles([0, 10, 19, 20, 29]) === '.ajkt'],
    [
      '旧紧凑 board 解码不变',
      JSON.stringify(decodeCircles('.ajkt', 5)) === JSON.stringify([0, 10, 19, 20, 29]),
    ],
  ]
  const wide = [0, makeCircle(1, 10), makeCircle(2, 25), makeCircle(1, 9), makeCircle(2, 14)]
  const wideBoard = encodeCircles(wide)
  checks.push(['含 ≥10 数字时切换宽格式（每格 2 字符）', wideBoard.length === wide.length * 2])
  const wideBack = decodeCircles(wideBoard, wide.length)
  checks.push([
    '宽格式 board 编解码往返',
    !!wideBack && wideBack.every((v, i) => v === wide[i]),
  ])
  checks.push([
    'board 长度不匹配时解码失败（不误判格式）',
    decodeCircles(wideBoard.slice(1), wide.length) === null,
  ])
  for (const [name, ok] of checks) {
    if (!ok) fail(`圆编码自检失败：${name}`)
  }
  if (checks.every(([, ok]) => ok)) {
    console.log('[check] ✓ 圆编码扩展自检：0..9 旧编码逐字节兼容，10..99 扩展编码往返正常')
  }
}

/* ── 两位数字规则/求解自检：2×15 矩形回路，黑圆 15 / 白圆 14 都走扩展编码 ── */
{
  const w = 15
  const h = 2
  const circles = new Array(w * h).fill(0)
  const at = (x, y) => y * w + x
  for (const [x, y] of [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ]) {
    circles[at(x, y)] = makeCircle(1, 15)
  }
  circles[at(7, 0)] = makeCircle(2, 14)
  circles[at(7, 1)] = makeCircle(2, 14)
  const puzzle = {
    id: 'selftest-2x15',
    name: '两位数字自检',
    width: w,
    height: h,
    difficulty: 'hard',
    circles,
  }
  const layout = layoutFor(puzzle)
  const values = new Array(layout.count).fill(OFF)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) values[horizontalEdgeIndex(w, x, y)] = ON
  }
  for (let y = 0; y < h - 1; y++) {
    values[verticalEdgeIndex(w, h, 0, y)] = ON
    values[verticalEdgeIndex(w, h, w - 1, y)] = ON
  }
  const refCheck = checkSolution(values, puzzle)
  if (!refCheck.ok || refCheck.badNumber.length) {
    fail(`两位数字规则自检失败：badNumber=${JSON.stringify(refCheck.badNumber)}`)
  }
  const out = countSolutions(puzzle, 2, 400_000, 15_000)
  const solverOk = out.count === 1 && !!out.first && checkSolution(out.first, puzzle).ok
  if (!solverOk) fail(`两位数字求解自检失败：count=${out.count} timedOut=${out.timedOut}`)
  if (refCheck.ok && solverOk) {
    console.log('[check] ✓ 两位数字自检：黑圆 15 / 白圆 14 校验通过，求解器找到唯一解')
  }
}

console.log(`[check] 共 ${entries.length} 题，错误 ${errors}，警告 ${warnings}`)
if (entries.length < 6) {
  console.error(`[check] 题库只有 ${entries.length} 题，至少需要 6 道内置题`)
  errors++
}
if (entries.length === 0) console.warn('[check] 题库为空，请先运行 npm run gen。')
if (errors > 0) process.exitCode = 1
