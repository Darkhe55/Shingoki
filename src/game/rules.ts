/**
 * 信号旗 —— 规则引擎
 *
 * 内部取值约定：UNKNOWN = -1，OFF = 0，ON = 1。
 *
 * 规则：
 *  1. 回路是若干条相邻格中心之间的线段组成的单一闭环；
 *  2. 所有圆都必须被回路经过（圆的度 = 2）；
 *  3. 黑圆处必须转弯（一横一竖），白圆处必须直行（左右贯通或上下贯通）；
 *  4. 圆内数字 = 从圆沿回路向两侧走到各自第一次转弯处的长度之和
 *     （长度按「跨过多少格」计，紧邻的转弯计 1；途中经过其它圆不停止计数）。
 *
 * 本文件同时被校验、逻辑推理、回溯求解器复用。
 */

import {
  CIRCLE_BLACK,
  CIRCLE_WHITE,
  circleColor,
  circleNumber,
  edgeStep,
  layoutFor,
  type Dir,
  type EdgeLayout,
  type ShingokiPuzzle,
  type ShingokiState,
} from './types.ts'

export const UNKNOWN = -1
export const OFF = 0
export const ON = 1

export function valuesFromState(state: ShingokiState): number[] {
  const out = new Array<number>(state.edges.length)
  for (let i = 0; i < state.edges.length; i++) {
    const v = state.edges[i] ?? 0
    out[i] = v === 1 ? ON : v === 2 ? OFF : UNKNOWN
  }
  return out
}

export function edgesFromValues(values: ArrayLike<number>): number[] {
  const out = new Array<number>(values.length)
  for (let i = 0; i < values.length; i++) {
    out[i] = values[i] === ON ? 1 : values[i] === OFF ? 2 : 0
  }
  return out
}

/* ────────────────────────── 基本几何 ────────────────────────── */

interface CellCounts {
  on: number
  off: number
  unk: number
}

function countsAt(values: ArrayLike<number>, layout: EdgeLayout, cell: number): CellCounts {
  const base = cell * 4
  let on = 0
  let off = 0
  let unk = 0
  for (let d = 0; d < 4; d++) {
    const e = layout.cellIncident[base + d]!
    if (e < 0) continue
    const v = values[e]!
    if (v === ON) on++
    else if (v === OFF) off++
    else unk++
  }
  return { on, off, unk }
}

function degreeAt(values: ArrayLike<number>, layout: EdgeLayout, cell: number): number {
  return countsAt(values, layout, cell).on
}

/* ────────────────────────── 射线（数字规则） ────────────────────────── */

export interface RayResult {
  kind: 'turn' | 'incomplete' | 'invalid'
  /** kind = turn 时的确切长度 */
  distance: number
  /** 转弯长度的下界（incomplete / turn 都有效） */
  minD: number
}

const INVALID: RayResult = { kind: 'invalid', distance: 0, minD: Number.POSITIVE_INFINITY }

/**
 * 从圆心沿 dir 走，数到第一次转弯的格数。
 * 只有「已经确定」的格才继续走；遇到不确定处返回 incomplete 与下界。
 */
export function walkRay(
  values: ArrayLike<number>,
  layout: EdgeLayout,
  puzzle: ShingokiPuzzle,
  start: number,
  dir: Dir,
): RayResult {
  let cur = start
  for (let k = 1; ; k++) {
    const step = edgeStep(layout, cur, dir)
    if (!step) return INVALID
    const ev = values[step.edge]!
    if (ev === OFF) return INVALID
    if (ev === UNKNOWN) return { kind: 'incomplete', distance: k, minD: k }
    const cell = step.next
    const code = puzzle.circles[cell] ?? 0
    if (code !== 0) {
      const color = circleColor(code)
      if (color === CIRCLE_BLACK) return { kind: 'turn', distance: k, minD: k }
      // 白圆必定直行：检查是否有垂直方向的线（矛盾）
      const { on } = countsAt(values, layout, cell)
      if (on > 2) return INVALID
      cur = cell
      continue
    }
    const { on, unk } = countsAt(values, layout, cell)
    if (on > 2) return INVALID
    if (on === 2) {
      // 判断两条线是否垂直：垂直 = 转弯
      if (isCornerPattern(values, layout, cell)) return { kind: 'turn', distance: k, minD: k }
      cur = cell
      continue
    }
    if (on === 1) {
      if (unk === 0) return INVALID
      return { kind: 'incomplete', distance: k, minD: k }
    }
    return INVALID
  }
}

