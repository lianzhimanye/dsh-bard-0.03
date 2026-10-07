/**
 * World books (lorebooks / World Info).
 *
 * Three on-disk shapes are accepted and flattened into one record:
 *   - the classic SillyTavern World Info export, whose `entries` is an object
 *     keyed by uid and whose keyword arrays are `key` / `keysecondary`;
 *   - the same document with `entries` as an array;
 *   - a Character-Card-V2 `character_book`, whose keyword arrays are `keys` /
 *     `secondary_keys` and whose enable flag is inverted (`enabled`, not
 *     `disable`).
 *
 * Selection is SillyTavern-shaped but honest about what it is: pure keyword
 * matching over the recent transcript, constant entries always on, secondary
 * keys gating selective entries.
 */

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function toKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item).trim()).filter((item) => item.length > 0)
  }
  if (typeof value === 'string') {
    // Writers store comma-separated keys in the flat V1 shape.
    return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  }
  return []
}

function pick(object, ...names) {
  for (const name of names) {
    if (object && object[name] !== undefined && object[name] !== null) return object[name]
  }
  return undefined
}

/** Normalize one entry, whichever dialect it came from. */
function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== 'object') return null
  const keys = toKeys(pick(entry, 'keys', 'key'))
  const secondaryKeys = toKeys(pick(entry, 'secondary_keys', 'keysecondary', 'keySecondary'))
  const content = asString(entry.content)
  if (content.trim().length === 0) return null
  const disableRaw = pick(entry, 'disable', 'disabled')
  const enabledRaw = pick(entry, 'enabled')
  return {
    id: String(pick(entry, 'uid', 'id') ?? index),
    comment: asString(pick(entry, 'comment', 'name', 'title')).trim() || keys[0] || `条目 ${index + 1}`,
    keys,
    secondaryKeys,
    content,
    // `enabled` (V2) wins when present; otherwise `disable` (World Info) is inverted.
    enabled: enabledRaw === undefined ? disableRaw !== true : enabledRaw !== false,
    constant: pick(entry, 'constant') === true,
    selective: pick(entry, 'selective') === true,
    caseSensitive: pick(entry, 'case_sensitive', 'caseSensitive') === true,
    matchWholeWords: pick(entry, 'match_whole_words', 'matchWholeWords') === true,
    order: Number(pick(entry, 'insertion_order', 'order')) || 0,
    priority: Number(pick(entry, 'priority')) || 0,
    probability: Number(pick(entry, 'probability')) || 100,
  }
}

/**
 * Flatten a world-book document.
 * @param raw - the parsed JSON document.
 * @param meta - provenance recorded beside the book.
 */
export function normalizeWorldBook(raw, meta = {}) {
  const container = raw && typeof raw === 'object' ? (raw.entries ?? raw) : {}
  const list = []
  if (Array.isArray(container)) {
    container.forEach((entry, index) => {
      const normalized = normalizeEntry(entry, index)
      if (normalized) list.push(normalized)
    })
  } else if (container && typeof container === 'object') {
    Object.keys(container).forEach((key, index) => {
      const normalized = normalizeEntry(container[key], index)
      if (normalized) list.push(normalized)
    })
  }
  return {
    id: meta.id,
    name: asString(pick(raw, 'name', 'comment')).trim() || meta.name || '未命名世界书',
    source: meta.source || 'import',
    importedAt: meta.importedAt || new Date().toISOString(),
    entries: list,
  }
}

/** Build a world book from a card's embedded `character_book`. */
export function worldBookFromCharacterBook(book, meta = {}) {
  return normalizeWorldBook(book, { ...meta, source: 'character_book' })
}

/** Parse a world-book JSON buffer, with a message a human can act on. */
export function readWorldBookDocument(bytes, fileName = '') {
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`世界书必须是 JSON 文件（${String((error && error.message) || error)}）`)
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('世界书 JSON 必须是一个对象')
  const book = normalizeWorldBook(parsed, { name: fileName.replace(/\.json$/iu, '') })
  if (book.entries.length === 0) throw new Error('这个世界书里没有任何可用条目')
  return book
}

function matches(text, needle, caseSensitive, wholeWords) {
  if (needle.length === 0) return false
  if (caseSensitive) {
    return wholeWords ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(text) : text.includes(needle)
  }
  const haystack = text.toLowerCase()
  const target = needle.toLowerCase()
  return wholeWords ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(target)}(?![\\p{L}\\p{N}])`, 'u').test(haystack) : haystack.includes(target)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Pick the entries a piece of transcript activates.
 *
 * Ordering is `priority` then `order` descending, which is how SillyTavern
 * ranks insertion; the budget is a character cap so one enormous book cannot
 * crowd out the conversation.
 */
export function selectLore(books, transcript, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 12
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 6000
  const matched = []
  const seen = new Set()
  for (const book of books || []) {
    if (!book) continue
    for (const entry of book.entries || []) {
      if (!entry.enabled) continue
      const isConstant = entry.constant
      let hit = isConstant
      if (!hit && entry.keys.length > 0) {
        hit = entry.keys.some((key) => matches(transcript, key, entry.caseSensitive, entry.matchWholeWords))
      }
      // A selective entry only fires when a secondary key is present too.
      if (hit && entry.selective && entry.secondaryKeys.length > 0) {
        hit = entry.secondaryKeys.some((key) => matches(transcript, key, entry.caseSensitive, entry.matchWholeWords))
      }
      if (!hit) continue
      const dedupe = `${book.id}\u0000${entry.id}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      matched.push({ book, entry })
    }
  }
  matched.sort((a, b) => (b.entry.priority - a.entry.priority) || (b.entry.order - a.entry.order) || a.entry.comment.localeCompare(b.entry.comment))
  const chosen = []
  let budget = maxChars
  for (const item of matched) {
    if (chosen.length >= maxEntries) break
    const cost = item.entry.content.length
    // The highest-ranked entry is always injected, even if it alone exceeds the
    // budget: a preset whose whole premise lives in one long entry must still
    // work, and injecting nothing is the worse failure. Every later entry is
    // strictly budgeted.
    if (cost > budget && chosen.length > 0) continue
    budget -= cost
    chosen.push(item)
  }
  return chosen
}

/** Render the selected entries as prompt context, stable order for KV-cache reuse. */
export function renderLore(items) {
  if (!items || items.length === 0) return ''
  const unique = new Map()
  for (const item of items) {
    const key = `${item.book.id}\u0000${item.entry.id}`
    if (!unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()]
    .map((item) => `【${item.entry.comment}】\n${item.entry.content}`)
    .join('\n\n')
}
