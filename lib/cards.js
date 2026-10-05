/**
 * Character-card reading: SillyTavern / Character Card V2-V3.
 *
 * Two on-disk shapes are supported, matching what the ecosystem actually ships:
 *   - plain JSON  (`*.json`), either V2/V3 (`{spec, spec_version, data}`) or the
 *     legacy flat V1 object;
 *   - PNG  (`*.png`) with the card embedded in a `tEXt` / `iTXt` chunk under the
 *     `chara` keyword (V2) or the `ccv3` keyword (V3), base64-encoded JSON.
 *
 * `normalizeCard` is the single funnel: whatever came in, what leaves is a flat,
 * version-agnostic record the rest of the plugin renders from.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Keywords that carry an embedded card, in preference order (V3 first). */
const CARD_KEYWORDS = ['ccv3', 'chara']

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => asString(item)).filter((item) => item.length > 0)
  if (typeof value === 'string' && value.trim().length > 0) return [value]
  return []
}

/**
 * Tags, tolerating the V1 shape where the field is one comma-separated string.
 * Only tags get this treatment: greetings and examples legitimately contain
 * commas and must never be split.
 */
function asTagArray(value) {
  if (Array.isArray(value)) return asStringArray(value)
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  }
  return []
}

/** True when the buffer starts with the 8-byte PNG signature. */
export function isPng(bytes) {
  return Buffer.isBuffer(bytes)
    && bytes.length >= PNG_SIGNATURE.length
    && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

/**
 * Pull every text chunk out of a PNG.
 * Chunk layout: `[u32 length BE][4-byte type][data][u32 crc]`.
 */
function pngTextChunks(bytes) {
  const found = new Map()
  let offset = PNG_SIGNATURE.length
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) break
    if (type === 'tEXt' || type === 'iTXt') {
      const data = bytes.subarray(dataStart, dataEnd)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = data.toString('latin1', 0, nul).trim()
        let text = ''
        if (type === 'tEXt') {
          text = data.toString('latin1', nul + 1)
        } else {
          // iTXt: keyword\0 compressionFlag(1) compressionMethod(1) languageTag\0 translated\0 text
          const compressionFlag = data[nul + 1]
          let cursor = nul + 3
          const langEnd = data.indexOf(0, cursor)
          cursor = langEnd < 0 ? cursor : langEnd + 1
          const translatedEnd = data.indexOf(0, cursor)
          cursor = translatedEnd < 0 ? cursor : translatedEnd + 1
          if (compressionFlag === 1) continue // compressed iTXt is not used by card writers
          text = data.toString('utf8', cursor)
        }
        if (keyword.length > 0 && !found.has(keyword)) found.set(keyword, text)
      }
    }
    if (type === 'IEND') break
    offset = dataEnd + 4
  }
  return found
}

/** Decode one embedded chunk payload (base64 JSON, with a raw-JSON fallback). */
function decodeChunk(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const candidates = []
  try {
    candidates.push(Buffer.from(trimmed, 'base64').toString('utf8'))
  } catch (error) {
    /* not base64 — fall through to the raw form */
  }
  candidates.push(trimmed)
  for (const candidate of candidates) {
    const body = candidate.trim()
    if (!body.startsWith('{')) continue
    try {
      return JSON.parse(body)
    } catch (error) {
      /* try the next candidate */
    }
  }
  return undefined
}

/**
 * Read a card out of either a JSON document or an embedded PNG chunk.
 * @returns the raw (still un-normalized) card object.
 */
export function readCardDocument(bytes, fileName = '') {
  if (isPng(bytes)) {
    const chunks = pngTextChunks(bytes)
    for (const keyword of CARD_KEYWORDS) {
      const text = chunks.get(keyword)
      if (text === undefined) continue
      const parsed = decodeChunk(text)
      if (parsed !== undefined) return { raw: parsed, container: 'png', keyword }
    }
    throw new Error('这个 PNG 里没有角色卡数据（未找到 chara / ccv3 文本块）')
  }
  const text = bytes.toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`无法解析角色卡：既不是 PNG 也不是合法 JSON（${String((error && error.message) || error)}）`)
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('角色卡 JSON 必须是一个对象')
  return { raw: parsed, container: 'json', keyword: '' }
}