/** 该格是否已确定为一横一竖的转弯 */
function isCornerPattern(values: ArrayLike<number>, layout: EdgeLayout, cell: number): boolean {
  const base = cell * 4
  const up = layout.cellIncident[base]! >= 0 && values[layout.cellIncident[base]!] === ON
  const down = layout.cellIncident[base + 1]! >= 0 && values[layout.cellIncident[base + 1]!] === ON
  const left = layout.cellIncident[base + 2]! >= 0 && values[layout.cellIncident[base + 2]!] === ON
  const right = layout.cellIncident[base + 3]! >= 0 && values[layout.cellIncident[base + 3]!] === ON
  const horizontal = (left ? 1 : 0) + (right ? 1 : 0)
  const vertical = (up ? 1 : 0) + (down ? 1 : 0)
  return horizontal === 1 && vertical === 1
}

/**
 * 圆的两条射线的方向。
 * 黑圆：已确定一横一竖两条出边，返回这两个方向。
 * 白圆：只要确定轴线（有任一方向的出边），就返回两侧方向。
 */
export function circleRayDirs(
  values: ArrayLike<number>,
  layout: EdgeLayout,
  puzzle: ShingokiPuzzle,
  cell: number,
): [Dir, Dir] | null {
  const code = puzzle.circles[cell] ?? 0
  if (code === 0) return null
  const color = circleColor(code)
  const base = cell * 4
  const upE = layout.cellIncident[base]!
  const downE = layout.cellIncident[base + 1]!
  const leftE = layout.cellIncident[base + 2]!
  const rightE = layout.cellIncident[base + 3]!
  const isOn = (e: number): boolean => e >= 0 && values[e] === ON
  const hDirs: Dir[] = []
  const vDirs: Dir[] = []
  if (leftE >= 0 && isOn(leftE)) hDirs.push(2)
  if (rightE >= 0 && isOn(rightE)) hDirs.push(3)
  if (upE >= 0 && isOn(upE)) vDirs.push(0)
  if (downE >= 0 && isOn(downE)) vDirs.push(1)
  if (color === CIRCLE_BLACK) {
    if (hDirs.length === 1 && vDirs.length === 1) return [hDirs[0]!, vDirs[0]!]
    return null
  }
  // 白圆
  if (hDirs.length > 0 && vDirs.length > 0) return null
  if (hDirs.length > 0) return [2, 3]
  if (vDirs.length > 0) return [0, 1]
  return null
}

/* ────────────────────────── 规则传播 ────────────────────────── */

type Setter = (edge: number, value: number) => boolean

