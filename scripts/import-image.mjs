/**
 * 信号旗（Shingoki）题面图片自动导入
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--name 名称] [--append] [--verify]
 *                                   [--width 41 --height 41] [--map 0=1,1=3] [--dry]
 *                                   [--max-nodes 400000] [--verify-timeout 120000]
 *
 * 流程：
 *   1. Playwright + Edge 把图片画到 canvas 取像素；
 *   2. 全图连通域：小圆点=格心标记 → 聚类得到 W×H 网格；
 *   3. 大连通域是圆：填充率高=黑圆（白字），环形=白圆（黑字）；
 *   4. 圆内像素做 20×20 归一化，多套字体模板自动择优 + 字形簇识别数字（0..99，含两位数）；
 *   5. 预览圆点布局；--append 写入 src/game/puzzles-data.ts；
 *   6. --verify 在子进程里用项目求解器检查唯一解（超时/崩溃只警告）。
 *
 * 编码：直接复用 src/game/types.ts 的 makeCircle / encodeCircles，
 *   0..9 仍是旧的 10+n / 20+n 紧凑单字符编码，≥10 时自动切到 100+n / 200+n
 *   的两位数字扩展编码（board 串相应变为每格 2 字符）。旧题库完全不受影响。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import {
  encodeCircles,
  makeCircle,
  MAX_CIRCLE_NUMBER,
} from '../src/game/types.ts'

const EDGE_PATH =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const NORM = 20
const CLUSTER_SIM = 0.86

/** matplotlib/PIL 渲染的题图数字是 DejaVu Sans Bold；本机能找到就优先用。 */
function findDejaVuBold() {
  const cands = []
  if (process.env.IMPORT_FONT) cands.push(process.env.IMPORT_FONT)
  cands.push(
    'C:\\Program Files\\inkstone\\resources\\science-pack\\python\\Lib\\site-packages\\matplotlib\\mpl-data\\fonts\\ttf\\DejaVuSans-Bold.ttf',
  )
  const local = process.env.LOCALAPPDATA
  if (local) {
    const uvRoot = path.join(local, 'uv', 'cache', 'archive-v0')
    try {
      if (fs.existsSync(uvRoot))
        for (const d of fs.readdirSync(uvRoot)) {
          cands.push(
            path.join(uvRoot, d, 'matplotlib', 'mpl-data', 'fonts', 'ttf', 'DejaVuSans-Bold.ttf'),
          )
          cands.push(path.join(uvRoot, d, 'matplotlib', 'mpl-data', 'fonts', 'ttf', 'DejaVuSans.ttf'))
        }
    } catch {
      /* ignore */
    }
  }
  return (
    cands.find((p) => {
      try {
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    }) || null
  )
}

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const arg = (flag, fallback = null) => {
  const i = argv.findIndex((a) => a === flag || a.startsWith(flag + '='))
  if (i < 0) return fallback
  return argv[i].startsWith(flag + '=') ? argv[i].slice(flag.length + 1) : (argv[i + 1] ?? fallback)
}
const imagePath = argv.find((a) => !a.startsWith('--'))
if (!imagePath) {
  console.error(
    '用法：node scripts/import-image.mjs <图片路径> [--name 名称] [--append] [--verify] [--width N --height N] [--map 0=1,1=3] [--dry]',
  )
  process.exit(1)
}
if (!fs.existsSync(imagePath)) {
  console.error('找不到图片：', imagePath)
  process.exit(1)
}

const widthOpt = Number(arg('--width', '0')) || 0
const heightOpt = Number(arg('--height', '0')) || 0
const name = arg('--name', path.basename(imagePath, path.extname(imagePath)))
const series = arg('--series', '导入')
const append = has('--append')
const verify = has('--verify')
const dry = has('--dry')
if (has('--drop-large')) {
  console.warn('[import] --drop-large 已废弃：现在支持 0..99 的圆内数字，不会再丢弃 >9 的线索（该参数被忽略）。')
}
const debugDir = arg('--debug', '')
const maxNodesOpt = Number(arg('--max-nodes', '400000')) || 400000
const verifyTimeout = Number(arg('--verify-timeout', '120000')) || 120000
const manualMap = {}
const manualMapArg = arg('--map', '')
if (manualMapArg) {
  for (const pair of String(manualMapArg).split(',')) {
    const [k, v] = pair.split('=')
    if (k !== undefined && v !== undefined && k.trim() !== '' && v.trim() !== '') {
      manualMap[Number(k)] = Number(v)
    }
  }
}
const fontPath = findDejaVuBold()
const fontB64 = fontPath ? fs.readFileSync(fontPath).toString('base64') : null

/* ═══════════════════════════ 像素分析（浏览器内） ═══════════════════════════ */
const dataUrl = 'data:image/png;base64,' + fs.readFileSync(imagePath).toString('base64')
const browser = await chromium.launch({ headless: true, executablePath: EDGE_PATH })
const page = await browser.newPage()

const analyzed = await page.evaluate(
  async ({ u, widthOpt, heightOpt, NORM, debug }) => {
    const img = new Image()
    img.src = u
    await img.decode()
    const W = img.naturalWidth
    const H = img.naturalHeight
    const cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    const g = cv.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)
    const px = g.getImageData(0, 0, W, H).data
    const isDark = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false
      const i = (y * W + x) * 4
      return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < 120
    }
    const dark = new Uint8Array(W * H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) dark[y * W + x] = isDark(x, y) ? 1 : 0

    // 1) 全图连通域
    const seen = new Uint8Array(W * H)
    const comps = []
    const stack = new Int32Array(W * H)
    for (let i = 0; i < W * H; i++) {
      if (!dark[i] || seen[i]) continue
      let sp = 0
      stack[sp++] = i
      seen[i] = 1
      let area = 0
      let sx = 0
      let sy = 0
      let x0 = W
      let x1 = -1
      let y0 = H
      let y1 = -1
      while (sp) {
        const p = stack[--sp]
        const x = p % W
        const y = (p / W) | 0
        area++
        sx += x
        sy += y
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        if (x > 0 && dark[p - 1] && !seen[p - 1]) {
          seen[p - 1] = 1
          stack[sp++] = p - 1
        }
        if (x + 1 < W && dark[p + 1] && !seen[p + 1]) {
          seen[p + 1] = 1
          stack[sp++] = p + 1
        }
        if (y > 0 && dark[p - W] && !seen[p - W]) {
          seen[p - W] = 1
          stack[sp++] = p - W
        }
        if (y + 1 < H && dark[p + W] && !seen[p + W]) {
          seen[p + W] = 1
          stack[sp++] = p + W
        }
      }
      comps.push({ area, cx: sx / area, cy: sy / area, x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 })
    }

    // 2) 小圆点 → 网格坐标
    const dots = comps.filter((c) => c.area >= 8 && c.area <= 120 && c.w >= 3 && c.w <= 10 && c.h >= 3 && c.h <= 10)
    const unique = (vals) => {
      const sorted = vals.slice().sort((a, b) => a - b)
      const out = []
      for (const v of sorted) {
        const last = out[out.length - 1]
        if (last === undefined || v - last > 10) out.push(v)
        else out[out.length - 1] = (last + v) / 2
      }
      return out
    }
    const xs = unique(dots.map((c) => c.cx))
    const ys = unique(dots.map((c) => c.cy))
    const w = widthOpt || xs.length
    const h = heightOpt || ys.length
    if (!(w >= 3) || !(h >= 3)) throw new Error(`无法确定网格：识别到 ${xs.length} 列 / ${ys.length} 行圆点`)
    if (xs.length !== w || ys.length !== h) {
      throw new Error(`网格不匹配：圆点阵 ${xs.length}×${ys.length}，目标 ${w}×${h}`)
    }
    const pitchX = xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) : 0
    const pitchY = ys.length > 1 ? (ys[ys.length - 1] - ys[0]) / (ys.length - 1) : 0
    if (Math.abs(pitchX - pitchY) > Math.max(3, pitchX * 0.2)) {
      throw new Error(`网格间距异常：横 ${pitchX.toFixed(1)}px / 纵 ${pitchY.toFixed(1)}px`)
    }
    const pitch = (pitchX + pitchY) / 2

    // 3) 逐格判断圆 / 提取圆内数字位图
    const normalize = (mask, bw, bh) => {
      const out = new Array(NORM * NORM).fill(0)
      for (let j = 0; j < NORM; j++)
        for (let i = 0; i < NORM; i++) {
          const ax0 = Math.floor((i * bw) / NORM)
          const ax1 = Math.max(ax0 + 1, Math.floor(((i + 1) * bw) / NORM))
          const ay0 = Math.floor((j * bh) / NORM)
          const ay1 = Math.max(ay0 + 1, Math.floor(((j + 1) * bh) / NORM))
          let s = 0
          let n = 0
          for (let y = ay0; y < ay1; y++)
            for (let x = ax0; x < ax1; x++) {
              s += mask[y * bw + x]
              n++
            }
          out[j * NORM + i] = s / n >= 0.5 ? 1 : 0
        }
      return out
    }
    // 在半径 radius 的圆盘里取指定极性（1=白，-1=黑）的墨迹，返回数字位图
    // 用圆盘遮罩而不是方框，避免把圆的描边/方块角上的环带混进字形
    const extractInner = (cx, cy, radius, polarity) => {
      const xa = Math.max(0, Math.round(cx - radius))
      const ya = Math.max(0, Math.round(cy - radius))
      const ww = Math.min(W - xa, Math.round(radius * 2))
      const hh = Math.min(H - ya, Math.round(radius * 2))
      if (ww <= 0 || hh <= 0) return null
      const mask = new Uint8Array(ww * hh)
      const r2 = radius * radius
      for (let y = 0; y < hh; y++)
        for (let x = 0; x < ww; x++) {
          const dx = xa + x - cx
          const dy = ya + y - cy
          if (dx * dx + dy * dy > r2) continue
          const on = polarity > 0 ? !isDark(xa + x, ya + y) : isDark(xa + x, ya + y)
          mask[y * ww + x] = on ? 1 : 0
        }
      const seen2 = new Uint8Array(ww * hh)
      const kept = []
      for (let i = 0; i < ww * hh; i++) {
        if (!mask[i] || seen2[i]) continue
        let sp2 = 0
        const st2 = new Int32Array(ww * hh)
        st2[sp2++] = i
        seen2[i] = 1
        const pts = []
        let bx0 = ww
        let bx1 = -1
        let by0 = hh
        let by1 = -1
        while (sp2) {
          const p = st2[--sp2]
          pts.push(p)
          const x = p % ww
          const y = (p / ww) | 0
          if (x < bx0) bx0 = x
          if (x > bx1) bx1 = x
          if (y < by0) by0 = y
          if (y > by1) by1 = y
          if (x > 0 && mask[p - 1] && !seen2[p - 1]) {
            seen2[p - 1] = 1
            st2[sp2++] = p - 1
          }
          if (x + 1 < ww && mask[p + 1] && !seen2[p + 1]) {
            seen2[p + 1] = 1
            st2[sp2++] = p + 1
          }
          if (y > 0 && mask[p - ww] && !seen2[p - ww]) {
            seen2[p - ww] = 1
            st2[sp2++] = p - ww
          }
          if (y + 1 < hh && mask[p + ww] && !seen2[p + ww]) {
            seen2[p + ww] = 1
            st2[sp2++] = p + ww
          }
        }
        if (pts.length < 6) continue
        kept.push({ area: pts.length, bx0, bx1, by0, by1 })
      }
      if (!kept.length) return null
      let bx0 = ww
      let bx1 = -1
      let by0 = hh
      let by1 = -1
      let ink = 0
      for (const k of kept) {
        if (k.bx0 < bx0) bx0 = k.bx0
        if (k.bx1 > bx1) bx1 = k.bx1
        if (k.by0 < by0) by0 = k.by0
        if (k.by1 > by1) by1 = k.by1
        ink += k.area
      }
      const bw = bx1 - bx0 + 1
      const bh = by1 - by0 + 1
      if (bw < 2 || bh < 4 || ink < 8) return null
      const sub = new Uint8Array(bw * bh)
      for (let y = 0; y < bh; y++)
        for (let x = 0; x < bw; x++) sub[y * bw + x] = mask[(by0 + y) * ww + bx0 + x]
      return {
        x: xa + bx0,
        y: ya + by0,
        w: bw,
        h: bh,
        ink,
        m: normalize(sub, bw, bh),
        raw: bw > bh * 0.95 ? Array.from(sub) : null,
      }
    }

    const cells = []
    const glyphs = []
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const cx = xs[i]
        const cy = ys[j]
        let circle = null
        for (const c of comps) {
          if (c.area < 120) continue
          if (Math.abs(c.cx - cx) > pitch * 0.45 || Math.abs(c.cy - cy) > pitch * 0.45) continue
          if (c.w < pitch * 0.45 || c.h < pitch * 0.45) continue
          if (c.w > pitch * 0.95 || c.h > pitch * 0.95) continue
          const fill = c.area / (c.w * c.h)
          if (fill > 0.55) circle = { color: 1, w: c.w, h: c.h }
          else if (fill > 0.12) circle = { color: 2, w: c.w, h: c.h }
          if (circle) break
        }
        if (!circle) {
          cells.push({ color: 0, number: 0 })
          continue
        }
        const radius = Math.max(6, Math.min(circle.w, circle.h) / 2 - (circle.color === 1 ? 3 : 4.2))
        const glyph =
          circle.color === 1 ? extractInner(cx, cy, radius, 1) : extractInner(cx, cy, radius, -1)
        if (glyph) {
          glyph.group = `cell${j * w + i}`
          glyph.cell = j * w + i
          glyph.color = circle.color
          glyphs.push(glyph)
        }
        cells.push({ color: circle.color, number: -1 })
      }
    }

    let overlay = null
    if (debug) {
      const oc = document.createElement('canvas')
      oc.width = W
      oc.height = H
      const og = oc.getContext('2d')
      og.drawImage(img, 0, 0)
      og.strokeStyle = 'rgba(220,30,30,0.9)'
      og.lineWidth = 1
      for (const gl of glyphs) og.strokeRect(gl.x, gl.y, gl.w, gl.h)
      og.strokeStyle = 'rgba(30,120,220,0.9)'
      og.lineWidth = 1
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) {
          og.beginPath()
          og.arc(xs[i], ys[j], 1.5, 0, Math.PI * 2)
          og.stroke()
        }
      overlay = oc.toDataURL('image/png').slice('data:image/png;base64,'.length)
    }
    return { W, H, w, h, pitch: Number(pitch.toFixed(2)), xs, ys, cells, glyphs, compCount: comps.length, overlay }
  },
  { u: dataUrl, widthOpt, heightOpt, NORM, debug: !!debugDir },
)
if (analyzed.overlay) {
  fs.mkdirSync(debugDir || '.', { recursive: true })
  const out = path.join(debugDir || '.', path.basename(imagePath, path.extname(imagePath)) + '-glyphs.png')
  fs.writeFileSync(out, Buffer.from(analyzed.overlay, 'base64'))
  console.log(`[import] 调试覆盖图已写入 ${out}`)
}
console.log(
  `[import] ${path.basename(imagePath)}：${analyzed.W}×${analyzed.H} 像素，网格 ${analyzed.w}×${analyzed.h}，格距 ${analyzed.pitch}px，圆 ${analyzed.glyphs.length} 个`,
)