/**
 * Flatten any supported card version into one record.
 * @param raw - the object read from JSON or a PNG chunk.
 * @param meta - provenance recorded beside the card.
 */
export function normalizeCard(raw, meta = {}) {
  const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : raw
  const spec = asString(raw && raw.spec) || asString(meta.spec)
  const name = asString(data.name).trim() || meta.name || '未命名角色'
  const characterBook = data.character_book
  return {
    id: meta.id,
    name,
    spec: spec || 'chara_card_v1',
    specVersion: asString(raw && raw.spec_version),
    container: meta.container || 'json',
    source: meta.source || 'import',
    importedAt: meta.importedAt || new Date().toISOString(),
    description: asString(data.description),
    personality: asString(data.personality),
    scenario: asString(data.scenario),
    firstMes: asString(data.first_mes),
    alternateGreetings: asStringArray(data.alternate_greetings),
    mesExample: asString(data.mes_example),
    systemPrompt: asString(data.system_prompt),
    postHistoryInstructions: asString(data.post_history_instructions),
    creator: asString(data.creator),
    characterVersion: asString(data.character_version),
    tags: asTagArray(data.tags),
    creatorNotes: asString(data.creator_notes),
    depthPrompt: asString(data.extensions && data.extensions.depth_prompt && data.extensions.depth_prompt.prompt),
    /** An embedded lorebook, kept so the UI can offer "import as world book". */
    characterBook: characterBook && typeof characterBook === 'object' ? characterBook : null,
  }
}

/** Every opening text a card carries, primary greeting first. */
export function cardGreetings(card) {
  if (!card) return []
  const out = []
  if (card.firstMes) out.push({ label: '开场白', text: card.firstMes })
  card.alternateGreetings.forEach((text, index) => {
    out.push({ label: `备用开场白 ${index + 1}`, text })
  })
  return out
}

/**
 * Fields the settings-page editor may change.
 *
 * Everything else — `id`, `spec`, `specVersion`, `container`, `source`,
 * `importedAt`, `characterBook` — is provenance: the id is the on-disk
 * filename, the spec records what the card was imported as, and the embedded
 * book has its own dedicated endpoint (`/dsh-tavern/api/card/book`).
 */
const EDITABLE_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'firstMes',
  'alternateGreetings',
  'mesExample',
  'systemPrompt',
  'postHistoryInstructions',
  'creatorNotes',
  'creator',
  'characterVersion',
  'tags',
  'depthPrompt',
]

/**
 * Apply an editor patch onto an existing card.
 *
 * Only whitelisted fields are copied, and only when the patch actually
 * carries them (a missing key leaves the current value alone). The result is
 * a new object: callers write it back through `putCard`, they never mutate
 * the input.
 *
 * `name` falls back to the current value when the patch is blank — an empty
 * name would produce an unusable card, and the caller's intent (clear the
 * field) has no sensible interpretation here. `alternateGreetings` and
 * `tags` are normalized the same way import normalizes them, so a string
 * pasted from a comma-separated list behaves identically to an array.
 *
 * @param card - the current normalized card.
 * @param patch - partial field values from the settings page.
 * @returns a new card carrying the applied patch.
 */
export function updateCardEditable(card, patch = {}) {
  const source = patch && typeof patch === 'object' ? patch : {}
  const next = { ...card }
  for (const field of EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue
    const raw = source[field]
    if (field === 'alternateGreetings') {
      next[field] = asStringArray(raw)
    } else if (field === 'tags') {
      next[field] = asTagArray(raw)
    } else if (field === 'name') {
      const trimmed = asString(raw).trim()
      next[field] = trimmed.length > 0 ? trimmed : card.name
    } else {
      next[field] = asString(raw)
    }
  }
  return next
}

/**
 * Whether one field is a near-duplicate of another.
 *
 * Card authors routinely paste the same block into both `description` and
 * `scenario`; SillyTavern renders them in different places so the author may
 * not have noticed the duplication, but DSH stacks both into one prefix and
 * pays for the text twice. This test decides whether the shorter field adds
 * anything the longer one already says.
 *
 * The comparison strips XML-ish wrapper tags and collapses whitespace before
 * a containment test. It is deliberately conservative: it only fires when one
 * side contains the other almost verbatim. It does NOT handle spelling
 * differences, reordered paragraphs, or synonym swaps — those would require
 * a real fuzzy matcher and the cost is not justified by the failure mode
 * (keeping a redundant section is harmless; dropping a distinct scenario is
 * not).
 *
 * @param a - first field text.
 * @param b - second field text.
 * @returns whether `b` is redundant given `a` (or vice versa).
 */
