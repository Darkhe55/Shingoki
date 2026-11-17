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
 *     数字范围 1..99（0 = 圆里没有数字），编码见 types.ts。
 *
 * 本文件同时被校验、逻辑推理、回溯求解器复用。
 *
 * 传播只用「不猜答案」的安全规则（可证明的局部定式），搜索器只作兜底：
 *   规则 1 单元格：每格度只能是 0 / 2；已有 1 条线且只剩 1 条未定 ⇒ 必连；
 *   规则 2 圆方向：黑圆必须一横一竖；白圆必须同轴贯通；边界上只剩一种走法时直接定死；
 *   规则 3 数字：两臂各自「到第一次转弯」的长度和 = N，含四种安全定式：
 *           a) 两臂下界和 = N ⇒ 两臂各自在最小距离处强制转弯；
 *           b) 一臂长度已确定 ⇒ 另一臂长度随之确定（不够就强制延伸、超出即矛盾）；
 *           c) 圆的两臂方向未定时，枚举「横/竖」候选组合：只剩一种组合能凑出 N ⇒ 两臂定死；
 *           d) 所有候选组合的下界和都 > N ⇒ 矛盾（数字不可能满足）；
 *   规则 4 回路：不能提前闭环；闭环必须包含全部圆；不能把还没收完全部圆的路径提前闭合。
 * 反证（失败文字探测）只作为规则 1~4 推不动时的兜底，搜索器只作为最后兜底。
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

/** 传播规则标签：状态栏/基准脚本用它区分「哪条规则推出来的」 */
export interface RuleTag {
  id: number
  name: string
}

export const RULE_CELL: RuleTag = { id: 1, name: '单元格度数' }
export const RULE_CIRCLE: RuleTag = { id: 2, name: '圆方向' }
export const RULE_NUMBER: RuleTag = { id: 3, name: '数字两臂' }
export const RULE_LOOP: RuleTag = { id: 4, name: '回路闭合' }
export const RULE_PROBE: RuleTag = { id: 5, name: '反证' }
export const RULE_BACKTRACK: RuleTag = { id: 6, name: '回溯补全' }
export const RULE_ALIGN: RuleTag = { id: 7, name: '对齐初始盘面' }

/** 规则名（README / 回放状态栏共用） */
export const RULE_NAMES: Readonly<Record<number, string>> = {
  1: RULE_CELL.name,
  2: RULE_CIRCLE.name,
  3: RULE_NUMBER.name,
  4: RULE_LOOP.name,
  5: RULE_PROBE.name,
  6: RULE_BACKTRACK.name,
  7: RULE_ALIGN.name,
}

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
  /** 射线当前所在格（incomplete 时用于判断能不能继续延伸） */
  lastCell: number
  /** incomplete 时「继续直行」要用的边（未定；-1 = 不能延伸） */
  nextEdge: number
}

const INVALID: RayResult = {
  kind: 'invalid',
  distance: 0,
  minD: Number.POSITIVE_INFINITY,
  lastCell: -1,
  nextEdge: -1,
}

