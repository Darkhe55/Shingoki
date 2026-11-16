/**
 * 信号旗 —— 题库
 *
 * RAW_PUZZLES 由 scripts/gen-puzzles.mjs 自动生成（npm run gen）。
 * board：圆编码串，两种兼容格式（见 types.ts 的 decodeCircles）：
 *   - 紧凑格式（旧题库）：每格 1 个字符，'.' = 空格，
 *     'a'..'j' = 黑圆（无数字 / 1..9），'k'..'t' = 白圆（无数字 / 1..9）；
 *   - 宽格式：只要题面里出现 ≥10 的圆内数字，就变成每格 2 个 base36 字符
 *     （'..' = 空格），可表示 0..99。解码按字符串长度自动识别。
 * solution：每条边一个字符，'1' = 回路经过，'0' = 不经过。
 */

import type { Difficulty, GameState, Puzzle } from '../core/types'
import { RAW_PUZZLES } from './puzzles-data.ts'
import {
  decodeCircles,
  decodeSolution,
  edgesFromSolution,
  layoutFor,
  type ShingokiPuzzle,
  type ShingokiState,
} from './types.ts'

export interface RawPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: Difficulty
  series?: string
  board: string
  solution: string
}

export function decodePuzzle(raw: RawPuzzle): ShingokiPuzzle | null {
  const expected = raw.width * raw.height
  const circles = decodeCircles(raw.board, expected)
  if (!circles) return null
  return {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    difficulty: raw.difficulty,
    circles,
    solutionEdges: raw.solution,
  }
}

export const builtinPuzzles: Puzzle[] = (RAW_PUZZLES as RawPuzzle[])
  .map(decodePuzzle)
  .filter((p): p is ShingokiPuzzle => p !== null)

export function getReferenceSolution(id: string): GameState | null {
  const raw = (RAW_PUZZLES as RawPuzzle[]).find((p) => p.id === id)
  if (!raw || typeof raw.solution !== 'string') return null
  const puzzle = decodePuzzle(raw)
  if (!puzzle) return null
  const layout = layoutFor(puzzle)
  const values = decodeSolution(raw.solution, layout.count)
  if (!values) return null
  const state: ShingokiState = {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    edges: edgesFromSolution(values),
  }
  return state
}

export function getRawPuzzle(id: string): RawPuzzle | null {
  return (RAW_PUZZLES as RawPuzzle[]).find((p) => p.id === id) ?? null
}
