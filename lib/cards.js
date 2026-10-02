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
