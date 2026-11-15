/**
 * ════════════════════════════════════════════════════════════════════
 *  信号旗（Shingoki）—— 游戏适配器
 * ════════════════════════════════════════════════════════════════════
 *
 * 状态：相邻格中心之间的边，0 = 未定，1 = 画线，2 = 标叉。
 * 题面：格子里的黑圆 / 白圆（可带数字）。
 */

import { playDrop, playPluck } from '../core/audio'
import type {
  CustomPaletteItem,
  CustomSupport,
  GameAdapter,
  KeyboardNav,
  Move,
  Puzzle,
  SolveResult,
} from '../core/types'
import { planLogicSolve } from './logic'
import { builtinPuzzles, getReferenceSolution } from './puzzles'
import { hitTest, metricsFor, renderBoard } from './render'
import { countSolutions, solvePuzzle } from './solver'
import {
  applyMove,
  cloneState,
  createEmptyState,
  cycleValue,
  deserializeState,
  firstHintMove,
  invertMove,
  rightClickValue,
  serializeState,
  valueAt,
} from './state'
import { statusBits, validate } from './validate'
import {
  asShingokiPuzzle,
  circleColor,
  CIRCLE_BLACK,
  CIRCLE_WHITE,
  encodeCircles,
  layoutFor,
  MAX_CUSTOM_SIZE,
  type ShingokiPuzzle,
} from './types'

const meta = {
  title: '信号旗',
  tagline: '画一条经过所有圆的单一闭环：黑圆转弯、白圆直行，数字是两侧到第一次转弯的长度和',
  footerNote:
    '规则：在相邻格心之间画线，连成一条不交叉、不分叉的单一闭合回路；回路必须经过所有圆。黑圆处必须 90° 转弯，白圆处必须直线通过；圆内数字 = 从该圆沿回路向两侧走到各自第一次转弯处的长度之和（途中经过其它圆不停止计数）。左键点击/拖动切换「画线 → 标叉 → 清除」，右键直接标叉。',
  storageKeyPrefix: 'shingoki',
  customIdPrefix: 'shingoki-custom-',
  customMinW: 4,
  customMinH: 4,
  customMaxW: MAX_CUSTOM_SIZE,
  customMaxH: MAX_CUSTOM_SIZE,
  targetKind: 'edge' as const,
  interactionHint: '左键点两格之间画线（再点标叉、三点清除）· 右键标叉 · 拖动画线',
}

/* ── 自定义题板：cell 模式，一个值编码「圆颜色 + 数字」 ── */

const PALETTE: CustomPaletteItem[] = [
  { value: null, label: '空', cls: 'brush-empty', title: '清除（也可右键）' },
  { value: 10, label: '●', cls: 'brush-black', title: '黑圆（无数字）' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    value: 10 + n,
    label: String(n),
    cls: 'brush-black',
    title: `黑圆 ${n}（必须转弯，两臂长之和 = ${n}）`,
  })),
  { value: 20, label: '○', cls: 'brush-white', title: '白圆（无数字）' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    value: 20 + n,
    label: String(n),
    cls: 'brush-white',
    title: `白圆 ${n}（必须直行，两侧到转弯之和 = ${n}）`,
  })),
]