/**
 * 从圆心沿 dir 走，数到第一次转弯的格数。
 * 只有「已经确定」的格才继续走；遇到不确定处返回 incomplete 与下界。
 *
 * 关键细节：
 *  - 遇到白圆必须可直行（垂直方向不能有线），否则矛盾；
 *  - 到了边界/前方不能直行（边界或已标叉）的格，且它自己不能转 ⇒ 矛盾；
 *    能转 ⇒ 说明转弯就发生在该格（distance 精确）。
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
    if (ev === UNKNOWN) {
      return { kind: 'incomplete', distance: k, minD: k, lastCell: cur, nextEdge: step.edge }
    }
    const cell = step.next
    const code = puzzle.circles[cell] ?? 0
    if (code !== 0) {
      const color = circleColor(code)
      if (color === CIRCLE_BLACK) {
        return { kind: 'turn', distance: k, minD: k, lastCell: cell, nextEdge: -1 }
      }
      // 白圆必定直行：垂直方向已经有线 ⇒ 矛盾
      if (hasPerpendicularOn(values, layout, cell, dir)) return INVALID
      cur = cell
      continue
    }
    const { on, unk } = countsAt(values, layout, cell)
    if (on > 2) return INVALID
    if (on === 2) {
      // 判断两条线是否垂直：垂直 = 转弯
      if (isCornerPattern(values, layout, cell)) {
        return { kind: 'turn', distance: k, minD: k, lastCell: cell, nextEdge: -1 }
      }
      cur = cell
      continue
    }
    if (on === 1) {
      if (unk === 0) return INVALID
      const cont = edgeStep(layout, cell, dir)
      if (!cont || values[cont.edge] === OFF) {
        // 无法继续直行 ⇒ 只能在本格转弯（长度精确为 k）
        return { kind: 'turn', distance: k, minD: k, lastCell: cell, nextEdge: -1 }
      }
      if (values[cont.edge] === ON) {
        // 直行已确定（同轴对向）：继续走
        cur = cell
        continue
      }
      return { kind: 'incomplete', distance: k, minD: k, lastCell: cell, nextEdge: cont.edge }
    }
    return INVALID
  }
}

/** 该格在垂直 dir 的方向上是否已经有线（白圆直行检查用） */
function hasPerpendicularOn(
  values: ArrayLike<number>,
  layout: EdgeLayout,
  cell: number,
  dir: Dir,
): boolean {
  const base = cell * 4
  const vertical = dir === 0 || dir === 1
  const perp: Dir[] = vertical ? [2, 3] : [0, 1]
  for (const d of perp) {
    const e = layout.cellIncident[base + d]!
    if (e >= 0 && values[e] === ON) return true
  }
  return false
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

type Setter = (edge: number, value: number, tag?: RuleTag) => boolean

/** 单元格通用规则 + 圆方向规则（安全局部规则） */
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
        if (e >= 0 && values[e] === UNKNOWN && !set(e, OFF, RULE_CELL)) return false
      }
    } else if (on === 1) {
      if (unk === 0) return false
      if (unk === 1) {
        for (let d = 0; d < 4; d++) {
          const e = cellIncident[base + d]!
          if (e >= 0 && values[e] === UNKNOWN && !set(e, ON, RULE_CELL)) return false
        }
      }
    } else if (on === 0 && unk === 1) {
      for (let d = 0; d < 4; d++) {
        const e = cellIncident[base + d]!
        if (e >= 0 && values[e] === UNKNOWN && !set(e, OFF, RULE_CELL)) return false
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

    if (color === CIRCLE_BLACK) {
      // 黑圆：一横一竖各一条。边界上某个轴只剩一条可选边时，它必连。
      if (hEdges.length === 0 || vEdges.length === 0) return false
      if (hEdges.length === 1 && values[hEdges[0]!] === UNKNOWN && !set(hEdges[0]!, ON, RULE_CIRCLE)) {
        return false
      }
      if (vEdges.length === 1 && values[vEdges[0]!] === UNKNOWN && !set(vEdges[0]!, ON, RULE_CIRCLE)) {
        return false
      }
      const h = summarize(hEdges)
      const v = summarize(vEdges)
      if (h.on > 1 || v.on > 1) return false
      if (h.on === 1 && v.on === 1) continue
      if (h.on === 1) {
        if (v.unk === 0) return false
        if (v.unk === 1) {
          const e = vEdges.find((x) => values[x] === UNKNOWN)!
          if (!set(e, ON, RULE_CIRCLE)) return false
        }
        continue
      }
      if (v.on === 1) {
        if (h.unk === 0) return false
        if (h.unk === 1) {
          const e = hEdges.find((x) => values[x] === UNKNOWN)!
          if (!set(e, ON, RULE_CIRCLE)) return false
        }
        continue
      }
      // 两条都没画：每个轴至少还要有一条能连
      if (h.unk === 0 || v.unk === 0) return false
      continue
    }

    // 白圆：直线贯通
    const hFeasible = leftE >= 0 && rightE >= 0
    const vFeasible = upE >= 0 && downE >= 0
    if (!hFeasible && !vFeasible) return false
    const h = summarize(hEdges)
    const v = summarize(vEdges)
    if (h.on > 0 && v.on > 0) return false
    if (h.on > 0) {
      if (!hFeasible) return false
      for (const e of vEdges) {
        if (values[e] === UNKNOWN && !set(e, OFF, RULE_CIRCLE)) return false
      }
      for (const e of hEdges) {
        if (values[e] === OFF) return false
        if (values[e] === UNKNOWN && !set(e, ON, RULE_CIRCLE)) return false
      }
      continue
    }
    if (v.on > 0) {
      if (!vFeasible) return false
      for (const e of hEdges) {
        if (values[e] === UNKNOWN && !set(e, OFF, RULE_CIRCLE)) return false
      }
      for (const e of vEdges) {
        if (values[e] === OFF) return false
        if (values[e] === UNKNOWN && !set(e, ON, RULE_CIRCLE)) return false
      }
      continue
    }
    // 两条都没画：用可行性排除
    if (!hFeasible) {
      for (const e of vEdges) if (values[e] !== ON && !set(e, ON, RULE_CIRCLE)) return false
      continue
    }
    if (!vFeasible) {
      for (const e of hEdges) if (values[e] !== ON && !set(e, ON, RULE_CIRCLE)) return false
      continue
    }
    if (h.unk === 0) {
      for (const e of vEdges) if (values[e] !== ON && !set(e, ON, RULE_CIRCLE)) return false
      continue
    }
    if (v.unk === 0) {
      for (const e of hEdges) if (values[e] !== ON && !set(e, ON, RULE_CIRCLE)) return false
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
  let circleTotal = 0
  for (let i = 0; i < cells; i++) if ((puzzle.circles[i] ?? 0) !== 0) circleTotal++

  /** 每个格所属分量编号（-1 = 没有线） */
  const compId = new Int32Array(cells).fill(-1)
  const infos = new Map<number, { openEnds: number; circles: number }>()
  let components = 0
  let closedComponents = 0
  let closedHasAllCircles = false

  for (let start = 0; start < cells; start++) {
    if (compId[start] !== -1) continue
    if (degreeAt(values, layout, start) === 0) continue
    const id = components++
    compId[start] = id
    const queue = [start]
    let openEnds = 0
    let branch = false
    let circles = 0
    while (queue.length) {
      const cell = queue.pop()!
      const deg = degreeAt(values, layout, cell)
      if (deg === 1) openEnds++
      if (deg > 2) branch = true
      if ((puzzle.circles[cell] ?? 0) !== 0) circles++
      const base = cell * 4
      for (let d = 0; d < 4; d++) {
        const e = cellIncident[base + d]!
        if (e < 0 || values[e] !== ON) continue
        const other =
          layout.edgeCells[e * 2] === cell ? layout.edgeCells[e * 2 + 1]! : layout.edgeCells[e * 2]!
        if (compId[other] === -1) {
          compId[other] = id
          queue.push(other)
        }
      }
    }
    if (branch) return false
    infos.set(id, { openEnds, circles })
    if (openEnds === 0) {
      closedComponents++
      if (closedComponents > 1) return false
      if (circles !== circleTotal) {
        // 已闭环却漏了圆 → 矛盾
        return false
      }
      closedHasAllCircles = true
    }
  }

  if (closedComponents > 0) {
    if (components > 1) return false
    if (!closedHasAllCircles) return false
    // 回路已经唯一确定：其它所有未定边都不可能是回路的一部分
    for (let e = 0; e < layout.count; e++) {
      if (values[e] === UNKNOWN && !set(e, OFF, RULE_LOOP)) return false
    }
    return true
  }

  // 禁止提前闭环：两端落在同一分量里的未定边，只有「正好接上该分量的两个断头、
  // 且该分量已经包含全部圆」时才是合法闭合，其它一律断开（安全局部规则）。
  for (let e = 0; e < layout.count; e++) {
    if (values[e] !== UNKNOWN) continue
    const a = layout.edgeCells[e * 2]!
    const b = layout.edgeCells[e * 2 + 1]!
    if (compId[a] === -1 || compId[a] !== compId[b]) continue
    const info = infos.get(compId[a]!)!
    const validClose =
      info.openEnds === 2 &&
      degreeAt(values, layout, a) === 1 &&
      degreeAt(values, layout, b) === 1 &&
      info.circles === circleTotal
    if (!validClose && !set(e, OFF, RULE_LOOP)) return false
  }
  return true
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
      if (!set(step.edge, ON, RULE_NUMBER)) return false
    } else {
      return false
    }
  }
  const turnCell = step.next
  const cont = edgeStep(layout, turnCell, dir)
  if (cont) {
    if (values[cont.edge] === ON) return false
    if (!set(cont.edge, OFF, RULE_NUMBER)) return false
  }
  const code = puzzle.circles[turnCell] ?? 0
  if (code !== 0 && circleColor(code) === CIRCLE_WHITE) return false
  return true
}

