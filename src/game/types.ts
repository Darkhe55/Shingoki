/**
 * 信号旗（Shingoki）—— 类型与编码
 *
 * 棋盘：W×H 个格子。黑白圆放在格子里；回路沿「相邻两格中心之间」的线段走，
 * 也就是一条穿过格心的正交折线（单一闭环，不交叉不分叉）。
 *
 * 边的索引顺序与 core/board.ts 完全一致：
 *   - 水平边（左右相邻）：h*(w-1) 条，索引 = y*(w-1)+x
 *   - 竖直边（上下相邻）：在其后，(h-1)*w 条，索引 = h*(w-1)+y*w+x
 *
 * 圆编码：0 = 空格；10+n = 黑圆；20+n = 白圆（n = 0..9，0 表示圆里没有数字）。
 */

import type { GameState, Puzzle } from '../core/types'

/** 自定义题板最大边长 */
export const MAX_CUSTOM_SIZE = 20

export const CIRCLE_NONE = 0
export const CIRCLE_BLACK = 1
export const CIRCLE_WHITE = 2

/** 圆编号 → 颜色（0 = 不是圆） */
export function circleColor(code: number): 0 | 1 | 2 {
  if (code >= 10 && code < 20) return CIRCLE_BLACK
  if (code >= 20 && code < 30) return CIRCLE_WHITE
  return 0
}

/** 圆编号 → 数字（无数字 / 非圆返回 0） */
export function circleNumber(code: number): number {
  const color = circleColor(code)
  return color === 0 ? 0 : code - color * 10
}

/** 颜色 + 数字 → 圆编号 */
export function makeCircle(color: 1 | 2, n: number): number {
  const num = Math.max(0, Math.min(9, n | 0))
  return color * 10 + num
}

export interface ShingokiPuzzle extends Puzzle {
  /** 每格的圆编码（长度 = width × height） */
  circles: number[]
  /** 参考解的边编码（'0'/'1'，长度 = 边数） */
  solutionEdges?: string
}

export interface ShingokiState extends GameState {
  /** 每条边的状态：0 = 未定，1 = 画线，2 = 标叉 */
  edges: number[]
}

/** 方向：0 上，1 下，2 左，3 右 */
export type Dir = 0 | 1 | 2 | 3

export interface EdgeLayout {
  w: number
  h: number
  /** 水平边数量 */
  hCount: number
  /** 竖直边数量 */
  vCount: number
  /** 边总数 */
  count: number
  /** 4 × 格子数：[上, 下, 左, 右] 的边索引（-1 = 棋盘外） */
  cellIncident: Int32Array
  /** 2 × 边数：两端格子索引（a,b） */
  edgeCells: Int32Array
  /** 每条边是否水平 */
  horizontal: Uint8Array
}

export function horizontalEdgeIndex(w: number, x: number, y: number): number {
  return y * (w - 1) + x
}

export function verticalEdgeIndex(w: number, h: number, x: number, y: number): number {
  return h * (w - 1) + y * w + x
}

/** 构建边的几何布局（带缓存） */
const layoutCache = new WeakMap<ShingokiPuzzle, EdgeLayout>()

export function layoutOf(w: number, h: number): EdgeLayout {
  const hCount = w > 1 ? h * (w - 1) : 0
  const vCount = h > 1 ? (h - 1) * w : 0
  const count = hCount + vCount
  const cellIncident = new Int32Array(w * h * 4).fill(-1)
  const edgeCells = new Int32Array(count * 2)
  const horizontal = new Uint8Array(count)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = y * w + x
      const base = cell * 4
      // 方向：[上, 下, 左, 右]
      if (y > 0) cellIncident[base] = verticalEdgeIndex(w, h, x, y - 1)
      if (y < h - 1) cellIncident[base + 1] = verticalEdgeIndex(w, h, x, y)
      if (x > 0) cellIncident[base + 2] = horizontalEdgeIndex(w, x - 1, y)
      if (x < w - 1) cellIncident[base + 3] = horizontalEdgeIndex(w, x, y)
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const e = horizontalEdgeIndex(w, x, y)
      edgeCells[e * 2] = y * w + x
      edgeCells[e * 2 + 1] = y * w + x + 1
      horizontal[e] = 1
    }
  }
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = verticalEdgeIndex(w, h, x, y)
      edgeCells[e * 2] = y * w + x
      edgeCells[e * 2 + 1] = (y + 1) * w + x
      horizontal[e] = 0
    }
  }

  return { w, h, hCount, vCount, count, cellIncident, edgeCells, horizontal }
}