/* ═══════════════════════════ 字形模板 + 分类 ═══════════════════════════ */
const medH = (() => {
  const hs = analyzed.glyphs.map((gl) => gl.h).sort((a, b) => a - b)
  return hs.length ? hs[Math.floor(hs.length / 2)] : 15
})()
const FONTS = []
if (fontB64) FONTS.push({ fam: 'ImportFont', weight: 400 })
for (const fam of ['Tahoma', 'Verdana', 'Arial', 'Segoe UI', 'Calibri'])
  for (const weight of [700, 400]) FONTS.push({ fam, weight })
const SIZES = [...new Set([0.66, 0.7, 0.74].map((r) => Math.max(8, Math.round(medH / r))))]

const templates = await page.evaluate(
  async ({ FONTS, SIZES, NORM, fontB64 }) => {
    if (fontB64) {
      const face = new FontFace('ImportFont', `url(data:font/ttf;base64,${fontB64})`)
      await face.load()
      document.fonts.add(face)
      await document.fonts.ready
    }
    const render = (fam, weight, size, ch) => {
      const c = document.createElement('canvas')
      c.width = 160
      c.height = 160
      const g = c.getContext('2d', { willReadFrequently: true })
      g.fillStyle = '#fff'
      g.fillRect(0, 0, 160, 160)
      g.fillStyle = '#000'
      g.font = `${weight} ${size}px "${fam}"`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(ch, 80, 80)
      const d = g.getImageData(0, 0, 160, 160).data
      const dk = (x, y) => {
        const i = (y * 160 + x) * 4
        return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 120
      }
      let x0 = 160
      let x1v = -1
      let y0 = 160
      let y1v = -1
      for (let y = 0; y < 160; y++)
        for (let x = 0; x < 160; x++)
          if (dk(x, y)) {
            if (x < x0) x0 = x
            if (x > x1v) x1v = x
            if (y < y0) y0 = y
            if (y > y1v) y1v = y
          }
      if (x1v < 0) return null
      const bw = x1v - x0 + 1
      const bh = y1v - y0 + 1
      const out = new Array(NORM * NORM).fill(0)
      for (let j = 0; j < NORM; j++)
        for (let i = 0; i < NORM; i++) {
          const ax0 = Math.floor((i * bw) / NORM)
          const ax1 = Math.max(ax0 + 1, Math.floor(((i + 1) * bw) / NORM))
          const ay0 = Math.floor((j * bh) / NORM)
          const ay1 = Math.max(ay0 + 1, Math.floor(((j + 1) * bh) / NORM))
          let s = 0
          let n = 0
          for (let y = ay0; y < ay1; y++)
            for (let x = ax0; x < ax1; x++) {
              s += dk(x0 + x, y0 + y) ? 1 : 0
              n++
            }
          out[j * NORM + i] = s / n >= 0.5 ? 1 : 0
        }
      return out
    }
    const out = []
    for (const f of FONTS)
      for (const size of SIZES) {
        const digits = []
        for (const ch of '0123456789') digits.push(render(f.fam, f.weight, size, ch))
        out.push({ fam: f.fam, weight: f.weight, size, digits })
      }
    return out
  },
  { FONTS, SIZES, NORM, fontB64 },
)
await browser.close()

