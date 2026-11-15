/**
 * 信号旗 —— 逻辑解题
 *
 * 推理期一次性算完计划（不落子），回放期由 core/playback 逐帧 pushMove。
 *
 * 推理规则：
 *  1. 单元格规则（度只能 0 / 2，圆必须经过）
 *  2. 圆方向规则（黑圆转弯、白圆直行）
 *  3. 回路规则（不能提前闭环；闭环后其余边全部排除）
 *  4. 数字规则（两臂之和 = 圆内数字，含下界/上界推理）
 *  5. 反证法（假设一条边，若规则传播矛盾则取其反面）
 * 若规则推不到底（极少），退回求解器补全剩余边，并在计划里标记 saturated = false。
 */

import type { GameState, LogicPlan, Move, PlaybackFrame, Puzzle } from '../core/types'
import {
  checkSolution,
  edgesFromValues,
  OFF,
  ON,
  propagate,
  UNKNOWN,
  valuesFromState,
} from './rules.ts'
import { findSolutionFrom } from './solver.ts'
import { asShingokiPuzzle, asShingokiState, type ShingokiState } from './types.ts'

/** 反证法最多尝试的传播次数（避免自定义大盘卡住 UI） */
const MAX_PROBE_PROPAGATIONS = 40_000

export function planLogicSolve(puzzle: Puzzle, initialState: GameState): LogicPlan {
  const p = asShingokiPuzzle(puzzle)
  const start = asShingokiState(initialState)
  const values = valuesFromState(start)
  const frames: PlaybackFrame[] = []
  /** 回放起点等于当前盘面，逐帧维护「上一帧后的状态」以便给出正确的 from */
  const current = start.edges.slice()
  let lastRule = -1
  let streak = 0
  let propagations = 0

  const record = (edge: number, value: number, rule: number, label: string): void => {
    const encoded = value === ON ? 1 : 2
    const from = current[edge] ?? 0
    if (from === encoded) return
    current[edge] = encoded
    // 直接推理（rule 1/2）算同一组连拍，回放会逐步加速
    const group = rule <= 2 ? 2 : rule
    if (group === lastRule) streak++
    else {
      lastRule = group
      streak = 1
    }
    frames.push({ rule, label, move: { index: edge, from, to: encoded }, streak })
  }

  const runPropagate = (target: number[], recordIt = true): boolean => {
    propagations++
    return propagate(target, p, (e, v) => {
      if (!recordIt) return
      record(e, v, v === ON ? 1 : 2, v === ON ? '此边属于回路' : '此边不在回路上')
    })
  }

  const emptyPlan = (): LogicPlan => ({
    puzzleId: p.id,
    frames: [],
    finalState: null,
    ruleSteps: 0,
    saturated: false,
  })

  if (!runPropagate(values)) return emptyPlan()

  let saturated = true
  let guard = 0
  while (values.some((v) => v === UNKNOWN)) {
    if (++guard > 4000) {
      saturated = false
      break
    }
    let progress = false
    for (let e = 0; e < values.length && !progress; e++) {
      if (values[e] !== UNKNOWN) continue
      if (propagations > MAX_PROBE_PROPAGATIONS) break
      const trialOn = values.slice()
      trialOn[e] = ON
      const onOk = runPropagate(trialOn, false)
      const trialOff = values.slice()
      trialOff[e] = OFF
      const offOk = runPropagate(trialOff, false)
      if (!onOk && !offOk) return emptyPlan()
      if (!onOk || !offOk) {
        const forced = onOk ? ON : OFF
        values[e] = forced
        record(e, forced, 3, onOk ? '反证法：若排除此边则矛盾，故必画线' : '反证法：若画此边则矛盾，故排除')
        if (!runPropagate(values)) return emptyPlan()
        progress = true
      }
    }
    if (!progress) {
      saturated = false
      break
    }
  }

  if (!saturated) {
    const sol = findSolutionFrom(p, values.slice(), 2_000_000, 20_000)
    if (!sol) return emptyPlan()
    for (let e = 0; e < values.length; e++) {
      if (values[e] !== UNKNOWN) continue
      values[e] = sol[e]!
      record(e, values[e]!, 4, '回溯试探：该边的最终状态')
    }
    if (!runPropagate(values)) return emptyPlan()
  }

  const finalValues = values.map((v) => (v === ON ? ON : OFF))
  const check = checkSolution(finalValues, p)
  if (!check.ok) return emptyPlan()

  const finalState: ShingokiState = {
    puzzleId: p.id,
    width: p.width,
    height: p.height,
    edges: edgesFromValues(finalValues),
  }

  // 兜底：如果初始盘面已有与计划不同的线段，补上直接修正帧
  for (let e = 0; e < finalValues.length; e++) {
    const want = finalValues[e] === ON ? 1 : 2
    const from = start.edges[e] ?? 0
    if (from === want) continue
    if (frames.some((f) => f.move.index === e)) continue
    if (lastRule === 5) streak++
    else {
      lastRule = 5
      streak = 1
    }
    frames.push({ rule: 5, label: '与初始标记对齐', move: { index: e, from, to: want }, streak })
  }

  return {
    puzzleId: p.id,
    frames,
    finalState,
    ruleSteps: frames.length,
    saturated,
  }
}

/** 逻辑推理能否在「纯规则」下解完（check 脚本用） */
export function logicPlanIsPure(plan: LogicPlan): boolean {
  return plan.saturated && plan.frames.every((f) => f.rule !== 4)
}

/** 从参考解生成一个 Move 列表（调试用） */
export function diffMoves(state: GameState, solution: GameState): Move[] {
  const s = asShingokiState(state)
  const sol = asShingokiState(solution)
  const out: Move[] = []
  for (let i = 0; i < s.edges.length; i++) {
    if ((s.edges[i] ?? 0) !== (sol.edges[i] ?? 0)) {
      out.push({ index: i, from: s.edges[i] ?? 0, to: sol.edges[i] ?? 0 })
    }
  }
  return out
}