export function layoutFor(puzzle: ShingokiPuzzle): EdgeLayout {
  const cached = layoutCache.get(puzzle)
  if (cached) return cached
  const layout = layoutOf(puzzle.width, puzzle.height)
  layoutCache.set(puzzle, layout)
  return layout
}

/** 从 cell 沿 dir 走一步：返回边索引与目标格；越界返回 null */
export function edgeStep(
  layout: EdgeLayout,
  cell: number,
  dir: Dir,
): { edge: number; next: number } | null {
  const { w, h, cellIncident } = layout
  const x = cell % w
  const y = (cell / w) | 0
  const edge = cellIncident[cell * 4 + dir]!
  if (edge < 0) return null
  let next: number
  if (dir === 0) next = cell - w
  else if (dir === 1) next = cell + w
  else if (dir === 2) next = cell - 1
  else next = cell + 1
  if (next < 0 || next >= w * h) return null
  if (dir === 0 && y === 0) return null
  if (dir === 1 && y === h - 1) return null
  if (dir === 2 && x === 0) return null
  if (dir === 3 && x === w - 1) return null
  return { edge, next }
}

/** 相反方向 */
export function oppositeDir(dir: Dir): Dir {
  return dir === 0 ? 1 : dir === 1 ? 0 : dir === 2 ? 3 : 2
}

export function asShingokiPuzzle(p: Puzzle): ShingokiPuzzle {
  return p as ShingokiPuzzle
}

export function asShingokiState(s: GameState): ShingokiState {
  return s as ShingokiState
}

/** 圆编码串：空格 '.'，其余为编码的 base36 字符（'a'..'t'） */
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

export function encodeCircles(circles: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < circles.length; i++) {
    const code = circles[i]! | 0
    out += code > 0 && code < 36 ? BASE36[code]! : '.'
  }
  return out
}

export function decodeCircles(text: string, expected: number): number[] | null {
  if (typeof text !== 'string' || text.length !== expected) return null
  const out = new Array<number>(expected).fill(0)
  for (let i = 0; i < expected; i++) {
    const ch = text[i]!
    if (ch === '.' || ch === '_' || ch === ' ') continue
    const v = BASE36.indexOf(ch.toLowerCase())
    if (v < 10 || v > 29) return null
    out[i] = v
  }
  return out
}

/** 解（只含 0/1）→ 边状态数组（1 = 画线，2 = 标叉） */
export function edgesFromSolution(sol: ArrayLike<number>): number[] {
  const out = new Array<number>(sol.length)
  for (let i = 0; i < sol.length; i++) out[i] = sol[i] ? 1 : 2
  return out
}

/** 参考解编码：'1' = 画线，'0' = 不画 */
export function encodeSolution(edges: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < edges.length; i++) out += (edges[i] ?? 0) === 1 ? '1' : '0'
  return out
}

export function decodeSolution(text: string, expected: number): number[] | null {
  if (typeof text !== 'string' || text.length !== expected) return null
  const out = new Array<number>(expected).fill(0)
  for (let i = 0; i < expected; i++) {
    if (text[i] === '1') out[i] = 1
    else if (text[i] === '0') out[i] = 0
    else return null
  }
  return out
}