export function isRedundantField(a, b) {
  const norm = (text) => String(text || '')
    .replace(/<\/?[A-Za-z][^>]*>/gu, ' ')       // strip <tag> / </tag>
    .replace(/^#{1,6}\s+/gmu, '')                // strip markdown heading prefix
    .replace(/[ \t]*:[ \t]*$/gmu, '')            // strip trailing colon (Label: → Label)
    .replace(/[\u2010-\u2015\u2212]/gu, '-')     // unify dashes (— – ‒ − → -)
    .replace(/[\u2018\u2019]/gu, "'")            // curly single quotes → '
    .replace(/[\u201C\u201D]/gu, '"')            // curly double quotes → "
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
  const left = norm(a)
  const right = norm(b)
  if (left.length === 0 || right.length === 0) return false
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  if (long.includes(short)) return true
  // A hard wrap inside a word ("lu" + newline + "xury" → "lu xury" after the
  // whitespace collapse above) leaves a space the other side does not have.
  // Retry with every whitespace removed. Length-guarded: on long texts an
  // accidental whitespace-free match is implausible; on short ones it is not.
  if (short.length < 200) return false
  const squash = (text) => text.replace(/\s+/gu, '')
  return squash(long).includes(squash(short))
}

/**
 * Detect the language a card's text is written in.
 *
 * Tracks Han / kana / hangul / Latin separately: kana is decisive for
 * Japanese (Han alone would conflate Chinese), and hangul for Korean. The
 * result is a human label, never a BCP-47 tag — its only consumer is the
 * output-language section, where an imprecise label is harmless.
 *
 * @param card - a normalized card.
 * @returns a human-readable language label.
 */
export function detectCardLanguage(card) {
  const sample = [
    card && card.description,
    card && card.personality,
    card && card.scenario,
  ].filter((text) => typeof text === 'string').join('\n').slice(0, 8000)
  if (sample.length === 0) return '未知语言'
  let han = 0     // CJK Unified Ideographs — Chinese or Japanese
  let kana = 0    // Hiragana + Katakana — Japanese only
  let hangul = 0  // Hangul syllables — Korean only
  let latin = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0)
    if (code >= 0x4e00 && code <= 0x9fff) han += 1
    else if (code >= 0x3040 && code <= 0x30ff) kana += 1
    else if (code >= 0xac00 && code <= 0xd7af) hangul += 1
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1
  }
  const total = han + kana + hangul + latin
  if (total === 0) return '未知语言'
  // Kana and hangul are decisive: a text with either present is that language.
  if (hangul / total > 0.1) return '韩文'
  if (kana / total > 0.1) return '日文'
  // Han without kana is almost always Chinese.
  if (han / total > 0.3) return '中文'
  // Latin-script text is reported as English — a heuristic that is wrong for
  // French, German, etc., but those are rare in this ecosystem and the label
  // is only a hint inside the prompt.
  if (latin / total > 0.7) return '英文'
  return '未知语言'
}

/**
 * Promote standalone label lines to markdown sub-headers.
 *
 * Cards commonly carry sections like `General Information:` or `Appearance:`
 * on their own line. SillyTavern renders those as plain text; DSH's persona
 * prefix benefits from a real heading level so the model sees the boundary.
 * Detection is conservative: at least three candidate labels must be present
 * before any promotion happens, so an ordinary paragraph with one colon line
 * is never rewritten.
 *
 * @param text - one card field.
 * @returns the same text with qualifying labels prefixed by `### `.
 */
export function promoteSectionLabels(text) {
  const source = String(text || '')
  if (source.length < 400) return source
  // `Label:` alone on its line, no trailing content — a heading, not a key.
  const labelPattern = /^([A-Z][A-Za-z0-9 '&\/-]{1,40}):\s*$/gmu
  const labels = [...source.matchAll(labelPattern)]
  if (labels.length < 3) return source
  return source.replace(labelPattern, (_match, label) => `### ${label.trim()}`)
}