const custom: CustomSupport = {
  mode: 'cell',
  valueCycle: [null, 11, 21],
  keyForDigit: (digit, current) => {
    if (digit === 0) return null
    if (digit < 1 || digit > 9) return undefined
    const color = typeof current === 'number' && circleColor(current) === CIRCLE_WHITE
      ? CIRCLE_WHITE
      : CIRCLE_BLACK
    return color * 10 + digit
  },
  cellLabel: (v) => {
    if (v == null) return ''
    const n = v % 10
    return n === 0 ? '' : String(n)
  },
  cellClass: (v) => {
    if (v == null) return ''
    const color = circleColor(v)
    return color === CIRCLE_BLACK ? 'circle-black' : color === CIRCLE_WHITE ? 'circle-white' : ''
  },
  palette: PALETTE,
  paletteLabel: '圆 / 数字',
  hint: '先在上方选「黑圆 / 白圆 + 数字」画笔，再点格子放置；右键或「空」画笔清除；键盘方向键移动、数字键直接填圆。',
  toGrid: (p) => {
    const sp = p as ShingokiPuzzle
    if (!sp.circles || sp.circles.length !== sp.width * sp.height) return null
    return { width: sp.width, height: sp.height, grid: sp.circles.slice() }
  },
  makePuzzle: (w, h, grid, existingId) => {
    const circles = new Array<number>(w * h).fill(0)
    for (let i = 0; i < circles.length && i < grid.length; i++) {
      const v = grid[i]
      circles[i] = typeof v === 'number' && v >= 10 && v < 30 ? v : 0
    }
    return {
      id: existingId ?? `${meta.customIdPrefix}${w}x${h}-${Date.now()}`,
      name: `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      circles,
    } satisfies ShingokiPuzzle
  },
  encodePuzzle: (p) => {
    const sp = p as ShingokiPuzzle
    return { board: encodeCircles(sp.circles ?? []) }
  },
  decodePuzzle: (record) => {
    const width = typeof record.width === 'number' ? record.width : 0
    const height = typeof record.height === 'number' ? record.height : 0
    const board = typeof record.board === 'string' ? record.board : ''
    if (width < 1 || height < 1) return null
    if (width > MAX_CUSTOM_SIZE || height > MAX_CUSTOM_SIZE) return null
    const circles = new Array<number>(width * height).fill(0)
    if (board.length !== circles.length) return null
    const BASE = '0123456789abcdefghijklmnopqrstuvwxyz'
    for (let i = 0; i < circles.length; i++) {
      const ch = board[i]!
      if (ch === '.') continue
      const v = BASE.indexOf(ch.toLowerCase())
      if (v < 10 || v > 29) return null
      circles[i] = v
    }
    return {
      id: typeof record.id === 'string' ? record.id : '',
      name: typeof record.name === 'string' ? record.name : `自定义 · ${width}×${height}`,
      width,
      height,
      difficulty: 'custom',
      circles,
    }
  },
}

/* ── 键盘光标：平行方向在同类边里移动，垂直方向切换到最近的另一种边 ── */

const keyboardNav: KeyboardNav = {
  count: (puzzle) => layoutFor(asShingokiPuzzle(puzzle)).count,
  initial: () => 0,
  move: (puzzle, index, dx, dy) => {
    const p = asShingokiPuzzle(puzzle)
    const layout = layoutFor(p)
    if (index < 0 || index >= layout.count) return null
    const w = layout.w
    const h = layout.h
    const hCount = layout.hCount
    const isH = layout.horizontal[index] === 1
    if (isH) {
      const y = Math.floor(index / (w - 1))
      const x = index % (w - 1)
      if (dx !== 0) {
        const nx = x + dx
        if (nx < 0 || nx > w - 2) return null
        return y * (w - 1) + nx
      }
      if (dy !== 0) {
        if (hCount === 0) return null
        const vy = dy < 0 ? y - 1 : y
        if (vy < 0 || vy > h - 2) return null
        const cx = Math.min(x, w - 1)
        return hCount + vy * w + cx
      }
      return null
    }
    const v = index - hCount
    const vy = Math.floor(v / w)
    const cx = v % w
    if (dy !== 0) {
      const ny = vy + dy
      if (ny < 0 || ny > h - 2) return null
      return hCount + ny * w + cx
    }
    if (dx !== 0) {
      if (w < 2) return null
      const hx = dx < 0 ? cx - 1 : cx
      if (hx < 0 || hx > w - 2) return null
      return vy * (w - 1) + hx
    }
    return null
  },
  describe: (puzzle, index) => {
    const p = asShingokiPuzzle(puzzle)
    const layout = layoutFor(p)
    if (index < 0 || index >= layout.count) return ''
    const w = layout.w
    const hCount = layout.hCount
    if (layout.horizontal[index] === 1) {
      const y = Math.floor(index / (w - 1))
      const x = index % (w - 1)
      return `光标：横边 第 ${y + 1} 行第 ${x + 1} 列`
    }
    const v = index - hCount
    const vy = Math.floor(v / w)
    const cx = v % w
    return `光标：竖边 第 ${vy + 1} 行第 ${cx + 1} 列`
  },
}

/* ── 音效 ── */

function playForMove(move: Move, streak: number): void {
  if (move.to === 1) playPluck(streak, 1)
  else if (move.to === 2) playDrop(streak)
}

export const adapter: GameAdapter = {
  meta,
  builtinPuzzles,
  getReferenceSolution,
  createEmptyState,
  cloneState,
  cycleValue,
  rightClickValue,
  applyMove,
  invertMove,
  valueAt,
  serializeState,
  deserializeState,
  validate,
  statusBits,
  metricsFor,
  renderBoard,
  hitTest,
  keyboardNav,
  planLogicSolve,
  solvePuzzle: (puzzle: Puzzle, maxNodes?: number): SolveResult => solvePuzzle(puzzle, maxNodes),
  countSolutions: (puzzle: Puzzle, limit?: number) => {
    const out = countSolutions(puzzle as unknown as Parameters<typeof countSolutions>[0], limit ?? 2, 400_000, 15_000)
    return { count: out.count, timedOut: out.timedOut, nodes: out.nodes }
  },
  firstHintMove,
  custom,
  playForMove,
}
