/**
 * 信号旗 —— 浏览器实测（Playwright + Edge）
 *
 * 用法：
 *   1) npm run dev（或 npm start）启动 http://127.0.0.1:5216
 *   2) node scripts/verify-game.mjs
 *
 * 验证内容：
 *   - 内置题：≥6 题、参考解全部通过校验、逻辑解题回放能解完、显示解正确
 *   - 鼠标：点击画线、右键标叉、拖拽连续画线
 *   - 键盘：方向键移动光标、空格切换、X 标叉、撤销/重做
 *   - 自定义题板：调色板放置圆 → 保存到题库 → 编辑 → 删除
 *   - 截图输出到 output/playwright/
 */

import { chromium } from 'playwright-core'
import { PORT } from './_port.mjs'

const executablePath =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const OUT = 'output/playwright'

const failures = []
const notes = []
function check(name, ok, detail = '') {
  if (ok) {
    notes.push(`✓ ${name}${detail ? ' · ' + detail : ''}`)
    console.log(`✓ ${name}${detail ? ' · ' + detail : ''}`)
  } else {
    failures.push(`${name}${detail ? ' · ' + detail : ''}`)
    console.error(`✗ ${name}${detail ? ' · ' + detail : ''}`)
  }
}

const browser = await chromium.launch({ headless: true, executablePath })
const page = await browser.newPage({ viewport: { width: 1280, height: 940 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (msg) => {
  if (msg.type() !== 'error') return
  if (/favicon\.ico/.test(msg.text())) return
  pageErrors.push(`console: ${msg.text()}`)
})

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
await page.waitForSelector('svg.board-svg')
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/01-initial.png`, fullPage: true })

/* ───────────── 1. 内置题 & 参考解 ───────────── */

const puzzleInfo = await page.evaluate(() => {
  const g = window.__game
  const a = g.adapter
  return a.builtinPuzzles.map((p) => {
    const sol = a.getReferenceSolution(p.id)
    const r = sol ? a.validate(sol, p) : null
    return {
      id: p.id,
      name: p.name,
      size: `${p.width}x${p.height}`,
      solved: r?.solved ?? false,
      circles: p.circles ? p.circles.filter((c) => c !== 0).length : 0,
    }
  })
})
const listCount = await page.locator('.puzzle-item').count()
check('内置题数量 ≥ 6', puzzleInfo.length >= 6, `${puzzleInfo.length} 题`)
check('题库列表渲染', listCount >= 6, `${listCount} 行`)
check(
  '全部参考解通过校验',
  puzzleInfo.every((p) => p.solved),
  puzzleInfo.map((p) => `${p.name}(${p.size},${p.circles}圆)`).join(' / '),
)

// 逐题确认「检查」按钮在参考解下判为完成
const perPuzzle = []
for (const p of puzzleInfo) {
  const ok = await page.evaluate((id) => {
    const g = window.__game
    const puzzle = g.adapter.builtinPuzzles.find((x) => x.id === id)
    const sol = g.adapter.getReferenceSolution(id)
    return !!sol && g.adapter.validate(sol, puzzle).solved
  }, p.id)
  perPuzzle.push(ok)
}
check('逐题参考解校验', perPuzzle.every(Boolean))

/* ───────────── 2. 选择第一题（鼠标/键盘在干净盘面上测） ───────────── */

const first = page.locator('.puzzle-item').first()
await first.click()
await page.waitForTimeout(150)
await page.click('#btn-clear')
await page.waitForTimeout(120)
await page.screenshot({ path: `${OUT}/02-puzzle-loaded.png`, fullPage: true })

/** 计算某条边中点在页面上的坐标 */
async function edgePoint(index) {
  return page.evaluate((idx) => {
    const g = window.__game
    const s = g.getSession()
    const p = s.puzzle
    const m = g.adapter.metricsFor(p)
    const w = p.width
    const h = p.height
    const hCount = h * (w - 1)
    let a
    let b
    if (idx < hCount) {
      const y = Math.floor(idx / (w - 1))
      const x = idx % (w - 1)
      a = y * w + x
      b = a + 1
    } else {
      const v = idx - hCount
      const y = Math.floor(v / w)
      const x = v % w
      a = y * w + x
      b = a + w
    }
    const ox = m.originX ?? m.pad
    const oy = m.originY ?? m.pad
    const cw = m.cellW ?? m.cell
    const ch = m.cellH ?? m.cell
    const ax = ox + ((a % w) + 0.5) * cw
    const ay = oy + (Math.floor(a / w) + 0.5) * ch
    const bx = ox + ((b % w) + 0.5) * cw
    const by = oy + (Math.floor(b / w) + 0.5) * ch
    const svg = document.querySelector('svg.board-svg')
    const rect = svg.getBoundingClientRect()
    const vb = svg.viewBox.baseVal
    const sx = rect.width / vb.width
    const sy = rect.height / vb.height
    const toScreen = (x, y) => ({
      x: rect.left + (x - vb.x) * sx,
      y: rect.top + (y - vb.y) * sy,
    })
    const pa = toScreen(ax, ay)
    const pb = toScreen(bx, by)
    return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, sx, sy }
  }, index)
}

async function edgeValue(index) {
  return page.evaluate((i) => window.__game.getSession().state.edges[i], index)
}

const canvasBox = await page.locator('svg.board-svg').boundingBox()
check('棋盘可见', !!canvasBox && canvasBox.width > 100, canvasBox ? `${Math.round(canvasBox.width)}px 宽` : '无')

// —— 鼠标左键点击画线 ——
const e0 = await edgePoint(0)
await page.mouse.click(e0.x, e0.y)
await page.waitForTimeout(120)
const v0 = await edgeValue(0)
check('鼠标左键画线（未定→画线）', v0 === 1, `edge0 = ${v0}`)

// 再点一次 → 标叉；再点一次 → 清除
await page.mouse.click(e0.x, e0.y)
await page.waitForTimeout(100)
const v0b = await edgeValue(0)
await page.mouse.click(e0.x, e0.y)
await page.waitForTimeout(100)
const v0c = await edgeValue(0)
check('鼠标再点循环（画线→标叉→清除）', v0b === 2 && v0c === 0, `${v0b} → ${v0c}`)

// —— 鼠标右键标叉 ——
const e1 = await edgePoint(1)
await page.mouse.click(e1.x, e1.y, { button: 'right' })
await page.waitForTimeout(120)
const v1 = await edgeValue(1)
check('鼠标右键标叉', v1 === 2, `edge1 = ${v1}`)

// 右键再点清除
await page.mouse.click(e1.x, e1.y, { button: 'right' })
await page.waitForTimeout(100)
const v1b = await edgeValue(1)
check('鼠标右键再点清除', v1b === 0, `edge1 = ${v1b}`)

// —— 拖拽连续画线（沿同一行拖动，命中一串水平边） ——
await page.click('#btn-clear')
await page.waitForTimeout(100)
const e2 = await edgePoint(0)
const e5 = await edgePoint(2)
await page.mouse.move(e2.x, e2.y)
await page.mouse.down()
await page.mouse.move(e5.x, e5.y, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(120)
const dragged = await page.evaluate(() => {
  const edges = window.__game.getSession().state.edges
  return edges.reduce((acc, v, i) => (v === 1 ? [...acc, i] : acc), [])
})
check('鼠标拖拽连续画线', dragged.length >= 2, `画到边 ${dragged.join(',')}`)
const openMarks = await page.locator('svg.board-svg .sk-open').count()
const dragStatus = await page.locator('#status').textContent()
check('错误高亮：断路端点', openMarks >= 2, `.sk-open = ${openMarks}`)
check('状态栏实时校验提示', (dragStatus || '').includes('断路'), (dragStatus || '').slice(0, 40))
await page.screenshot({ path: `${OUT}/03-mouse-drag.png`, fullPage: true })

const uniqueAudit = await page.evaluate(() => {
  const a = window.__game.adapter
  if (!a.countSolutions) return null
  return a.builtinPuzzles.map((p) => a.countSolutions(p, 2).count)
})
check('求解器唯一解校验接口', Array.isArray(uniqueAudit) && uniqueAudit.every((c) => c === 1), JSON.stringify(uniqueAudit))

/* ───────────── 3. 键盘：方向键 / 空格 / X / 撤销重做 ───────────── */

await page.click('#btn-clear')
await page.waitForTimeout(100)
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(120)
const cursorVisible = await page.locator('svg.board-svg .sk-cursor').count()
check('键盘方向键显示光标', cursorVisible === 1)

// 光标从 0 右移到 1，再左移回 0，在 edge0 上测切换
await page.keyboard.press('ArrowLeft')
await page.waitForTimeout(80)
const kBefore = await page.evaluate(() => {
  const st = window.__game.getSession()
  const edges = st.state.edges
  return { initial: edges[0], edges }
})
await page.keyboard.press('Space')
await page.waitForTimeout(120)
const kAfterSpace = await edgeValue(0)
check('键盘空格切换画线', kAfterSpace === 1, `edges[0]: ${kBefore.initial} → ${kAfterSpace}`)
await page.keyboard.press('x')
await page.waitForTimeout(120)
const kAfterX = await edgeValue(0)
check('键盘 X 标叉', kAfterX === 2, `edges[0] = ${kAfterX}`)
await page.keyboard.press('Backspace')
await page.waitForTimeout(120)
const kAfterBackspace = await edgeValue(0)
check('键盘退格切换', kAfterBackspace === 0, `edges[0] = ${kAfterBackspace}`)

// 空格画线后再撤销/重做
await page.keyboard.press(' ')
await page.waitForTimeout(80)
await page.keyboard.press('z')
await page.waitForTimeout(120)
const afterUndo = await edgeValue(0)
await page.keyboard.press('Shift+z')
await page.waitForTimeout(120)
const afterRedo = await edgeValue(0)
check('键盘撤销 / 重做', afterUndo === 0 && afterRedo === 1, `undo=${afterUndo} redo=${afterRedo}`)
await page.screenshot({ path: `${OUT}/04-keyboard.png`, fullPage: true })

/* ───────────── 4. 提示一格 / 检查 / 显示解 ───────────── */

await page.click('#btn-clear')
await page.waitForTimeout(100)
await page.click('#btn-hint')
await page.waitForTimeout(200)
const hintStatus = await page.locator('#status').textContent()
const hintEdges = await page.evaluate(() => window.__game.getSession().state.edges.filter((v) => v === 1).length)
check('提示一格', hintEdges >= 1, `状态：${(hintStatus || '').slice(0, 30)}`)

await page.click('#btn-check')
await page.waitForTimeout(150)
const checkStatus = await page.locator('#status').textContent()
check('检查按钮有反馈', !!checkStatus && checkStatus.length > 0)

await page.click('#btn-solve')
await page.waitForTimeout(400)
const solvedByShow = await page.evaluate(() => {
  const g = window.__game
  const s = g.getSession()
  return g.adapter.validate(s.state, s.puzzle).solved
})
check('显示解通过校验', solvedByShow)
await page.click('#btn-check')
await page.waitForTimeout(150)
const solvedStatus = await page.locator('#status').textContent()
check('完成后检查文案', (solvedStatus || '').includes('正确'), solvedStatus || '')
await page.screenshot({ path: `${OUT}/05-solved.png`, fullPage: true })

/* ───────────── 5. 逻辑解题回放（从空盘开始） ───────────── */

await page.click('#btn-clear')
await page.waitForTimeout(150)
const t0 = Date.now()
await page.click('#btn-logic')
await page.waitForFunction(
  () => {
    const btn = document.querySelector('#btn-logic')
    return !!btn && !btn.disabled && btn.textContent === '逻辑解题'
  },
  { timeout: 180_000 },
)
await page.waitForTimeout(300)
const afterLogic = await page.evaluate(() => {
  const g = window.__game
  const s = g.getSession()
  return {
    solved: g.adapter.validate(s.state, s.puzzle).solved,
    status: document.querySelector('#status').textContent,
  }
})
check('逻辑解题回放解完', afterLogic.solved, `${Date.now() - t0}ms · ${(afterLogic.status || '').slice(0, 40)}`)
await page.screenshot({ path: `${OUT}/06-logic.png`, fullPage: true })

/* ───────────── 6. 自定义题板：放置 → 保存 → 编辑 → 删除 ───────────── */

await page.click('#btn-custom')
await page.waitForTimeout(200)
const paletteCount = await page.locator('#custom-palette .custom-brush').count()
check('调色板渲染', paletteCount >= 12, `${paletteCount} 个画笔`)

await page.fill('#custom-w', '6')
await page.fill('#custom-h', '6')
await page.click('#custom-regen')
await page.waitForTimeout(150)
const cellCount = await page.locator('#custom-grid .custom-cell').count()
check('自定义网格 6×6', cellCount === 36, `${cellCount} 格`)

async function pickBrush(index) {
  await page.locator(`#custom-palette .custom-brush[data-brush="${index}"]`).click()
  await page.waitForTimeout(60)
}
async function paintCell(i) {
  await page.locator(`#custom-grid .custom-cell[data-i="${i}"]`).click()
  await page.waitForTimeout(60)
}

// 0 = 空，1 = 黑无数字，3 = 黑2，12 = 白无数字，14 = 白2
await pickBrush(3) // 黑 2
await paintCell(0)
await paintCell(7)
await pickBrush(14) // 白 2
await paintCell(14)
await paintCell(21)
await pickBrush(13) // 白 1
await paintCell(28)
const cellText = await page.locator('#custom-grid .custom-cell[data-i="0"]').textContent()
const cellClass = await page.locator('#custom-grid .custom-cell[data-i="0"]').getAttribute('class')
check('调色板放置圆', cellText === '2' && (cellClass || '').includes('circle-black'), `i0 文本=${cellText}`)
await page.screenshot({ path: `${OUT}/07-custom-editor.png`, fullPage: true })

// 载入（同时入库）→ 保存
await page.click('#custom-apply')
await page.waitForTimeout(300)
const customCountAfterLoad = await page.locator('.puzzle-item .title', { hasText: '自定义' }).count()
check('自定义题载入并入库', customCountAfterLoad >= 1, `${customCountAfterLoad} 条自定义题`)

await page.click('#custom-save')
await page.waitForTimeout(300)
const customId = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('[data-edit]'))
  return els.length ? els[els.length - 1].getAttribute('data-edit') : null
})
check('自定义题保存到题库（可编辑）', !!customId, customId || '无')

