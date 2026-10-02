/**
 * Tavern storage.
 *
 * Everything the plugin owns lives under `$DSH_HOME/tavern/` as plain files, so
 * it survives plugin upgrades, needs no storage backend, and stays inspectable
 * (and hand-editable) by the user:
 *
 *   cards/<id>.json        normalized character cards
 *   worldbooks/<id>.json   normalized world books
 *   portraits/<id>.<ext>   the original PNG of an imported PNG card
 *   presets/<id>.json      a card + world books + skills, i.e. what becomes a
 *                          native DSH agent preset
 *
 * Writes are atomic (temp file + rename) so a crash can never leave a truncated
 * record that would silently drop a card on the next read.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const KINDS = ['cards', 'worldbooks', 'portraits', 'presets', 'rendered']

export function tavernRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'tavern')
}

export function tavernDirs() {
  const root = tavernRoot()
  const dirs = { root }
  for (const kind of KINDS) dirs[kind] = path.join(root, kind)
  return dirs
}

export function ensureDirs() {
  const dirs = tavernDirs()
  for (const kind of KINDS) fs.mkdirSync(dirs[kind], { recursive: true, mode: 0o700 })
  return dirs
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return undefined
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

/** A readable, collision-proof identifier derived from a display name. */
export function makeId(name) {
  const ascii = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 24)
  const digest = createHash('sha1').update(`${name}\u0000${randomUUID()}`).digest('hex').slice(0, 6)
  return `${ascii || 'item'}-${digest}`
}

function listRecords(kind) {
  const dir = tavernDirs()[kind]
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const value = readJson(path.join(dir, name))
    if (value && typeof value === 'object') out.push(value)
  }
  return out
}

function getRecord(kind, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(id)) return undefined
  return readJson(path.join(tavernDirs()[kind], `${id}.json`))
}

function putRecord(kind, id, value) {
  writeJsonAtomic(path.join(tavernDirs()[kind], `${id}.json`), value)
  return value
}

function deleteRecord(kind, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(id)) return false
  try {
    fs.unlinkSync(path.join(tavernDirs()[kind], `${id}.json`))
    return true
  } catch (error) {
    return false
  }
}

export const listCards = () => listRecords('cards').sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)))
export const getCard = (id) => getRecord('cards', id)
export const putCard = (card) => putRecord('cards', card.id, card)
export const deleteCard = (id) => {
  deletePortrait(id)
  return deleteRecord('cards', id)
}

export const listWorldBooks = () => listRecords('worldbooks').sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)))
export const getWorldBook = (id) => getRecord('worldbooks', id)
export const putWorldBook = (book) => putRecord('worldbooks', book.id, book)
export const deleteWorldBook = (id) => deleteRecord('worldbooks', id)

export const listPresets = () => listRecords('presets').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
export const getPreset = (id) => getRecord('presets', id)
export const putPreset = (preset) => putRecord('presets', preset.id, preset)
export const deletePreset = (id) => deleteRecord('presets', id)

/**
 * Rendered card snapshots.
 *
 * One per Tavern preset — not one per card — because the same card renders
 * differently under different presets (the `{{user}}` substitution depends on
 * the preset's "your name"). The file name is the Tavern preset id, so deleting
 * a preset can delete its snapshot without a lookup table.
 */
export const listRenderedCards = () => listRecords('rendered')
export const getRenderedCard = (id) => getRecord('rendered', id)
export const putRenderedCard = (presetId, card) => putRecord('rendered', presetId, { ...card, presetId })
export const deleteRenderedCard = (id) => deleteRecord('rendered', id)

/** Persist the original PNG of an imported card so the UI can show it. */
export function putPortrait(id, bytes, ext = 'png') {
  const dir = ensureDirs().portraits
  const file = path.join(dir, `${id}.${ext}`)
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  return `/dsh-tavern/api/portrait/${id}`
}

export function portraitPath(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(id)) return undefined
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const file = path.join(tavernDirs().portraits, `${id}.${ext}`)
    if (fs.existsSync(file)) return file
  }
  return undefined
}

export function deletePortrait(id) {
  const file = portraitPath(id)
  if (!file) return
  try {
    fs.unlinkSync(file)
  } catch (error) {
    /* already gone */
  }
}
