/* 自动生成，勿手改。运行 npm run gen 重新生成。 */
export interface RawPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
  series: string
  /** 题面编码串（格式由 src/game/puzzles.ts 解析） */
  board: string
  /** 参考解编码串（没有则留空） */
  solution?: string
}

export const RAW_PUZZLES: RawPuzzle[] = [
  { id: "shingoki-6x6-n3vugx", name: "初识信号旗", width: 6, height: 6, difficulty: "easy", series: "入门", board: ".ppppg....cc.gnn..pn.....n..........", solution: "111110000101110000000000010000100001100010110000110000110000" },
  { id: "shingoki-6x6-n3vugy", name: "两侧灯语", width: 6, height: 6, difficulty: "easy", series: "入门", board: "j.pp..o...mdoem...o.....f...........", solution: "111110001101100000001000000000100001100100110000110000000000" },
  { id: "shingoki-7x7-n3vugz", name: "转角旗杆", width: 7, height: 7, difficulty: "medium", series: "进阶", board: ".q..q........qn..nnh.f.d...q......q.....oq.....f.", solution: "111111000000001110110000000000000000000001100000110000011010011000001100000110000011" },
  { id: "shingoki-8x7-n3vuh0", name: "环线迷阵", width: 8, height: 7, difficulty: "medium", series: "进阶", board: "jrr...rj.......mj...r.rj................................", solution: "1111111000000011111110000000000000000000000000000100000011000000100000000000000000000000000000000" },
  { id: "shingoki-8x8-n3vuh1", name: "黑旗矩阵", width: 8, height: 8, difficulty: "hard", series: "挑战", board: "..r.r..i....enn.ri..e....p..............r.......r.......ig......", solution: "1111111000011101110000000000000000000000000000000100000010000001100010001100000011000000110000001100000011000000" },
  { id: "shingoki-9x8-n3vuh2", name: "终局信号", width: 9, height: 8, difficulty: "hard", series: "挑战", board: ".s.s...s.........mn...p...hgn.e.........................................", solution: "1111111100000000000111111110000000000000000000000000000000000000100000001100000001100100000000000000000000000000000000000000000" },
]