// 刷新页面：验证题库确实落盘（开发服务器写 data/library.json）
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('svg.board-svg')
await page.waitForTimeout(300)
const afterReload = await page.locator('.puzzle-item .title', { hasText: '自定义' }).count()
check('自定义题刷新后仍在题库（持久化）', afterReload >= 1, `${afterReload} 条`)
const persistedId = await page.evaluate(() => {
  const el = document.querySelector('[data-edit]')
  return el ? el.getAttribute('data-edit') : null
})
const editId = persistedId ?? customId

// 编辑：重新打开后应还原题面
if (editId) {
  await page.evaluate((id) => {
    document.querySelector(`[data-edit="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, editId)
  await page.waitForTimeout(250)
  const restored = await page.locator('#custom-grid .custom-cell[data-i="0"]').textContent()
  const restoredCells = await page.locator('#custom-grid .custom-cell').count()
  check('编辑自定义题还原题面', restored === '2' && restoredCells === 36, `i0=${restored}, ${restoredCells} 格`)
  // 改一格再保存
  await pickBrush(2) // 黑 1
  await paintCell(35)
  await page.click('#custom-save')
  await page.waitForTimeout(250)
  const stillOne = await page.locator('.puzzle-item .title', { hasText: '自定义' }).count()
  check('编辑后保存不重复', stillOne === afterReload, `${stillOne} 条`)
  await page.screenshot({ path: `${OUT}/08-custom-edit.png`, fullPage: true })

  // 删除（第一次点确认，第二次删除）
  await page.evaluate((id) => {
    document.querySelector(`[data-del="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, editId)
  await page.waitForTimeout(150)
  const confirmText = await page.evaluate((id) => {
    const el = document.querySelector(`[data-del="${id}"]`)
    return el ? el.textContent : null
  }, editId)
  await page.evaluate((id) => {
    document.querySelector(`[data-del="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, editId)
  await page.waitForTimeout(250)
  const customAfterDelete = await page.locator('.puzzle-item .title', { hasText: '自定义' }).count()
  check('自定义题删除（含二次确认）', confirmText === '确认' && customAfterDelete === 0, `确认按钮=${confirmText}, 剩余=${customAfterDelete}`)
  await page.screenshot({ path: `${OUT}/09-custom-deleted.png`, fullPage: true })

  // 删除也落盘
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('svg.board-svg')
  await page.waitForTimeout(250)
  const afterDeleteReload = await page.locator('.puzzle-item .title', { hasText: '自定义' }).count()
  check('自定义题删除后刷新仍不存在', afterDeleteReload === 0, `${afterDeleteReload} 条`)
}

/* ───────────── 7. 开发期 /__audit 审计页 ───────────── */

await page.goto(`http://127.0.0.1:${PORT}/__audit`, { waitUntil: 'networkidle' })
await page.waitForFunction(
  () => {
    const el = document.getElementById('out')
    return !!el && !!el.textContent && el.textContent.includes('共 6 题')
  },
  { timeout: 120_000 },
)
const auditText = (await page.locator('#out').textContent()) || ''
const auditLine = auditText.split('\n').slice(-1)[0] || ''
check(
  '开发期 /__audit 审计页',
  /参考解非法 0/.test(auditText) && !/缺参考解/.test(auditText),
  auditLine,
)
await page.screenshot({ path: `${OUT}/10-audit.png`, fullPage: true })

/* ───────────── 收尾 ───────────── */

check('页面无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

const report = {
  puzzles: puzzleInfo,
  notes,
  failures,
  pageErrors,
  screenshots: [
    '01-initial.png',
    '02-puzzle-loaded.png',
    '03-mouse-drag.png',
    '04-keyboard.png',
    '05-solved.png',
    '06-logic.png',
    '07-custom-editor.png',
    '08-custom-edit.png',
    '09-custom-deleted.png',
    '10-audit.png',
  ],
}
console.log('\n===== REPORT =====')
console.log(JSON.stringify(report, null, 2))

await browser.close()
if (failures.length || pageErrors.length) process.exitCode = 1
console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL OK')
