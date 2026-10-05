import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isRedundantField, promoteSectionLabels } from './lib/cards.js'

const norm = (text) => String(text || '')
  .replace(/<\/?[A-Za-z][^>]*>/gu, ' ')
  .replace(/^#{1,6}\s+/gmu, '')
  .replace(/[ \t]*:[ \t]*$/gmu, '')
  .replace(/[\u2010-\u2015\u2212]/gu, '-')
  .replace(/[\u2018\u2019]/gu, "'")
  .replace(/[\u201C\u201D]/gu, '"')
  .replace(/\s+/gu, ' ')
  .trim()
  .toLowerCase()

const cardsDir = join(homedir(), '.dsh', 'tavern', 'cards')
const files = readdirSync(cardsDir).filter((f) => f.endsWith('.json'))
for (const file of files) {
  const card = JSON.parse(readFileSync(join(cardsDir, file), 'utf8'))
  const desc = String(card.description || '')
  const scen = String(card.scenario || '')
  if (!desc || !scen) continue
  const redundant = isRedundantField(desc, scen)
  console.log('\n===', file, '=== desc=' + desc.length + ' scen=' + scen.length + ' redundant=' + redundant)
  if (redundant) continue

  const L = norm(promoteSectionLabels(desc))
  const S = norm(scen)
  console.log('normDesc=' + L.length + ' normScen=' + S.length)

  let probeLen = 40
  let idx = -1
  while (probeLen >= 8 && idx < 0) {
    idx = L.indexOf(S.slice(0, probeLen))
    if (idx < 0) probeLen = Math.floor(probeLen / 2)
  }
  if (idx < 0) {
    console.log('!! 在 L 中找不到 S 的开头（8 字符探针也失败）')
    console.log('S 头 240:', S.slice(0, 240))
    console.log('L 头 240:', L.slice(0, 240))
  } else {
    console.log('S 头部探针在 L 中 index=' + idx + '（探针长度=' + probeLen + '）')
    const win = L.slice(idx, idx + S.length)
    let mm = -1
    for (let i = 0; i < S.length && i < win.length; i++) {
      if (S[i] !== win[i]) { mm = i; break }
    }
    if (mm < 0) {
      console.log('前 ' + S.length + ' 字符一致；L 长度=' + L.length + '，S 长度=' + S.length)
      console.log('S 尾部是否超出 L：', idx + S.length, 'vs', L.length)
    } else {
      console.log('首个不一致位置（相对 S 起点）=' + mm)
      console.log('S 片段:', JSON.stringify(S.slice(Math.max(0, mm - 80), mm + 80)))
      console.log('L 片段:', JSON.stringify(win.slice(Math.max(0, mm - 80), mm + 80)))
    }
  }

  writeFileSync('.tavern-norm-desc.txt', L)
  writeFileSync('.tavern-norm-scen.txt', S)
  console.log('已写出 .tavern-norm-desc.txt 与 .tavern-norm-scen.txt')
}