/** 单元格通用规则 + 圆方向规则 */
function cellRules(
  values: number[],
  layout: EdgeLayout,
  puzzle: ShingokiPuzzle,
  set: Setter,
): boolean {
  const cells = layout.w * layout.h
  const { cellIncident } = layout
  for (let cell = 0; cell < cells; cell++) {
    const base = cell * 4
    const code = puzzle.circles[cell] ?? 0
    let on = 0
    let unk = 0
    for (let d = 0; d < 4; d++) {
      const e = cellIncident[base + d]!
      if (e < 0) continue
      const v = values[e]!
      if (v === ON) on++
      else if (v === UNKNOWN) unk++
    }
    if (on > 2) return false
    if (code !== 0 && on + unk < 2) return false
    if (on === 2) {
      for (let d = 0; d < 4; d++) {
        const e = cellIncident[base + d]!
        if (e >= 0 && values[e] === UNKNOWN && !set(e, OFF)) return false
      }
    } else if (on === 1) {
      if (unk === 0) return false
      if (unk === 1) {
        for (let d = 0; d < 4; d++) {
          const e = cellIncident[base + d]!
          if (e >= 0 && values[e] === UNKNOWN && !set(e, ON)) return false
        }
      }
    } else if (on === 0 && unk === 1) {
      for (let d = 0; d < 4; d++) {
        const e = cellIncident[base + d]!
        if (e >= 0 && values[e] === UNKNOWN && !set(e, OFF)) return false
      }
    }
  }

  // 圆的方向规则
  for (let cell = 0; cell < cells; cell++) {
    const code = puzzle.circles[cell] ?? 0
    if (code === 0) continue
    const color = circleColor(code)
    const base = cell * 4
    const upE = cellIncident[base]!
    const downE = cellIncident[base + 1]!
    const leftE = cellIncident[base + 2]!
    const rightE = cellIncident[base + 3]!
    const hEdges = [leftE, rightE].filter((e) => e >= 0)
    const vEdges = [upE, downE].filter((e) => e >= 0)
    const summarize = (edges: number[]) => {
      let on = 0
      let unk = 0
      for (const e of edges) {
        if (values[e] === ON) on++
        else if (values[e] === UNKNOWN) unk++
      }
      return { on, unk }
    }
    const h = summarize(hEdges)
    const v = summarize(vEdges)

    if (color === CIRCLE_BLACK) {
      if (h.on > 1 || v.on > 1) return false
      if (h.on === 1 && v.on === 1) continue
      if (h.on === 1) {
        if (v.unk === 0) return false
        if (v.unk === 1) {
          const e = vEdges.find((x) => values[x] === UNKNOWN)!
          if (!set(e, ON)) return false
        }
        continue
      }
      if (v.on === 1) {
        if (h.unk === 0) return false
        if (h.unk === 1) {
          const e = hEdges.find((x) => values[x] === UNKNOWN)!
          if (!set(e, ON)) return false
        }
        continue
      }
      // 两条都没画
      if (hEdges.length === 0 || vEdges.length === 0) return false
      if (h.unk === 0 || v.unk === 0) return false
      continue
    }

    // 白圆：直线贯通
    const hFeasible = leftE >= 0 && rightE >= 0
    const vFeasible = upE >= 0 && downE >= 0
    if (!hFeasible && !vFeasible) return false
    if (h.on > 0 && v.on > 0) return false
    if (h.on > 0) {
      if (!hFeasible) return false
      for (const e of vEdges) {
        if (values[e] === UNKNOWN && !set(e, OFF)) return false
      }
      for (const e of hEdges) {
        if (values[e] === OFF) return false
        if (values[e] === UNKNOWN && !set(e, ON)) return false
      }
      continue
    }
    if (v.on > 0) {
      if (!vFeasible) return false
      for (const e of hEdges) {
        if (values[e] === UNKNOWN && !set(e, OFF)) return false
      }
      for (const e of vEdges) {
        if (values[e] === OFF) return false
        if (values[e] === UNKNOWN && !set(e, ON)) return false
      }
      continue
    }
    // 两条都没画：用可行性排除
    if (!hFeasible) {
      for (const e of vEdges) if (values[e] !== ON && !set(e, ON)) return false
      continue
    }
    if (!vFeasible) {
      for (const e of hEdges) if (values[e] !== ON && !set(e, ON)) return false
      continue
    }
    if (h.unk === 0) {
      for (const e of vEdges) if (values[e] !== ON && !set(e, ON)) return false
      continue
    }
    if (v.unk === 0) {
      for (const e of hEdges) if (values[e] !== ON && !set(e, ON)) return false
      continue
    }
  }
  return true
}

/** 回路连通性规则：不能提前闭环（除非已经包含全部圆且是唯一回路） */
function loopRules(
  values: number[],
  layout: EdgeLayout,
  puzzle: ShingokiPuzzle,
  set: Setter,
): boolean {
  const cells = layout.w * layout.h
  const { cellIncident } = layout
  const seen = new Uint8Array(cells)
  let circleTotal = 0
  for (let i = 0; i < cells; i++) if ((puzzle.circles[i] ?? 0) !== 0) circleTotal++

  let components = 0
  let closedComponents = 0
  let closedHasAllCircles = false

  for (let start = 0; start < cells; start++) {
    if (seen[start]) continue
    const deg0 = degreeAt(values, layout, start)
    if (deg0 === 0) continue
    seen[start] = 1
    const queue = [start]
    let openEnds = 0
    let branch = false
    let circleCount = 0
    while (queue.length) {
      const cell = queue.pop()!
      const deg = degreeAt(values, layout, cell)
      if (deg === 1) openEnds++
      if (deg > 2) branch = true
      if ((puzzle.circles[cell] ?? 0) !== 0) circleCount++
      const base = cell * 4
      for (let d = 0; d < 4; d++) {
        const e = cellIncident[base + d]!
        if (e < 0 || values[e] !== ON) continue
        const other =
          layout.edgeCells[e * 2] === cell ? layout.edgeCells[e * 2 + 1]! : layout.edgeCells[e * 2]!
        if (!seen[other]) {
          seen[other] = 1
          queue.push(other)
        }
      }
    }
    components++
    if (branch) return false
    if (openEnds === 0) {
      closedComponents++
      if (closedComponents > 1) return false
      if (componentCircleCount(puzzle, values, layout, start) !== circleTotal) {
        // 已闭环却漏了圆 → 矛盾
        return false
      }
      closedHasAllCircles = true
    }
    void circleCount
  }

  if (closedComponents > 0) {
    if (components > 1) return false
    if (!closedHasAllCircles) return false
    // 回路已经唯一确定：其它所有未定边都不可能是回路的一部分
    for (let e = 0; e < layout.count; e++) {
      if (values[e] === UNKNOWN && !set(e, OFF)) return false
    }
  }
  return true
}

