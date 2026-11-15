/**
 * 信号旗 —— SVG 渲染与命中
 */

import {
  cellCenter,
  cellSizeOf,
  edgeAtPoint,
  originOf,
  squareMetrics,
} from '../core/board'
import type { BoardMetrics, GameState, HitTarget, Puzzle, ValidationResult } from '../core/types'
import {
  asShingokiPuzzle,
  asShingokiState,
  circleColor,
  circleNumber,
  layoutFor,
  CIRCLE_BLACK,
} from './types'
import type { ShingokiResult } from './validate'

/** 折线穿过格心；圆画在格心，边画在相邻格心之间 */
export const BASE_CELL = 64

export function metricsFor(puzzle: Puzzle): BoardMetrics {
  return squareMetrics(puzzle.width, puzzle.height, {
    cell: BASE_CELL,
    padLeft: 26,
    padTop: 26,
    padRight: 26,
    padBottom: 26,
  })
}

function edgePoints(
  m: BoardMetrics,
  layout: ReturnType<typeof layoutFor>,
  edge: number,
): { a: { x: number; y: number }; b: { x: number; y: number }; mx: number; my: number } {
  const a = cellCenter(m, layout.edgeCells[edge * 2]!)
  const b = cellCenter(m, layout.edgeCells[edge * 2 + 1]!)
  return { a, b, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
}

function isHorizontal(layout: ReturnType<typeof layoutFor>, edge: number): boolean {
  return layout.horizontal[edge] === 1
}

/** 打叉：以边中点为中心的短叉 */
function offMark(x: number, y: number, size: number, edge: number): string {
  const s = size
  return `<g class="sk-off-group" data-index="${edge}">
    <line class="sk-edge-off-mark" x1="${(x - s).toFixed(2)}" y1="${(y - s).toFixed(2)}" x2="${(x + s).toFixed(2)}" y2="${(y + s).toFixed(2)}" />
    <line class="sk-edge-off-mark" x1="${(x - s).toFixed(2)}" y1="${(y + s).toFixed(2)}" x2="${(x + s).toFixed(2)}" y2="${(y - s).toFixed(2)}" />
  </g>`
}

export function renderBoard(
  puzzle: Puzzle,
  state: GameState,
  result: ValidationResult,
  _colorGrid?: unknown,
  overlay?: unknown,
): string {
  const p = asShingokiPuzzle(puzzle)
  const s = asShingokiState(state)
  const r = result as ShingokiResult
  const layout = layoutFor(p)
  const m = metricsFor(puzzle)
  const o = originOf(m)
  const size = cellSizeOf(m)
  const cell = Math.min(size.w, size.h)
  const k = cell / BASE_CELL
  const badCells = new Set(r.badCells ?? [])
  const badCircle = new Set<number>([
    ...(r.badOrientation ?? []),
    ...(r.badNumber ?? []).map((x) => x.cell),
  ])
  const openCells = new Set(r.openCells ?? [])
  const parts: string[] = []

  const boardW = p.width * size.w
  const boardH = p.height * size.h

  parts.push(
    `<svg class="board-svg sk-board" viewBox="0 0 ${m.svgWidth} ${m.svgHeight}" width="${m.svgWidth}" height="${m.svgHeight}" xmlns="http://www.w3.org/2000/svg">`,
  )
  parts.push(
    `<rect class="sk-board-bg" x="${(o.x - 8).toFixed(2)}" y="${(o.y - 8).toFixed(2)}" width="${(boardW + 16).toFixed(2)}" height="${(boardH + 16).toFixed(2)}" rx="${(10 * k).toFixed(2)}" />`,
  )

  // 淡格线：只用来提示「圆在格子里」
  for (let y = 0; y <= p.height; y++) {
    const yy = o.y + y * size.h
    parts.push(
      `<line class="sk-grid" x1="${o.x.toFixed(2)}" y1="${yy.toFixed(2)}" x2="${(o.x + boardW).toFixed(2)}" y2="${yy.toFixed(2)}" />`,
    )
  }
  for (let x = 0; x <= p.width; x++) {
    const xx = o.x + x * size.w
    parts.push(
      `<line class="sk-grid" x1="${xx.toFixed(2)}" y1="${o.y.toFixed(2)}" x2="${xx.toFixed(2)}" y2="${(o.y + boardH).toFixed(2)}" />`,
    )
  }

  // 错误格底色
  for (const idx of badCells) {
    const cx = o.x + (idx % p.width) * size.w
    const cy = o.y + Math.floor(idx / p.width) * size.h
    parts.push(
      `<rect class="sk-cell-error" x="${(cx + 3 * k).toFixed(2)}" y="${(cy + 3 * k).toFixed(2)}" width="${(size.w - 6 * k).toFixed(2)}" height="${(size.h - 6 * k).toFixed(2)}" rx="${(8 * k).toFixed(2)}" />`,
    )
  }

  // 未定边的中点短引导
  const guideLen = 5 * k
  for (let e = 0; e < layout.count; e++) {
    const v = s.edges[e] ?? 0
    if (v !== 0) continue
    const { mx, my } = edgePoints(m, layout, e)
    if (isHorizontal(layout, e)) {
      parts.push(
        `<line class="sk-guide" x1="${(mx - guideLen).toFixed(2)}" y1="${my.toFixed(2)}" x2="${(mx + guideLen).toFixed(2)}" y2="${my.toFixed(2)}" />`,
      )
    } else {
      parts.push(
        `<line class="sk-guide" x1="${mx.toFixed(2)}" y1="${(my - guideLen).toFixed(2)}" x2="${mx.toFixed(2)}" y2="${(my + guideLen).toFixed(2)}" />`,
      )
    }
  }

  // 回路（画线）
  const onWidth = 6.5 * k
  for (let e = 0; e < layout.count; e++) {
    if ((s.edges[e] ?? 0) !== 1) continue
    const { a, b } = edgePoints(m, layout, e)
    parts.push(
      `<line class="sk-edge-on" data-index="${e}" x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}" stroke-width="${onWidth.toFixed(2)}" />`,
    )
  }

  // 标叉
  const xSize = 5.5 * k
  for (let e = 0; e < layout.count; e++) {
    if ((s.edges[e] ?? 0) !== 2) continue
    const { mx, my } = edgePoints(m, layout, e)
    parts.push(offMark(mx, my, xSize, e))
  }

  // 圆
  const radius = cell * 0.4
  for (let cellIdx = 0; cellIdx < p.width * p.height; cellIdx++) {
    const code = p.circles[cellIdx] ?? 0
    if (code === 0) continue
    const color = circleColor(code)
    const n = circleNumber(code)
    const c = cellCenter(m, cellIdx)
    if (color === CIRCLE_BLACK) {
      parts.push(
        `<circle class="sk-circle sk-circle-black" cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${radius.toFixed(2)}" />`,
      )
    } else {
      parts.push(
        `<circle class="sk-circle sk-circle-white" cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${radius.toFixed(2)}" stroke-width="${(2.2 * k).toFixed(2)}" />`,
      )
    }
    if (n > 0) {
      const cls = color === CIRCLE_BLACK ? 'sk-circle-num black' : 'sk-circle-num white'
      parts.push(
        `<text class="${cls}" x="${c.x.toFixed(2)}" y="${(c.y + 0.5).toFixed(2)}" style="font-size:${(cell * 0.44).toFixed(2)}px">${n}</text>`,
      )
    }
    if (badCircle.has(cellIdx)) {
      parts.push(
        `<circle class="sk-circle-bad" cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${(radius + 4 * k).toFixed(2)}" stroke-width="${(2.4 * k).toFixed(2)}" />`,
      )
    }
  }

  // 断路端点提示
  for (const idx of openCells) {
    const c = cellCenter(m, idx)
    parts.push(
      `<circle class="sk-open" cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${(cell * 0.2).toFixed(2)}" stroke-width="${(2 * k).toFixed(2)}" />`,
    )
  }

  // 键盘光标
  const cursor = typeof overlay === 'number' ? overlay : null
  if (cursor !== null && cursor >= 0 && cursor < layout.count) {
    const { a, b, mx, my } = edgePoints(m, layout, cursor)
    parts.push(
      `<line class="sk-cursor" x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}" stroke-width="${(15 * k).toFixed(2)}" />`,
    )
    parts.push(
      `<circle class="sk-cursor-dot" cx="${mx.toFixed(2)}" cy="${my.toFixed(2)}" r="${(4.2 * k).toFixed(2)}" />`,
    )
  }

  parts.push('</svg>')
  return parts.join('\n')
}

export function hitTest(m: BoardMetrics, puzzle: Puzzle, x: number, y: number): HitTarget | null {
  const p = asShingokiPuzzle(puzzle)
  const layout = layoutFor(p)
  const edge = edgeAtPoint(m, x, y, Math.min(m.cellW ?? m.cell, m.cellH ?? m.cell) * 0.42)
  if (edge === null || edge < 0 || edge >= layout.count) return null
  return { index: edge, kind: 'edge' }
}