const sim = (a, b) => {
  let inter = 0
  let uni = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++
    if (a[i] || b[i]) uni++
  }
  return uni ? inter / uni : 0
}
const bestDigit = (mask, tpl) => {
  let best = -1
  let bestScore = -1
  let second = -1
  for (let d = 0; d < 10; d++) {
    const s = sim(mask, tpl.digits[d])
    if (s > bestScore) {
      second = bestScore
      bestScore = s
      best = d
    } else if (s > second) second = s
  }
  return { digit: best, score: bestScore, margin: bestScore - second }
}
const normBits = (bits, bw, bh) => {
  const out = new Array(NORM * NORM).fill(0)
  for (let j = 0; j < NORM; j++)
    for (let i = 0; i < NORM; i++) {
      const ax0 = Math.floor((i * bw) / NORM)
      const ax1 = Math.max(ax0 + 1, Math.floor(((i + 1) * bw) / NORM))
      const ay0 = Math.floor((j * bh) / NORM)
      const ay1 = Math.max(ay0 + 1, Math.floor(((j + 1) * bh) / NORM))
      let s = 0
      let n = 0
      for (let y = ay0; y < ay1; y++)
        for (let x = ax0; x < ax1; x++) {
          s += bits[y * bw + x]
          n++
        }
      out[j * NORM + i] = s / n >= 0.5 ? 1 : 0
    }
  return out
}
const classifyCut = (gl, tpl) => {
  if (!gl.raw || gl.w <= gl.h * 0.95) return null
  const bw = gl.w
  const bh = gl.h
  let best = null
  for (let cut = Math.ceil(bw * 0.28); cut <= Math.floor(bw * 0.72); cut++) {
    if (cut < 4 || bw - cut < 4) continue
    const left = new Uint8Array(cut * bh)
    const right = new Uint8Array((bw - cut) * bh)
    let inkL = 0
    let inkR = 0
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < cut; x++) {
        left[y * cut + x] = gl.raw[y * bw + x]
        inkL += left[y * cut + x]
      }
      for (let x = cut; x < bw; x++) {
        right[y * (bw - cut) + (x - cut)] = gl.raw[y * bw + x]
        inkR += right[y * (bw - cut) + (x - cut)]
      }
    }
    if (inkL < 8 || inkR < 8) continue
    const sl = bestDigit(normBits(left, cut, bh), tpl)
    const sr = bestDigit(normBits(right, bw - cut, bh), tpl)
    const score = (sl.score + sr.score) / 2
    if (!best || score > best.score) {
      best = { label: `${sl.digit}${sr.digit}`, score, margin: Math.min(sl.margin, sr.margin) }
    }
  }
  return best
}
const classifyGlyph = (gl, tpl) => {
  const single = bestDigit(gl.m, tpl)
  if (gl.raw) {
    const cut = classifyCut(gl, tpl)
    if (cut && cut.score >= single.score + 0.015) return cut
  }
  return { label: String(single.digit), score: single.score, margin: single.margin }
}
/** 小字号抗锯齿会让同一数字在不同位置像素形态不同：逐字形在全部字体模板里取最高分 */
const classifyAll = (gl) => {
  let best = null
  let bestSingle = null
  for (const tpl of templates) {
    const r = classifyGlyph(gl, tpl)
    if (!best || r.score > best.score) best = r
    const s = bestDigit(gl.m, tpl)
    if (!bestSingle || s.score > bestSingle.score) bestSingle = { label: String(s.digit), score: s.score, margin: s.margin }
  }
  // 单数字的抗锯齿失真偶尔会被误切成两位数：接近方形的字形保守退回单数字；
  // 明显偏宽（w > 1.15h）的字形才是真正的两位数（10..99），保留切分结果。
  const clearlyWide = gl.raw && gl.w > gl.h * 1.15
  if (!clearlyWide && best && best.label.length > 1 && bestSingle && bestSingle.score >= best.score - 0.06) return bestSingle
  return best
}