/** 统计从 start 所在分量里的圆数量（与 loopRules 的 BFS 互不干扰，只在闭环时调用一次） */
function componentCircleCount(
  puzzle: ShingokiPuzzle,
  values: ArrayLike<number>,
  layout: EdgeLayout,
  start: number,
): number {
  const { cellIncident } = layout
  const seen = new Set<number>([start])
  const stack = [start]
  let count = 0
  while (stack.length) {
    const cell = stack.pop()!
    if ((puzzle.circles[cell] ?? 0) !== 0) count++
    const base = cell * 4
    for (let d = 0; d < 4; d++) {
      const e = cellIncident[base + d]!
      if (e < 0 || values[e] !== ON) continue
      const other =
        layout.edgeCells[e * 2] === cell ? layout.edgeCells[e * 2 + 1]! : layout.edgeCells[e * 2]!
      if (!seen.has(other)) {
        seen.add(other)
        stack.push(other)
      }
    }
  }
  return count
}

/**
 * 让 start 沿 dir 在距离 dist 处必须转弯。
 * 调用前提：1..dist-1 的格子已经确定直行（由 walkRay 的 incomplete 保证）。
 */
function forceTurn(
  values: number[],
  layout: EdgeLayout,
  puzzle: ShingokiPuzzle,
  start: number,
  dir: Dir,
  dist: number,
  set: Setter,
): boolean {
  let cur = start
  for (let k = 1; k < dist; k++) {
    const step = edgeStep(layout, cur, dir)
    if (!step || values[step.edge] !== ON) return false
    cur = step.next
  }
  const step = edgeStep(layout, cur, dir)
  if (!step) return false
  if (values[step.edge] !== ON) {
    if (values[step.edge] === UNKNOWN) {
      if (!set(step.edge, ON)) return false
    } else {
      return false
    }
  }
  const turnCell = step.next
  const cont = edgeStep(layout, turnCell, dir)
  if (cont) {
    if (values[cont.edge] === ON) return false
    if (!set(cont.edge, OFF)) return false
  }
  const code = puzzle.circles[turnCell] ?? 0
  if (code !== 0 && circleColor(code) === CIRCLE_WHITE) return false
  return true
}

/** 数字规则 */
function numberRules(
  values: number[],
  layout: EdgeLayout,
  puzzle: ShingokiPuzzle,
  set: Setter,
): boolean {
  const cells = layout.w * layout.h
  for (let cell = 0; cell < cells; cell++) {
    const code = puzzle.circles[cell] ?? 0
    if (code === 0) continue
    const n = circleNumber(code)
    if (n <= 0) continue
    const dirs = circleRayDirs(values, layout, puzzle, cell)
    if (!dirs) continue
    const r1 = walkRay(values, layout, puzzle, cell, dirs[0])
    const r2 = walkRay(values, layout, puzzle, cell, dirs[1])
    if (r1.kind === 'invalid' || r2.kind === 'invalid') return false
    if (r1.kind === 'turn' && r2.kind === 'turn') {
      if (r1.distance + r2.distance !== n) return false
      continue
    }
    if (r1.minD + r2.minD > n) return false
    if (r1.minD + r2.minD === n) {
      if (r1.kind !== 'turn' && !forceTurn(values, layout, puzzle, cell, dirs[0], r1.minD, set)) {
        return false
      }
      if (r2.kind !== 'turn' && !forceTurn(values, layout, puzzle, cell, dirs[1], r2.minD, set)) {
        return false
      }
    }
  }
  return true
}

/**
 * 把 values 上的已知条件传播到不动点。
 * 返回 false 表示矛盾；onSet 回调用于逻辑回放记录每一步。
 */
export function propagate(
  values: number[],
  puzzle: ShingokiPuzzle,
  onSet?: (edge: number, value: number) => void,
): boolean {
  const layout = layoutFor(puzzle)
  let changed = true
  const set: Setter = (edge, value) => {
    if (values[edge] === value) return true
    if (values[edge] !== UNKNOWN) return false
    values[edge] = value
    onSet?.(edge, value)
    changed = true
    return true
  }
  while (changed) {
    changed = false
    if (!cellRules(values, layout, puzzle, set)) return false
    if (!loopRules(values, layout, puzzle, set)) return false
    if (!numberRules(values, layout, puzzle, set)) return false
  }
  return true
}

/* ────────────────────────── 校验 ────────────────────────── */

