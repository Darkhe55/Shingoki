/**
 * 信号旗 —— 回溯求解器
 *
 * 在规则传播（rules.propagate）之上做 DFS：每层挑一条最受约束的未定边分支，
 * 传播到矛盾即回溯。用于「显示解 / 提示 / 自定义题唯一解校验」。
 */

import type { Puzzle, SolveResult } from '../core/types'
import {
  checkSolution,
  edgesFromValues,
  OFF,
  ON,
  propagate,
  UNKNOWN,
} from './rules.ts'
import { asShingokiPuzzle, layoutFor, type ShingokiPuzzle, type ShingokiState } from './types.ts'

export interface SearchOutcome {
  solutions: number[][]
  nodes: number
  timedOut: boolean
}

/** 选择分支边：优先挑两端「已经画了一条线 / 只剩两条未定」的格子的边 */
function chooseBranch(
  values: ArrayLike<number>,
  cellIncident: Int32Array,
  count: number,
): number {
  let best = -1
  let bestScore = -Infinity
  const cells = cellIncident.length / 4
  for (let cell = 0; cell < cells; cell++) {
    const base = cell * 4
    let on = 0
    let unk = 0
    for (let d = 0; d < 4; d++) {
      const e = cellIncident[base + d]!
      if (e < 0) continue
      const v = values[e]!
      if (v === ON) on++
      else if (v === UNKNOWN) unk++
    }
    if (unk === 0) continue
    const score = on === 1 ? 40 - unk : on === 0 ? 4 - unk : 0
    if (score <= bestScore) continue
    // 在该格找一条未定边
    for (let d = 0; d < 4; d++) {
      const e = cellIncident[base + d]!
      if (e >= 0 && values[e] === UNKNOWN) {
        best = e
        bestScore = score
        break
      }
    }
  }
  if (best >= 0) return best
  for (let e = 0; e < count; e++) if (values[e] === UNKNOWN) return e
  return -1
}

function search(
  puzzle: ShingokiPuzzle,
  initial: number[] | null,
  limit: number,
  maxNodes: number,
  timeLimitMs: number,
): SearchOutcome {
  const layout = layoutFor(puzzle)
  const solutions: number[][] = []
  let nodes = 0
  let timedOut = false
  const deadline = Date.now() + timeLimitMs

  const dfs = (values: number[]): void => {
    if (solutions.length >= limit || timedOut) return
    nodes++
    if (nodes > maxNodes || (nodes % 64 === 0 && Date.now() > deadline)) {
      timedOut = true
      return
    }
    const work = values.slice()
    if (!propagate(work, puzzle)) return
    const target = chooseBranch(work, layout.cellIncident, layout.count)
    if (target < 0) {
      const check = checkSolution(work, puzzle)
      if (check.ok) solutions.push(work)
      return
    }
    for (const value of [ON, OFF]) {
      const next = work.slice()
      next[target] = value
      dfs(next)
      if (solutions.length >= limit || timedOut) break
    }
  }

  dfs(initial ? initial.slice() : new Array<number>(layout.count).fill(UNKNOWN))
  return { solutions, nodes, timedOut }
}

export interface CountOutcome {
  count: number
  nodes: number
  timedOut: boolean
  first: number[] | null
}

/** 统计解的个数（上限 limit）；用于唯一解校验 */
export function countSolutions(
  puzzle: ShingokiPuzzle,
  limit = 2,
  maxNodes = 400_000,
  timeLimitMs = 20_000,
): CountOutcome {
  const out = search(puzzle, null, limit, maxNodes, timeLimitMs)
  return {
    count: out.solutions.length,
    nodes: out.nodes,
    timedOut: out.timedOut,
    first: out.solutions[0] ?? null,
  }
}

/** 从给定已知条件出发找一个解 */
export function findSolutionFrom(
  puzzle: ShingokiPuzzle,
  values: number[],
  maxNodes = 1_500_000,
  timeLimitMs = 20_000,
): number[] | null {
  const out = search(puzzle, values, 1, maxNodes, timeLimitMs)
  return out.solutions[0] ?? null
}

export function findSolution(puzzle: ShingokiPuzzle, maxNodes = 1_500_000): number[] | null {
  const out = search(puzzle, null, 1, maxNodes, 20_000)
  return out.solutions[0] ?? null
}

function stateFromValues(puzzle: ShingokiPuzzle, values: number[]): ShingokiState {
  return {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    edges: edgesFromValues(values),
  }
}

export function solvePuzzle(puzzle: Puzzle, maxNodes = 1_500_000): SolveResult {
  const p = asShingokiPuzzle(puzzle)
  if (!Array.isArray(p.circles) || p.circles.length !== p.width * p.height) {
    return { solved: false, solution: null, nodes: 0, timedOut: false }
  }
  const out = search(p, null, 1, maxNodes, 20_000)
  if (out.timedOut && !out.solutions.length) {
    return { solved: false, solution: null, nodes: out.nodes, timedOut: true }
  }
  const values = out.solutions[0]
  if (!values) return { solved: false, solution: null, nodes: out.nodes, timedOut: out.timedOut }
  return {
    solved: true,
    solution: stateFromValues(p, values),
    nodes: out.nodes,
    timedOut: false,
  }
}
