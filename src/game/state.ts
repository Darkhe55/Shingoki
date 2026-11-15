/**
 * 信号旗 —— 棋盘状态
 *
 * edges[i]：0 = 未定，1 = 画线，2 = 标叉。
 */

import type { GameState, HitTarget, Move, Puzzle } from '../core/types'
import {
  asShingokiPuzzle,
  asShingokiState,
  decodeSolution,
  edgesFromSolution,
  encodeSolution,
  layoutFor,
  type ShingokiState,
} from './types.ts'

export function createEmptyState(puzzle: Puzzle): ShingokiState {
  const p = asShingokiPuzzle(puzzle)
  const layout = layoutFor(p)
  return {
    puzzleId: p.id,
    width: p.width,
    height: p.height,
    edges: new Array<number>(layout.count).fill(0),
  }
}

export function cloneState(state: GameState): ShingokiState {
  const s = asShingokiState(state)
  return {
    puzzleId: s.puzzleId,
    width: s.width,
    height: s.height,
    edges: s.edges.slice(),
  }
}

/** 左键循环：未定 → 画线 → 标叉 → 未定 */
export function cycleValue(state: GameState, target: HitTarget): number {
  const cur = asShingokiState(state).edges[target.index] ?? 0
  return cur === 0 ? 1 : cur === 1 ? 2 : 0
}

/** 右键：直接标叉；已是叉则清除 */
export function rightClickValue(state: GameState, target: HitTarget): number {
  const cur = asShingokiState(state).edges[target.index] ?? 0
  return cur === 2 ? 0 : 2
}

export function applyMove(state: GameState, move: Move): void {
  const s = asShingokiState(state)
  if (move.index < 0 || move.index >= s.edges.length) return
  s.edges[move.index] = move.to
}

export function invertMove(move: Move): Move {
  return { index: move.index, from: move.to, to: move.from }
}

export function valueAt(state: GameState, index: number): number {
  return asShingokiState(state).edges[index] ?? 0
}

export function serializeState(state: GameState): Record<string, unknown> {
  const s = asShingokiState(state)
  return {
    version: 1,
    puzzleId: s.puzzleId,
    width: s.width,
    height: s.height,
    edgeCount: s.edges.length,
    /** '0' 未定 / '1' 画线 / '2' 标叉 */
    edges: s.edges.map((v) => String(v)).join(''),
  }
}

export function deserializeState(data: Record<string, unknown>): ShingokiState | null {
  if (typeof data.puzzleId !== 'string') return null
  if (typeof data.width !== 'number' || typeof data.height !== 'number') return null
  if (typeof data.edges !== 'string') return null
  const expected = typeof data.edgeCount === 'number' ? data.edgeCount : data.edges.length
  if (expected !== data.edges.length) return null
  if (data.width * data.height <= 0) return null
  const edges = new Array<number>(expected).fill(0)
  for (let i = 0; i < expected; i++) {
    const ch = data.edges[i]!
    if (ch === '0') edges[i] = 0
    else if (ch === '1') edges[i] = 1
    else if (ch === '2') edges[i] = 2
    else return null
  }
  return {
    puzzleId: data.puzzleId,
    width: data.width,
    height: data.height,
    edges,
  }
}

/** 提示一格：找第一个与参考解不同的边 */
export function firstHintMove(state: GameState, solution: GameState): Move | null {
  const s = asShingokiState(state)
  const sol = asShingokiState(solution)
  for (let i = 0; i < s.edges.length; i++) {
    const want = sol.edges[i] ?? 0
    const cur = s.edges[i] ?? 0
    if (cur !== want) return { index: i, from: cur, to: want }
  }
  return null
}

/** 参考解编码 → 完整边状态 */
export function stateFromSolution(puzzle: Puzzle, solutionEdges: string): ShingokiState | null {
  const p = asShingokiPuzzle(puzzle)
  const layout = layoutFor(p)
  const values = decodeSolution(solutionEdges, layout.count)
  if (!values) return null
  return {
    puzzleId: p.id,
    width: p.width,
    height: p.height,
    edges: edgesFromSolution(values),
  }
}

/** 完整边状态 → 参考解编码 */
export function solutionFromState(state: GameState): string {
  const s = asShingokiState(state)
  return encodeSolution(s.edges.map((v) => (v === 1 ? 1 : 0)))
}

/** 判断某条边是否在回路里 */
export function edgeOn(state: GameState, index: number): boolean {
  return (asShingokiState(state).edges[index] ?? 0) === 1
}
