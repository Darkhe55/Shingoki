/**
 * 信号旗 —— 题库生成器（npm run gen）
 *
 * 思路：
 *  1. 在「对偶网格」上随机长出一块无洞、无捏合的连通区域（多联骨牌）；
 *  2. 它的边界就是格心之间的单一闭环；
 *  3. 从边界格里随机挑一些作为圆：拐角格 → 黑圆，直行格 → 白圆，数字由回路算出；
 *  4. 逐步加线索，直到「解唯一 + 纯规则可推完」，输出题面与参考解。
 */

import type { Difficulty } from '../core/types.ts'
import { planLogicSolve } from './logic.ts'
import { checkSolution, ON, OFF, valuesFromState } from './rules.ts'
import { countSolutions } from './solver.ts'
import { createEmptyState } from './state.ts'
import {
  asShingokiState,
  encodeCircles,
  encodeSolution,
  horizontalEdgeIndex,
  layoutOf,
  verticalEdgeIndex,
  type ShingokiPuzzle,
} from './types.ts'

/* ────────────────────────── 随机数 ────────────────────────── */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/* ────────────────────────── 对偶网格区域 ────────────────────────── */

function at(mask: Uint8Array, dw: number, dh: number, i: number, j: number): boolean {
  if (i < 0 || j < 0 || i >= dw || j >= dh) return false
  return mask[j * dw + i] === 1
}

/** 2×2 对角接触会形成「捏合」，边界会出现两个闭环共享格心 */
function hasPinch(mask: Uint8Array, dw: number, dh: number): boolean {
  for (let j = 0; j + 1 < dh; j++) {
    for (let i = 0; i + 1 < dw; i++) {
      const a = at(mask, dw, dh, i, j)
      const b = at(mask, dw, dh, i + 1, j)
      const c = at(mask, dw, dh, i, j + 1)
      const d = at(mask, dw, dh, i + 1, j + 1)
      if (a && d && !b && !c) return true
      if (b && c && !a && !d) return true
    }
  }
  return false
}

/** 空白处是否被围成洞（洞会让边界变成多条环） */
function hasHole(mask: Uint8Array, dw: number, dh: number): boolean {
  const seen = new Uint8Array(dw * dh)
  const stack: number[] = []
  for (let j = 0; j < dh; j++) {
    for (let i = 0; i < dw; i++) {
      if (i !== 0 && j !== 0 && i !== dw - 1 && j !== dh - 1) continue
      const k = j * dw + i
      if (mask[k] || seen[k]) continue
      seen[k] = 1
      stack.push(k)
    }
  }
  while (stack.length) {
    const k = stack.pop()!
    const i = k % dw
    const j = (k / dw) | 0
    const nbrs = [
      [i - 1, j],
      [i + 1, j],
      [i, j - 1],
      [i, j + 1],
    ]
    for (const [ni, nj] of nbrs) {
      if (ni < 0 || nj < 0 || ni >= dw || nj >= dh) continue
      const nk = nj * dw + ni
      if (mask[nk] || seen[nk]) continue
      seen[nk] = 1
      stack.push(nk)
    }
  }
  for (let k = 0; k < mask.length; k++) if (!mask[k] && !seen[k]) return true
  return false
}

function growRegion(
  dw: number,
  dh: number,
  target: number,
  rng: () => number,
): Uint8Array | null {
  const mask = new Uint8Array(dw * dh)
  mask[Math.floor(rng() * dw * dh)] = 1
  let size = 1
  while (size < target) {
    const candidates: number[] = []
    for (let j = 0; j < dh; j++) {
      for (let i = 0; i < dw; i++) {
        const k = j * dw + i
        if (mask[k]) continue
        if (
          !at(mask, dw, dh, i - 1, j) &&
          !at(mask, dw, dh, i + 1, j) &&
          !at(mask, dw, dh, i, j - 1) &&
          !at(mask, dw, dh, i, j + 1)
        ) {
          continue
        }
        candidates.push(k)
      }
    }
    if (!candidates.length) break
    shuffle(candidates, rng)
    let added = false
    for (const k of candidates) {
      mask[k] = 1
      if (!hasPinch(mask, dw, dh) && !hasHole(mask, dw, dh)) {
        size++
        added = true
        break
      }
      mask[k] = 0
    }
    if (!added) break
  }
  return size >= Math.max(6, Math.floor(target * 0.7)) ? mask : null
}

/* ────────────────────────── 区域边界 → 回路 ────────────────────────── */