let chosen = null
const fontRanking = []
for (const cand of templates) {
  let total = 0
  for (const gl of analyzed.glyphs) total += classifyGlyph(gl, cand).score
  const avg = analyzed.glyphs.length ? total / analyzed.glyphs.length : 0
  fontRanking.push({ name: `${cand.fam} ${cand.weight}@${cand.size}`, avg })
  if (!chosen || avg > chosen.avg) chosen = { ...cand, avg }
}
if (!chosen) {
  console.error('[import] 没有可用字体模板')
  process.exit(1)
}
if (debugDir) {
  fontRanking.sort((a, b) => b.avg - a.avg)
  console.log(`[debug] 字体模板: ${fontPath || '未找到 DejaVu'}`)
  for (const r of fontRanking.slice(0, 5)) console.log(`[debug]   ${r.name} avg=${r.avg.toFixed(3)}`)
  for (let gi = 0; gi < Math.min(6, analyzed.glyphs.length); gi++) {
    const gl = analyzed.glyphs[gi]
    console.log(
      `[debug] glyph${gi} cell=${gl.cell} color=${gl.color} w=${gl.w} h=${gl.h} ink=${gl.ink}\n` +
        Array.from({ length: NORM }, (_, j) => gl.m.slice(j * NORM, (j + 1) * NORM).map((v) => (v ? '#' : '.')).join('')).join('\n'),
    )
  }
}