export interface ShingokiCheck {
  ok: boolean
  /** 需要标红的格 */
  badCells: number[]
  /** 度 = 1 的断路端点 */
  openCells: number[]
  /** 度 ≥ 3 的分叉点 */
  branchCells: number[]
  /** 回路连通分量数（度 > 0 的格） */
  componentCount: number
  /** 已画线边数 */
  onEdges: number
  /** 是否已形成闭环（所有在线格度 = 2，且只有一个分量） */
  closedLoop: boolean
  /** 没被回路经过的圆（已确定边的情况下） */
  circleMissing: number[]
  /** 方向不对的圆（黑圆未转弯 / 白圆未直行） */
  badOrientation: number[]
  /** 数字不符的圆 */
  badNumber: Array<{ cell: number; expected: number; actual: number }>
}

export function checkSolution(values: ArrayLike<number>, puzzle: ShingokiPuzzle): ShingokiCheck {
  const layout = layoutFor(puzzle)
  const cells = layout.w * layout.h
  const badCells = new Set<number>()
  const openCells: number[] = []
  const branchCells: number[] = []
  const circleMissing: number[] = []
  const badOrientation: number[] = []
  const badNumber: Array<{ cell: number; expected: number; actual: number }> = []
  let onEdges = 0
  for (let e = 0; e < layout.count; e++) if (values[e] === ON) onEdges++

  const degrees = new Int32Array(cells)
  for (let cell = 0; cell < cells; cell++) {
    const d = degreeAt(values, layout, cell)
    degrees[cell] = d
    if (d === 1) {
      openCells.push(cell)
      badCells.add(cell)
    } else if (d > 2) {
      branchCells.push(cell)
      badCells.add(cell)
    }
  }

  // 圆：经过 / 方向 / 数字
  for (let cell = 0; cell < cells; cell++) {
    const code = puzzle.circles[cell] ?? 0
    if (code === 0) continue
    const counts = countsAt(values, layout, cell)
    if (counts.unk > 0) {
      // 还有未定边，无法判定
      if (counts.on > 2) badCells.add(cell)
      continue
    }
    const d = degrees[cell]!
    if (d !== 2) {
      circleMissing.push(cell)
      badCells.add(cell)
      continue
    }
    const color = circleColor(code)
    const corner = isCornerPattern(values, layout, cell)
    const straight = !corner
    if (color === CIRCLE_BLACK) {
      if (!corner) {
        badOrientation.push(cell)
        badCells.add(cell)
        continue
      }
    } else if (color === CIRCLE_WHITE) {
      if (!straight) {
        badOrientation.push(cell)
        badCells.add(cell)
        continue
      }
    }
    const n = circleNumber(code)
    if (n <= 0) continue
    const dirs = circleRayDirs(values, layout, puzzle, cell)
    if (!dirs) continue
    const r1 = walkRay(values, layout, puzzle, cell, dirs[0])
    const r2 = walkRay(values, layout, puzzle, cell, dirs[1])
    if (r1.kind !== 'turn' || r2.kind !== 'turn') continue
    const actual = r1.distance + r2.distance
    if (actual !== n) {
      badNumber.push({ cell, expected: n, actual })
      badCells.add(cell)
    }
  }

  // 连通分量
  const seen = new Uint8Array(cells)
  let componentCount = 0
  let closedLoop = false
  for (let start = 0; start < cells; start++) {
    if (seen[start] || degrees[start] === 0) continue
    seen[start] = 1
    const queue = [start]
    let allTwo = true
    while (queue.length) {
      const cell = queue.pop()!
      if (degrees[cell] !== 2) allTwo = false
      const base = cell * 4
      for (let d = 0; d < 4; d++) {
        const e = layout.cellIncident[base + d]!
        if (e < 0 || values[e] !== ON) continue
        const other =
          layout.edgeCells[e * 2] === cell ? layout.edgeCells[e * 2 + 1]! : layout.edgeCells[e * 2]!
        if (!seen[other]) {
          seen[other] = 1
          queue.push(other)
        }
      }
    }
    componentCount++
    if (allTwo && componentCount === 1) closedLoop = true
    else if (componentCount > 1) closedLoop = false
  }
  if (componentCount > 1) closedLoop = false

  const ok =
    onEdges > 0 &&
    badCells.size === 0 &&
    componentCount === 1 &&
    closedLoop &&
    circleMissing.length === 0 &&
    badOrientation.length === 0 &&
    badNumber.length === 0

  return {
    ok,
    badCells: Array.from(badCells).sort((a, b) => a - b),
    openCells,
    branchCells,
    componentCount,
    onEdges,
    closedLoop,
    circleMissing,
    badOrientation,
    badNumber,
  }
}