/** 射线必须继续直行（数字还差得远，下一格不能转弯） */
function forceExtend(ray: RayResult, set: Setter): boolean {
  if (ray.kind !== 'incomplete' || ray.nextEdge < 0) return false
  const v = ray.nextEdge
  if (!set(v, ON, RULE_NUMBER)) return false
  return true
}

/** 把圆的两臂定死（两条臂必连、其余两条断开） */
function forceArms(
  values: number[],
  layout: EdgeLayout,
  cell: number,
  dirs: readonly [Dir, Dir],
  set: Setter,
): boolean {
  for (let d = 0; d < 4; d++) {
    const e = layout.cellIncident[cell * 4 + d]!
    if (e < 0) continue
    const want = d === dirs[0] || d === dirs[1] ? ON : OFF
    if (values[e] === UNKNOWN && !set(e, want, RULE_NUMBER)) return false
    if (values[e] !== want) return false
  }
  return true
}

interface ArmPair {
  dirs: [Dir, Dir]
  r1: RayResult
  r2: RayResult
  /** 两臂方向已经被已画的线定死（circleRayDirs） */
  known: boolean
}

/** 枚举一个圆所有可能的两臂方向组合 */
function armPairs(
  values: number[],
  layout: EdgeLayout,
  puzzle: ShingokiPuzzle,
  cell: number,
): ArmPair[] {
  const known = circleRayDirs(values, layout, puzzle, cell)
  if (known) {
    return [
      {
        dirs: known,
        r1: walkRay(values, layout, puzzle, cell, known[0]),
        r2: walkRay(values, layout, puzzle, cell, known[1]),
        known: true,
      },
    ]
  }
  const code = puzzle.circles[cell] ?? 0
  const color = circleColor(code)
  const base = cell * 4
  const out: ArmPair[] = []
  const add = (d1: Dir, d2: Dir): void => {
    out.push({
      dirs: [d1, d2],
      r1: walkRay(values, layout, puzzle, cell, d1),
      r2: walkRay(values, layout, puzzle, cell, d2),
      known: false,
    })
  }
  if (color === CIRCLE_BLACK) {
    const h: Dir[] = []
    const v: Dir[] = []
    if (layout.cellIncident[base + 2]! >= 0) h.push(2)
    if (layout.cellIncident[base + 3]! >= 0) h.push(3)
    if (layout.cellIncident[base]! >= 0) v.push(0)
    if (layout.cellIncident[base + 1]! >= 0) v.push(1)
    for (const hd of h) for (const vd of v) add(hd, vd)
  } else {
    // 白圆：只能整轴贯通
    if (layout.cellIncident[base + 2]! >= 0 && layout.cellIncident[base + 3]! >= 0) add(2, 3)
    if (layout.cellIncident[base]! >= 0 && layout.cellIncident[base + 1]! >= 0) add(0, 1)
  }
  return out
}