const clusterOf = []
const clusters = []
for (let gi = 0; gi < analyzed.glyphs.length; gi++) {
  const gl = analyzed.glyphs[gi]
  let best = -1
  let bestScore = CLUSTER_SIM
  for (let k = 0; k < clusters.length; k++) {
    const s = sim(gl.m, clusters[k].mask)
    if (s > bestScore) {
      bestScore = s
      best = k
    }
  }
  if (best < 0) {
    clusters.push({ mask: gl.m, members: [] })
    best = clusters.length - 1
  }
  clusters[best].members.push(gi)
  clusterOf[gi] = best
}
const clusterDigit = []
for (let k = 0; k < clusters.length; k++) {
  const votes = new Map()
  for (const gi of clusters[k].members) {
    const r = classifyAll(analyzed.glyphs[gi])
    votes.set(r.label, (votes.get(r.label) || 0) + 1)
  }
  let label = '0'
  let count = -1
  for (const [lbl, n] of votes) if (n > count) { count = n; label = lbl }
  const sorted = [...votes.values()].sort((a, b) => b - a)
  const n = clusters[k].members.length
  clusterDigit[k] = {
    label,
    count: n,
    score: sorted[0] / n,
    margin: (sorted[0] - (sorted[1] || 0)) / n,
    final: manualMap[k] !== undefined ? String(manualMap[k]) : label,
    manual: manualMap[k] !== undefined,
  }
}
console.log(
  `[import] 字体自动择优：${chosen.fam === 'ImportFont' ? 'DejaVu Sans Bold' : chosen.fam + ' ' + chosen.weight} / ${chosen.size}px（平均字形相似度 ${chosen.avg.toFixed(3)}），字形簇 ${clusters.length} 个`,
)
for (let k = 0; k < clusters.length; k++) {
  const c = clusterDigit[k]
  const tag = c.manual ? `人工→${c.final}` : `自动→${c.label}`
  const warn = !c.manual && (c.margin < 0.06 || c.score < 0.72) ? '  ⚠ 低置信' : ''
  console.log(`  簇${k}: ${tag}（n=${c.count}，一致率 ${c.score.toFixed(3)}）${warn}`)
}
const lowConfidence = clusterDigit.some((c) => !c.manual && (c.margin < 0.06 || c.score < 0.72))
if (lowConfidence) {
  console.warn('[import] 存在低置信字形簇：可用 --map 0=3,1=2 人工指定；默认仍按自动结果继续。')
}
if (debugDir) {
  const targets = new Set([120, 162, 1653])
  for (let gi = 0; gi < analyzed.glyphs.length; gi++) {
    const gl = analyzed.glyphs[gi]
    if (!targets.has(gl.cell)) continue
    const single = bestDigit(gl.m, chosen)
    const cut = classifyCut(gl, chosen)
    console.log(
      `[debug] glyph cell=${gl.cell} cluster=${clusterOf[gi]}→${clusterDigit[clusterOf[gi]].final} ` +
        `single=${single.digit}(${single.score.toFixed(2)}) cut=${cut ? cut.label + '(' + cut.score.toFixed(2) + ')' : '-'} w=${gl.w} h=${gl.h}\n` +
        Array.from({ length: NORM }, (_, j) => gl.m.slice(j * NORM, (j + 1) * NORM).map((v) => (v ? '#' : '.')).join('')).join('\n'),
    )
  }
}

