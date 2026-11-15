/**
 * 信号旗 —— 实时校验
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'
import { checkSolution, valuesFromState, type ShingokiCheck } from './rules'
import { asShingokiPuzzle, asShingokiState } from './types'

export interface ShingokiResult extends ValidationResult {
  badCells: number[]
  openCells: number[]
  branchCells: number[]
  componentCount: number
  onEdges: number
  closedLoop: boolean
  circleMissing: number[]
  badOrientation: number[]
  badNumber: Array<{ cell: number; expected: number; actual: number }>
}

export function validate(state: GameState, puzzle: Puzzle): ShingokiResult {
  const p = asShingokiPuzzle(puzzle)
  const s = asShingokiState(state)
  const check: ShingokiCheck = checkSolution(valuesFromState(s), p)
  return {
    solved: check.ok,
    badCells: check.badCells,
    openCells: check.openCells,
    branchCells: check.branchCells,
    componentCount: check.componentCount,
    onEdges: check.onEdges,
    closedLoop: check.closedLoop,
    circleMissing: check.circleMissing,
    badOrientation: check.badOrientation,
    badNumber: check.badNumber,
  }
}

export function statusBits(result: ValidationResult): string[] {
  const r = result as ShingokiResult
  if (r.solved) return ['完成：单一闭环，所有圆与数字都满足']
  const bits: string[] = []
  if (r.onEdges === 0) {
    bits.push('在格心之间画线，组成经过所有圆的单一闭环')
    return bits
  }
  if (r.branchCells.length > 0) bits.push(`${r.branchCells.length} 处分叉（一个格点最多两条线）`)
  if (r.openCells.length > 0) bits.push(`${r.openCells.length} 处断路（线头还没接上）`)
  if (r.componentCount > 1) bits.push(`线断成了 ${r.componentCount} 段，需连成一个闭环`)
  if (r.circleMissing.length > 0) bits.push(`${r.circleMissing.length} 个圆还没被回路经过`)
  if (r.badOrientation.length > 0) {
    bits.push(`${r.badOrientation.length} 个圆方向不对（黑圆须转弯、白圆须直行）`)
  }
  if (r.badNumber.length > 0) {
    const first = r.badNumber[0]!
    bits.push(`${r.badNumber.length} 个圆数字不符（最近一处：应为 ${first.expected}，实为 ${first.actual}）`)
  }
  if (bits.length === 0) {
    bits.push(r.closedLoop ? '继续完善' : '继续画线，把线头接起来')
  }
  return bits
}