function boundaryEdges(
  mask: Uint8Array,
  dw: number,
  dh: number,
  w: number,
  h: number,
): Uint8Array | null {
  const layout = layoutOf(w, h)
  const on = new Uint8Array(layout.count)
  for (let j = 0; j < dh; j++) {
    for (let i = 0; i < dw; i++) {
      if (!mask[j * dw + i]) continue
      if (!at(mask, dw, dh, i, j - 1)) on[horizontalEdgeIndex(w, i, j)] = 1
      if (!at(mask, dw, dh, i, j + 1)) on[horizontalEdgeIndex(w, i, j + 1)] = 1
      if (!at(mask, dw, dh, i - 1, j)) on[verticalEdgeIndex(w, h, i, j)] = 1
      if (!at(mask, dw, dh, i + 1, j)) on[verticalEdgeIndex(w, h, i + 1, j)] = 1
    }
  }
  // 每个格心度必须是 0 或 2
  for (let cell = 0; cell < w * h; cell++) {
    let deg = 0
    for (let d = 0; d < 4; d++) {
      const e = layout.cellIncident[cell * 4 + d]!
      if (e >= 0 && on[e]) deg++
    }
    if (deg !== 0 && deg !== 2) return null
  }
  // 必须恰好一个闭环
  const seen = new Uint8Array(w * h)
  let components = 0
  for (let start = 0; start < w * h; start++) {
    if (seen[start]) continue
    let has = false
    for (let d = 0; d < 4; d++) {
      const e = layout.cellIncident[start * 4 + d]!
      if (e >= 0 && on[e]) has = true
    }
    if (!has) continue
    components++
    seen[start] = 1
    const stack = [start]
    while (stack.length) {
      const cell = stack.pop()!
      for (let d = 0; d < 4; d++) {
        const e = layout.cellIncident[cell * 4 + d]!
        if (e < 0 || !on[e]) continue
        const other = layout.edgeCells[e * 2] === cell ? layout.edgeCells[e * 2 + 1]! : layout.edgeCells[e * 2]!
        if (!seen[other]) {
          seen[other] = 1
          stack.push(other)
        }
      }
    }
  }
  return components === 1 ? on : null
}

/* ────────────────────────── 由回路推圆 ────────────────────────── */

interface LoopInfo {
  turn: Uint8Array
  nums: Int32Array
  cells: number[]
}

function analyzeLoop(on: Uint8Array, w: number, h: number): LoopInfo | null {
  const layout = layoutOf(w, h)
  const cells: number[] = []
  for (let cell = 0; cell < w * h; cell++) {
    let deg = 0
    for (let d = 0; d < 4; d++) {
      const e = layout.cellIncident[cell * 4 + d]!
      if (e >= 0 && on[e]) deg++
    }
    if (deg === 2) cells.push(cell)
    else if (deg !== 0) return null
  }
  const turn = new Uint8Array(w * h)
  for (const cell of cells) {
    let hor = 0
    let ver = 0
    for (let d = 0; d < 4; d++) {
      const e = layout.cellIncident[cell * 4 + d]!
      if (e < 0 || !on[e]) continue
      if (d === 2 || d === 3) hor++
      else ver++
    }
    turn[cell] = hor === 1 && ver === 1 ? 1 : 0
  }
  const nums = new Int32Array(w * h).fill(-1)
  for (const cell of cells) {
    let sum = 0
    let bad = false
    for (let d = 0; d < 4; d++) {
      const e = layout.cellIncident[cell * 4 + d]!
      if (e < 0 || !on[e]) continue
      let cur = cell
      let dist = 0
      for (;;) {
        const x = cur % w
        const y = (cur / w) | 0
        let next = -1
        if (d === 0) {
          if (y === 0) break
          next = cur - w
        } else if (d === 1) {
          if (y === h - 1) break
          next = cur + w
        } else if (d === 2) {
          if (x === 0) break
          next = cur - 1
        } else {
          if (x === w - 1) break
          next = cur + 1
        }
        cur = next
        dist++
        if (turn[cur]) break
        if (dist > w * h) {
          bad = true
          break
        }
      }
      if (bad) break
      sum += dist
    }
    if (bad) return null
    nums[cell] = sum
  }
  return { turn, nums, cells }
}

/* ────────────────────────── 生成 ────────────────────────── */

interface GenSpec {
  seed: number
  width: number
  height: number
  difficulty: Difficulty
  density: number
  name: string
  series: string
  attempts: number
}