// 数字回填到格子（0..99：0 = 圆里没有数字）
// 编码交给 src/game/types.ts 的 makeCircle：0..9 仍是旧的 10+n / 20+n，
// ≥10 自动切到 100+n / 200+n，不再丢弃 >9 的线索。
for (let gi = 0; gi < analyzed.glyphs.length; gi++) {
  const gl = analyzed.glyphs[gi]
  const label = clusterDigit[clusterOf[gi]].final
  const num = Number(label)
  if (!Number.isInteger(num) || num < 0 || num > MAX_CIRCLE_NUMBER) {
    console.warn(
      `[import] 第 ${gl.cell + 1} 格数字异常（识别为 ${label}，超出 0..${MAX_CIRCLE_NUMBER}），按无数字圆处理。`,
    )
    analyzed.cells[gl.cell].number = 0
    continue
  }
  analyzed.cells[gl.cell].number = num
}
const largeNumbers = analyzed.cells
  .map((c, cell) => ({ cell, num: c.number, color: c.color }))
  .filter((o) => o.color !== 0 && o.num >= 10)
if (largeNumbers.length) {
  console.log(
    `[import] 圆内数字 ≥10 的圆 ${largeNumbers.length} 个（已按扩展编码保留）：` +
      largeNumbers
        .map((o) => `${o.num}@(${o.cell % analyzed.w},${(o.cell / analyzed.w) | 0})`)
        .join(' '),
  )
}