/**
 * 数字规则：两臂到第一次转弯的长度和 = N。
 * 只做可证明的安全推理（不猜答案）：
 *   a) 两臂下界和 = N ⇒ 两臂分别在最小距离处强制转弯；
 *   b) 一臂长度已确定 ⇒ 另一臂长度随之确定（差得远就强制延伸，超出即矛盾）；
 *   c) 候选两臂组合只剩一种能凑出 N ⇒ 两臂方向定死（边界圆 / 数字很小的时候很有效）；
 *   d) 所有候选组合的下界和都 > N ⇒ 矛盾。
 */
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
    const pairs = armPairs(values, layout, puzzle, cell)
    if (pairs.length === 0) return false

    const live: Array<{ pair: ArmPair; minSum: number; exactSum: number }> = []
    for (const pair of pairs) {
      const { r1, r2 } = pair
      if (r1.kind === 'invalid' || r2.kind === 'invalid') {
        if (pair.known) return false
        continue
      }
      const minSum = r1.minD + r2.minD
      if (r1.kind === 'turn' && r2.kind === 'turn') {
        const sum = r1.distance + r2.distance
        if (sum !== n) {
          if (pair.known) return false
          continue
        }
        live.push({ pair, minSum, exactSum: sum })
        continue
      }
      if (minSum > n) {
        if (pair.known) return false
        continue
      }
      live.push({ pair, minSum, exactSum: -1 })
    }

    if (live.length === 0) return false
    if (live.length === 1) {
      const only = live[0]!
      if (only.exactSum >= 0) continue
      if (!only.pair.known) {
        // 候选两臂组合只剩一种能凑出 N ⇒ 两臂方向定死；
        // 落子后下一轮传播会以「已知两臂」重新做长度推理。
        if (!forceArms(values, layout, cell, only.pair.dirs, set)) return false
        continue
      }
      // 两臂方向已由已画的线定死：按长度做安全推理
      const { r1, r2, dirs } = only.pair
      if (r1.kind === 'turn' && r2.kind === 'incomplete') {
        const need = n - r1.distance
        if (need < r2.minD) return false
        if (need === r2.minD) {
          if (!forceTurn(values, layout, puzzle, cell, dirs[1], r2.minD, set)) return false
        } else if (!forceExtend(r2, set)) {
          return false
        }
        continue
      }
      if (r2.kind === 'turn' && r1.kind === 'incomplete') {
        const need = n - r2.distance
        if (need < r1.minD) return false
        if (need === r1.minD) {
          if (!forceTurn(values, layout, puzzle, cell, dirs[0], r1.minD, set)) return false
        } else if (!forceExtend(r1, set)) {
          return false
        }
        continue
      }
      // 两臂都还没到转弯：下界和正好等于 N ⇒ 两边都在最小距离处转弯
      if (r1.kind === 'incomplete' && r2.kind === 'incomplete' && only.minSum === n) {
        if (!forceTurn(values, layout, puzzle, cell, dirs[0], r1.minD, set)) return false
        if (!forceTurn(values, layout, puzzle, cell, dirs[1], r2.minD, set)) return false
      }
      continue
    }
    // 多个候选组合都能凑出 N：逐个组合去定死方向并不安全（互相排斥），
    // 所以这里只做「所有组合都不可能」的矛盾判定，交给下一轮更具体的线索。
  }
  return true
}

/**
 * 把 values 上的已知条件传播到不动点。
 * 返回 false 表示矛盾；onSet 回调用于逻辑回放记录每一步（带规则标签）。
 */
export function propagate(
  values: number[],
  puzzle: ShingokiPuzzle,
  onSet?: (edge: number, value: number, tag?: RuleTag) => void,
): boolean {
  const layout = layoutFor(puzzle)
  let changed = true
  const set: Setter = (edge, value, tag) => {
    if (values[edge] === value) return true
    if (values[edge] !== UNKNOWN) return false
    values[edge] = value
    onSet?.(edge, value, tag)
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
