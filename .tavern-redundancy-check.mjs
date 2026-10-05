import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isRedundantField, promoteSectionLabels } from './lib/cards.js'

// ---------- 合成断言 ----------

const filler = 'A quiet afternoon on the lanai. '.repeat(8)   // 约 250 字符

// scenario 侧：干净的 "luxury"
const body = [
  'General Information:',
  '',
  'Name: Natalie Willson',
  'Age: 39',
  '',
  'Appearance:',
  '',
  'Tall and voluptuous.',
  '',
  'Personality:',
  '',
  'Sultry and warm.',
  '',
  'Hobbies:',
  '',
  'Gardening, candles, poetry.',
  '',
  'She kept collecting luxury candles she never lights.',
  '',
  filler,
].join('\n')

// description 侧：把 "luxury" 劈成 "lu\nxury"，模拟真实卡的硬换行断词
const bodyWrapped = body.replace('luxury', 'lu\nxury')

const promoted = promoteSectionLabels(bodyWrapped)
if (!promoted.includes('### General Information')) {
  throw new Error('SETUP: promoteSectionLabels did not promote; check fixture length/format')
}

const description = 'Short intro story about a Hawaii summer.\n\n<Natalie>\n\n' + promoted + '</Natalie>'
const scenario    = '<Natalie>\n\n' + body + '</Natalie>'

// 断言 1：硬换行断词的 description 嵌入 scenario，必须判冗余（本次核心）
if (!isRedundantField(description, scenario)) {
  throw new Error('FAIL: hard-wrap-split word should be redundant')
}

// 断言 2：真正不同的 scenario 不能被误判
const other = 'A totally different scenario about rainy Tokyo nights and neon signs.'
if (isRedundantField(description, other)) {
  throw new Error('FAIL: unrelated scenario should NOT be redundant')
}

// 断言 3：行中冒号必须保留（防过度归一哨兵）
if (isRedundantField('Name: Natalie Willson', 'Name Natalie Willson')) {
  throw new Error('FAIL: mid-line colon must not be normalized away')
}

// 断言 4：短文本不得因去空白兜底而误判（长度闸门生效）
if (isRedundantField('ab c', 'abc')) {
  throw new Error('FAIL: short-text whitespace fallback must stay disabled')
}

console.log('synthetic assertions OK')

// ---------- 真实卡验证 ----------

const cardsDir = join(homedir(), '.dsh', 'tavern', 'cards')
let checked = 0
let natalieOk = 0

for (const file of readdirSync(cardsDir).filter((f) => f.endsWith('.json'))) {
  const card = JSON.parse(readFileSync(join(cardsDir, file), 'utf8'))
  const desc = String(card.description || '')
  const scen = String(card.scenario || '')
  if (!desc || !scen) continue
  checked++
  const redundant = isRedundantField(desc, scen)
  console.log(`real card ${file}: desc=${desc.length} scen=${scen.length} redundant=${redundant}`)
  if (file === 'json-b87933.json') {
    if (redundant) natalieOk++
  }
}

if (checked === 0) {
  throw new Error('FAIL: no real cards found under ' + cardsDir)
}
if (natalieOk === 0) {
  throw new Error('FAIL: json-b87933.json is still not redundant')
}

console.log('real-card check OK')
console.log('isRedundantField hardened OK')