/* ═══════════════════════════ 预览 + 编码 ═══════════════════════════ */
const { w, h, cells } = analyzed
if (debugDir) {
  const bad = cells
    .map((c, i) =>
      c.color !== 0 && (c.number < 0 || c.number > MAX_CIRCLE_NUMBER)
        ? `(${i % w},${(i / w) | 0})=${c.number}`
        : null,
    )
    .filter(Boolean)
  if (bad.length) console.log(`[debug] 数字异常圆位置(x,y)/值：${bad.join(' ')}`)
  for (let gi = 0; gi < analyzed.glyphs.length; gi++) {
    const gl = analyzed.glyphs[gi]
    if (cells[gl.cell].number < 0) {
      console.log(
        `[debug] 异常字形 cell=${gl.cell} cluster=${clusterOf[gi]}→${clusterDigit[clusterOf[gi]].final} w=${gl.w} h=${gl.h}\n` +
          Array.from({ length: NORM }, (_, j) => gl.m.slice(j * NORM, (j + 1) * NORM).map((v) => (v ? '#' : '.')).join('')).join('\n'),
      )
    }
  }
}
const circles = cells.map((c) => (c.color === 0 ? 0 : makeCircle(c.color, c.number > 0 ? c.number : 0)))
const board = encodeCircles(circles)
const wideBoard = board.length === cells.length * 2
console.log(
  wideBoard
    ? '[import] 圆点布局（每格 3 字符：B/W + 两位十进制数字，\'.\' = 空；board 串为扩展宽格式）：'
    : '[import] 圆点布局（.=空，黑圆=b..j，白圆=l..t）：',
)
for (let y = 0; y < h; y++) {
  if (!wideBoard) {
    console.log('  ' + board.slice(y * w, y * w + w))
    continue
  }
  const row = cells
    .slice(y * w, (y + 1) * w)
    .map((c) =>
      c.color === 0
        ? '  .'
        : (c.color === 1 ? 'B' : 'W') + (c.number > 0 ? String(c.number).padStart(2, ' ') : '  '),
    )
    .join('')
  console.log('  ' + row)
}
const blackCount = cells.filter((c) => c.color === 1).length
const whiteCount = cells.filter((c) => c.color === 2).length
const noNum = cells.filter((c) => c.color !== 0 && !(c.number > 0)).length
console.log(
  `[import] 黑圆 ${blackCount} 个 / 白圆 ${whiteCount} 个，其中无数字圆 ${noNum} 个，空格 ${cells.length - blackCount - whiteCount} 个`,
)
{
  const dist = new Map()
  for (const c of cells) {
    if (c.color === 0) continue
    const n = c.number > 0 ? c.number : 0
    dist.set(n, (dist.get(n) || 0) + 1)
  }
  const parts = [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([n, count]) => `${n}×${count}`)
  console.log('[import] 圆内数字分布（数字×个数）：' + parts.join(' '))
}
if (blackCount === 0 && whiteCount === 0) {
  console.error('[import] 没有识别到任何圆：圆检测失败，可用 --debug 查看覆盖图。')
  process.exit(1)
}