const SPECS: GenSpec[] = [
  { seed: 0x53484b01, width: 6, height: 6, difficulty: 'easy', density: 0.7, name: '初识信号旗', series: '入门', attempts: 120 },
  { seed: 0x53484b02, width: 6, height: 6, difficulty: 'easy', density: 0.62, name: '两侧灯语', series: '入门', attempts: 160 },
  { seed: 0x53484b03, width: 7, height: 7, difficulty: 'medium', density: 0.58, name: '转角旗杆', series: '进阶', attempts: 200 },
  { seed: 0x53484b04, width: 8, height: 7, difficulty: 'medium', density: 0.55, name: '环线迷阵', series: '进阶', attempts: 240 },
  { seed: 0x53484b05, width: 8, height: 8, difficulty: 'hard', density: 0.5, name: '黑旗矩阵', series: '挑战', attempts: 260 },
  { seed: 0x53484b06, width: 9, height: 8, difficulty: 'hard', density: 0.48, name: '终局信号', series: '挑战', attempts: 300 },
]

export interface GeneratedPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: Difficulty
  series: string
  board: string
  solution: string
}

function edgesToValues(edges: ArrayLike<number>): number[] {
  const out = new Array<number>(edges.length)
  for (let i = 0; i < edges.length; i++) out[i] = edges[i] === 1 ? ON : OFF
  return out
}

function attempt(spec: GenSpec, rng: () => number): GeneratedPuzzle | null {
  const { width: w, height: h } = spec
  const dw = w - 1
  const dh = h - 1
  const target = Math.max(6, Math.round(dw * dh * (0.32 + rng() * 0.24)))
  const mask = growRegion(dw, dh, target, rng)
  if (!mask) return null
  const on = boundaryEdges(mask, dw, dh, w, h)
  if (!on) return null
  const info = analyzeLoop(on, w, h)
  if (!info) return null

  // 候选圆：数字必须 2..9
  const candidates = shuffle(
    info.cells.filter((cell) => {
      const n = info.nums[cell]!
      return n >= 2 && n <= 9
    }),
    rng,
  )
  if (candidates.length < 5) return null

  const solution = encodeSolution(on)
  const circles = new Array<number>(w * h).fill(0)
  const clueOf = new Map<number, number>()
  for (const cell of candidates) {
    clueOf.set(cell, (info.turn[cell] ? 10 : 20) + info.nums[cell]!)
  }

  let take = Math.max(4, Math.min(candidates.length, Math.round(candidates.length * spec.density)))
  const applyClues = (): void => {
    for (let i = 0; i < take; i++) circles[candidates[i]!] = clueOf.get(candidates[i]!)!
  }
  applyClues()

  for (;;) {
    const puzzle: ShingokiPuzzle = {
      id: `shingoki-${w}x${h}-${spec.seed.toString(36)}`,
      name: spec.name,
      width: w,
      height: h,
      difficulty: spec.difficulty,
      circles: circles.slice(),
      solutionEdges: solution,
    }
    const counted = countSolutions(puzzle, 2, 220_000, 8000)
    if (counted.timedOut) {
      if (take >= candidates.length) return null
      take++
      applyClues()
      continue
    }
    if (counted.count !== 1) {
      if (take >= candidates.length) return null
      take++
      applyClues()
      continue
    }
    // 唯一解：要求也能纯规则推完
    const plan = planLogicSolve(puzzle, createEmptyState(puzzle))
    if (plan.saturated && plan.finalState) {
      const stateValues = valuesFromState(asShingokiState(plan.finalState))
      const check = checkSolution(stateValues, puzzle)
      if (check.ok && checkSolution(edgesToValues(on), puzzle).ok) {
        return {
          id: puzzle.id,
          name: spec.name,
          width: w,
          height: h,
          difficulty: spec.difficulty,
          series: spec.series,
          board: encodeCircles(circles),
          solution,
        }
      }
    }
    if (take >= candidates.length) return null
    take++
    applyClues()
  }
}

export async function generatePuzzles(): Promise<GeneratedPuzzle[]> {
  const out: GeneratedPuzzle[] = []
  for (const spec of SPECS) {
    const t0 = Date.now()
    const rng = mulberry32(spec.seed)
    let made: GeneratedPuzzle | null = null
    for (let i = 0; i < spec.attempts && !made; i++) {
      made = attempt(spec, rng)
    }
    if (!made) throw new Error(`[信号旗 gen] ${spec.name} 生成失败`)
    const circles = made.board.replace(/\./g, '').length
    console.log(
      `[信号旗 gen] ${made.name} ${made.width}×${made.height} 圆 ${circles} 个 · ${Date.now() - t0}ms`,
    )
    out.push(made)
  }
  return out
}