if (dry) {
  console.log('[import] --dry：仅识别预览，不求解、不写入。')
  process.exit(0)
}

/* ═══════════════════════════ 求解 / 唯一性（子进程隔离） ═══════════════════════════ */
function runSolverChild(code, payload, timeoutMs, solverPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        IMPORT_SOLVER: pathToFileURL(solverPath).href,
        IMPORT_PAYLOAD: JSON.stringify(payload),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => {
      child.kill()
      resolve({ status: 'timeout', stdout, stderr })
    }, timeoutMs)
    child.on('close', (code2) => {
      clearTimeout(timer)
      resolve({ status: code2 === 0 ? 'ok' : 'crash', code: code2, stdout, stderr })
    })
  })
}

let solution = ''
const t0 = Date.now()
if (verify) {
  const res = await runSolverChild(
    `
const mod = await import(process.env.IMPORT_SOLVER)
const p = JSON.parse(process.env.IMPORT_PAYLOAD)
const puzzle = { id: 'import-temp', name: 'import-temp', width: p.w, height: p.h, difficulty: 'hard', circles: p.circles }
const r = mod.countSolutions(puzzle, 2, p.maxNodes, p.timeLimitMs)
const solution = r.count === 1 && r.first ? r.first.map((v) => (v === 1 ? '1' : '0')).join('') : ''
console.log(JSON.stringify({ count: r.count, nodes: r.nodes, timedOut: r.timedOut, solution }))
`,
    { w, h, circles, maxNodes: maxNodesOpt, timeLimitMs: verifyTimeout - 5000 },
    verifyTimeout,
    'src/game/solver.ts',
  )
  if (res.status === 'ok') {
    const line = res.stdout.trim().split('\n').filter(Boolean).pop() || '{}'
    let data = {}
    try {
      data = JSON.parse(line)
    } catch {
      data = {}
    }
    if (data.timedOut) {
      console.warn(
        `[import] 唯一性检查超时（${data.nodes} 节点，${Date.now() - t0}ms）：未能确认唯一解，条目不写参考解。`,
      )
    } else if (data.count === 0) {
      console.error('[import] 求解无解：圆/数字识别可能有误。')
      process.exit(1)
    } else if (data.count !== 1) {
      console.error(`[import] 解不唯一：${data.count} 个（${data.nodes} 节点）。`)
      process.exit(1)
    } else {
      console.log(`[import] 唯一解校验通过（${data.nodes} 节点，${Date.now() - t0}ms）`)
      solution = data.solution || ''
      if (solution) console.log(`[import] 已生成参考解（${solution.length} 条边）`)
    }
  } else if (res.status === 'timeout') {
    console.warn(`[import] 唯一性检查超过 ${verifyTimeout}ms 未完成（已终止）：未确认唯一解，条目不写参考解。`)
  } else {
    console.warn(
      `[import] 唯一性检查子进程异常退出（${res.code}，可能题板过大/内存不足）：未确认唯一解，条目不写参考解。`,
    )
  }
} else {
  console.log('[import] 未加 --verify：跳过唯一解校验。')
}

const id = arg('--id', `shingoki-import-${Date.now().toString(36)}`)
if (!append) {
  console.log('[import] 预览模式（未写入）。加 --append 写入 src/game/puzzles-data.ts。')
  process.exit(0)
}
const dataFile = path.resolve('src/game/puzzles-data.ts')
if (!fs.existsSync(dataFile)) {
  console.error('[import] 找不到 src/game/puzzles-data.ts')
  process.exit(1)
}
const entry = `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${w}, height: ${h}, difficulty: "hard", series: ${JSON.stringify(series)}, board: ${JSON.stringify(board)}, solution: ${JSON.stringify(solution)} },\n`
let text = fs.readFileSync(dataFile, 'utf8').replace(/\r\n/g, '\n')
const marker = text.lastIndexOf('\n]')
if (marker < 0) {
  console.error('[import] puzzles-data.ts 格式异常：找不到结尾 ]')
  process.exit(1)
}
text = text.slice(0, marker + 1) + '\n' + entry + text.slice(marker + 1)
fs.writeFileSync(dataFile, text)
console.log(`[import] 已写入 ${dataFile}：${id} ${name}`)
