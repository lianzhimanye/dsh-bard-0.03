/**
 * dsh-bard — Bard-style role-play for DeepSeek Harness.
 *
 * The Host half owns four things:
 *
 *  1. **Storage** of character cards, world books and Bard presets
 *     (`lib/store.js`, under `$DSH_HOME/bard/`).
 *  2. **Native DSH agent presets.** Every Bard preset is registered with
 *     `ctx.agentPresets` as an ordinary `@deepseek-ai/dsh-agent-preset`
 *     declaration whose `@deepseek-ai/dsh-persona` row carries the rendered
 *     character. Selecting it in the session's preset picker is therefore all a
 *     user has to do — no Bard-specific session mode exists or is needed.
 *     The *rest* of the plugin list is copied from the profile's own default
 *     preset so the character keeps a real working toolset.
 *  3. **World-book activation.** For every Agent that selected a Bard preset,
 *     a scoped `systemPrompt.context()` is registered on that agent's context;
 *     its thunk matches lorebook keys against the session's recent transcript.
 *  4. **A UI API** (`/dsh-bard/api/*`) plus the `/bard` command, so the same
 *     operations are available from the settings page, from chat, and from a
 *     script.
 */

import fs from 'node:fs'
import {
  ensureDirs,
  listCards,
  getCard,
  putCard,
  deleteCard,
  listWorldBooks,
  getWorldBook,
  putWorldBook,
  deleteWorldBook,
  listPresets,
  getPreset,
  putPreset,
  deletePreset,
  putPortrait,
  portraitPath,
  putRenderedCard,
  deleteRenderedCard,
  makeId,
} from './store.js'
import {
  readCardDocument,
  normalizeCard,
  cardGreetings,
  isPng,
  updateCardEditable,
  isRedundantField,
  detectCardLanguage,
} from './cards.js'
import {
  readWorldBookDocument,
  worldBookFromCharacterBook,
  selectLore,
  renderLore,
} from './lorebook.js'
import { buildPersonaPrefix, describeCard, DEFAULT_STYLE_HINT } from './persona.js'
import { interpolateCard, DEFAULT_USER_NAME } from './interpolate.js'

/** Cordis plugin name. */
export const name = 'bard'
/** The browser carrier this plugin needs before it can expose its API. */
export const inject = ['webServer']

/** Preset identities this plugin owns, so they are never confused with others. */
const PRESET_PREFIX = 'bard-'
/** Roster order for generated agent presets — after the shipped ones. */
const PRESET_ORDER_BASE = 50
/**
 * Row-name hints that identify a plugin which registers model-callable tools.
 * When a Bard preset turns tool calling off, rows matching any hint are
 * dropped from the generated agent preset, so the model request never carries
 * a `tools` array — which is what makes text-only models answer with HTTP 400.
 *
 * Add more hints here if your default preset mounts tool providers under
 * other names (e.g. a code-mode plugin).
 */
const TOOL_ROW_HINTS = ['dsh-tool-', 'dsh-skill-']

/** True when a preset plugin row provides model-callable tools. */
function isToolRow(row) {
  if (!row || typeof row.name !== 'string') return false
  return TOOL_ROW_HINTS.some((hint) => row.name.includes(hint))
}
/** Bounds on an upload, in bytes. */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024
/** How many recent transcript excerpts the lore matcher scans. */
const RECENT_LIMIT = 24
/** Prompt-context order: after sandbox/approval/subagent policy (110-120). */
const LORE_CONTEXT_ORDER = 130
const LORE_CONTEXT_NAME = 'bard:world-book'
/**
 * The tool list is injected as a prompt *variable*, not a section.
 *
 * A section is atomic at the top level of the prompt: `systemPrompt` sorts
 * sections against each other and joins them with blank lines, so nothing can
 * ever land *inside* the persona prefix — the list would sit next to the
 * persona, not under its last sentence. A prompt variable is substituted into
 * a section's text while that section is rendered, so writing
 * `{{bard_tools}}` at the bottom of the persona prefix puts the list exactly
 * there. The variable also survives a persona row registered with
 * `complete: true`: that flag discards every other *section*, but the persona
 * text itself — variable reference included — is still interpolated.
 *
 * The name must match /^[a-z][a-z0-9_]*$/; DSH rejects anything else at
 * registration time. There is no order to pick: variables are not placed,
 * they are referenced.
 */
const TOOL_LIST_VARIABLE_NAME = 'bard_tools'

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** The model-visible text of one committed session event, or ''. */
function eventText(event) {
  const type = event && event.type
  if (type === 'user/message') return textOf(event.data && event.data.content)
  if (type === 'assistant/message') return textOf(event.data && event.data.message && event.data.message.content)
  return ''
}

function readBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体过大（上限 ${Math.round(limit / 1024 / 1024)} MiB）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch (error) {
    throw new Error(`请求体不是合法 JSON（${String((error && error.message) || error)}）`)
  }
}

/** Decode the `{ dataUrl }` or `{ base64 }` payload the settings page sends. */
function bytesFromPayload(payload) {
  const dataUrl = typeof payload.dataUrl === 'string' ? payload.dataUrl : ''
  if (dataUrl.length > 0) {
    const comma = dataUrl.indexOf(',')
    const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
    return Buffer.from(body, 'base64')
  }
  if (typeof payload.base64 === 'string') return Buffer.from(payload.base64, 'base64')
  if (typeof payload.text === 'string') return Buffer.from(payload.text, 'utf8')
  throw new Error('缺少文件内容（dataUrl / base64 / text）')
}

// ---------------------------------------------------------------------------
// presentation snapshots
// ---------------------------------------------------------------------------

function cardSummary(card) {
  return {
    id: card.id,
    name: card.name,
    spec: card.spec,
    specVersion: card.specVersion,
    container: card.container,
    importedAt: card.importedAt,
    creator: card.creator,
    characterVersion: card.characterVersion,
    tags: card.tags,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    firstMes: card.firstMes,
    alternateGreetings: card.alternateGreetings,
    mesExample: card.mesExample,
    systemPrompt: card.systemPrompt,
    postHistoryInstructions: card.postHistoryInstructions,
    creatorNotes: card.creatorNotes,
    hasCharacterBook: card.characterBook !== null,
    greetingCount: cardGreetings(card).length,
  }
}

function worldBookSummary(book) {
  const entries = book.entries || []
  return {
    id: book.id,
    name: book.name,
    source: book.source,
    importedAt: book.importedAt,
    entryCount: entries.length,
    enabledCount: entries.filter((entry) => entry.enabled).length,
    constantCount: entries.filter((entry) => entry.enabled && entry.constant).length,
    keywordCount: entries.filter((entry) => entry.enabled && !entry.constant && entry.keys.length > 0).length,
  }
}

function skillSummary(skill) {
  return {
    name: skill.name,
    description: skill.description || '',
    whenToUse: skill.whenToUse || '',
    source: skill.source || 'unknown',
    provider: skill.provider || 'unknown',
  }
}

// ---------------------------------------------------------------------------
// the plugin
// ---------------------------------------------------------------------------

export function apply(ctx) {
  ensureDirs()

  const runtime = {
    /** Diagnostics from the last preset synchronisation, shown in the UI. */
    errors: [],
    /** sessionId -> recent transcript excerpts, newest last. */
    recent: new Map(),
    /** sessionId -> disposer for that agent's scoped lore context. */
    loreDisposers: new Map(),
    /** agentId -> disposer for that agent's tool-list context. */
    toolListDisposers: new Map(),
    /** Disposers for the agent presets this plugin currently owns. */
    presetDisposers: [],
    /** Serialises preset synchronisation. */
    syncing: Promise.resolve(),
  }

  // -- transcript memory ---------------------------------------------------

  ctx.on('session/event', (session, event) => {
    if (!session) return
    const text = eventText(event)
    if (text.trim().length === 0) return
    const list = runtime.recent.get(session.id) || []
    list.push(text)
    while (list.length > RECENT_LIMIT) list.shift()
    runtime.recent.set(session.id, list)
  })
  ctx.on('session/disposed', (session) => {
    if (session) runtime.recent.delete(session.id)
  })

  // -- per-agent world-book context ---------------------------------------

  /**
   * Per-agent world-book context.
   *
   * Scope matters here for the same reason it matters for the tool list: the
   * `systemPrompt` service must be read from `agent.ctx`, not from the
   * plugin's own `ctx`. `systemPrompt.context()` registers into the layer of
   * whatever context the service was accessed through; the plugin's ctx has
   * no scope tag, so the entry would land in the GLOBAL layer while the
   * effect that owns it (`agent.ctx.effect`) dies with the agent — a
   * lifecycle mismatch that silently disabled lore injection entirely.
   *
   * Registered unconditionally, like the tool list, and for the same reason:
   * at `agent/created` the Bard preset has not been applied yet, so any
   * early-exit check on the composed preset id disables the feature entirely.
   * The preset lookup now happens inside the thunk, which runs before each
   * request — after the preset is live.
   *
   * The context is intentionally NOT cached: `loreTextFor` re-selects entries
   * against the session's latest transcript every turn, which is the whole
   * point of keyword-triggered lore.
   */
  function registerAgentLore(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) {
      runtime.errors.push(`world-book: systemPrompt 服务在 agent ${agent.id} 的 ctx 上不可用`)
      return () => {}
    }
    let thunkErrorReported = false
    let dispose
    try {
      dispose = agent.ctx.effect(() => systemPrompt.context({
        name: LORE_CONTEXT_NAME,
        order: LORE_CONTEXT_ORDER,
        text: () => {
          try {
            const presetsService = agent.ctx.get('agentPresets')
            if (!presetsService) return ''
            const composed = presetsService.composedPreset(agent.ctx)
            if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) return ''
            const bardPresetId = composed.slice(PRESET_PREFIX.length)
            if (!getPreset(bardPresetId)) return ''
            return loreTextFor(runtime, bardPresetId, agent.id)
          } catch (error) {
            if (!thunkErrorReported) {
              thunkErrorReported = true
              runtime.errors.push(`world-book thunk for ${agent.id}: ${String((error && error.message) || error)}`)
            }
            return ''
          }
        },
      }), 'bard.world-book')
    } catch (error) {
      runtime.errors.push(`world-book context for ${agent.id}: ${String((error && error.message) || error)}`)
      return () => {}
    }
    return () => {
      try {
        dispose()
      } catch (error) {
        /* already disposed with the agent */
      }
    }
  }

  /**
   * Lazily rendered tool-list variable.
   *
   * Scope is the whole point of this function. `systemPrompt.variable()`
   * registers into the layer of whatever context the service was accessed
   * through — see `dsh-system-prompt`'s `variable()` calling
   * `this.layers.effect(this.ctx, …)` and `dsh-scope`'s `effect()` reading
   * `scopeOf(ctx)`. Accessing the service via the plugin's own `ctx` (no scope
   * tag) writes to the GLOBAL layer: the first agent would succeed, every
   * later agent would hit `NamedEntries`' "already registered" error, and the
   * value would never actually belong to any agent. So every service is
   * read from `agent.ctx`, and the effect ownership (`agent.ctx.effect`) then
   * matches the registration scope.
   *
   * `tools` is scoped per agent; reading it from the plugin's ctx returns the
   * global view (kernel-resident tools only, no read/write/pwsh). That was the
   * bug two revisions ago and is why this service must come from `agent.ctx`
   * as well.
   *
   * The variable is registered unconditionally for every agent; its provider is
   * evaluated by DSH before each model request. Everything that used to
   * happen at registration time now happens inside that provider, because at
   * `agent/created` the agent's ctx has not yet had the Bard preset applied:
   * `composedPreset()` returns the session's starting preset ("standard"), and
   * any early-exit check against PRESET_PREFIX would silently disable the
   * feature.
   *
   * DSH substitutes the returned string into `{{bard_tools}}` wherever a
   * section references it. Returning `''` for a non-Bard agent leaves the
   * reference site as empty text: no list line, no title, no token cost.
   *
   * The rendered string is cached per preset id: the provider still runs on every
   * assemble, but only recomputes when the composed preset actually changes.
   *
   * Respects the preset's own tool switch: when `enableTools` is false no list
   * is emitted — and the persona preamble, which is where `{{bard_tools}}`
   * lives, is omitted too, so the reference itself never reaches DSH.
   */
  function registerAgentToolList(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) {
      runtime.errors.push(`tool-list: systemPrompt 服务在 agent ${agent.id} 的 ctx 上不可用`)
      return () => {}
    }
    let cachedPresetId = null
    let cachedText = ''
    let thunkErrorReported = false
    const text = (context) => {
      try {
        const presetsService = agent.ctx.get('agentPresets')
        const tools = agent.ctx.get('tools')
        if (!presetsService || !tools) return ''
        const composed = presetsService.composedPreset(agent.ctx)
        if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) return ''
        const presetId = composed.slice(PRESET_PREFIX.length)
        if (presetId === cachedPresetId) return cachedText
        const bardPreset = getPreset(presetId)
        if (!bardPreset) return ''
        if (bardPreset.options && bardPreset.options.enableTools === false) return ''
        const schemas = tools.schemas(context && context.scope)
        if (!Array.isArray(schemas)) return ''
        const names = schemas
          .map((schema) => (schema && typeof schema.name === 'string' ? schema.name : ''))
          .filter((name) => name.length > 0)
        if (names.length === 0) return ''
        cachedPresetId = presetId
        cachedText = `\n\n你现在能用的工具：${names.join('、')}`
        return cachedText
      } catch (error) {
        // Report once per agent so a recurring per-turn failure does not flood
        // the diagnostics list.
        if (!thunkErrorReported) {
          thunkErrorReported = true
          runtime.errors.push(`tool-list thunk for ${agent.id}: ${String((error && error.message) || error)}`)
        }
        return ''
      }
    }
    let dispose
    try {
      dispose = agent.ctx.effect(() => systemPrompt.variable(TOOL_LIST_VARIABLE_NAME, text), 'bard.tool-list')
    } catch (error) {
      runtime.errors.push(`tool-list variable for ${agent.id}: ${String((error && error.message) || error)}`)
      return () => {}
    }
    return () => {
      try {
        dispose()
      } catch (error) {
        /* already disposed with the agent */
      }
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    runtime.loreDisposers.set(agent.id, registerAgentLore(agent))
    runtime.toolListDisposers.set(agent.id, registerAgentToolList(agent))
  })
  ctx.on('agent/disposed', ({ agent }) => {
    for (const [id, map] of [[agent.id, runtime.loreDisposers], [agent.id, runtime.toolListDisposers]]) {
      const dispose = map.get(id)
      map.delete(id)
      if (dispose) dispose()
    }
  })
  ctx.effect(() => () => {
    for (const map of [runtime.loreDisposers, runtime.toolListDisposers]) {
      for (const dispose of map.values()) {
        try {
          dispose()
        } catch (error) {
          /* ignore */
        }
      }
      map.clear()
    }
  }, 'bard.scoped-disposers')

  // -- services ------------------------------------------------------------

  ctx.inject(['agentPresets'], (scoped) => {
    const presetsService = scoped.agentPresets

    /** The plugin rows a generated preset should mount. */
    async function baseRows() {
      let defaultId
      try {
        const current = await presetsService.resolve()
        defaultId = current && current.id
      } catch (error) {
        defaultId = undefined
      }
      const editor = ctx.get('configEditor')
      if (editor && typeof editor.configuration === 'function') {
        try {
          const rows = editor.configuration()
          const candidates = rows.filter((row) => row
            && row.entry
            && row.entry.options
            && row.entry.options.name === '@deepseek-ai/dsh-agent-preset'
            && row.inherited
            && Array.isArray(row.inherited.plugins))
          if (candidates.length > 0) {
            const chosen = candidates.find((row) => row.inherited.id === defaultId) || candidates[0]
            return { source: `preset:${chosen.inherited.id}`, rows: structuredClone(chosen.inherited.plugins) }
          }
        } catch (error) {
          runtime.errors.push(`读取默认预设失败，已改用内置工具清单：${String((error && error.message) || error)}`)
        }
      }
      return { source: 'builtin', rows: builtinToolRows() }
    }

    /** Resolve the chosen Harness skills into full definitions. */
    async function resolveSkills(names) {
      const skillsService = ctx.get('skills')
      if (!skillsService || !Array.isArray(names) || names.length === 0) return []
      const out = []
      for (const skillName of names) {
        try {
          const definition = await skillsService.get(skillName, {})
          if (definition) out.push(definition)
        } catch (error) {
          runtime.errors.push(`技能「${skillName}」读取失败：${String((error && error.message) || error)}`)
        }
      }
      return out
    }

    /** Build the agent-preset declaration for one Bard preset. */
    async function buildDefinition(bardPreset, index) {
      const rawCard = getCard(bardPreset.cardId)
      if (!rawCard) {
        throw new Error(`角色卡已不存在（${bardPreset.cardId}）`)
      }
      const userName = (bardPreset.options && bardPreset.options.userName) || DEFAULT_USER_NAME
      const userGender = (bardPreset.options && bardPreset.options.userGender) || ''
      const card = interpolateCard(rawCard, { userName })
      const skills = await resolveSkills(bardPreset.skillNames)
      const enableTools = !(bardPreset.options && bardPreset.options.enableTools === false)
      const personaPrefix = buildPersonaPrefix(card, skills, {
        styleHint: bardPreset.options && bardPreset.options.styleHint ? bardPreset.options.styleHint : DEFAULT_STYLE_HINT,
        extraInstructions: bardPreset.options && bardPreset.options.extraInstructions,
        outputLanguage: bardPreset.options && bardPreset.options.outputLanguage,
        userGender,
        enableTools,
      })
      const base = await baseRows()
      const sourceRows = enableTools ? base.rows : base.rows.filter((row) => !isToolRow(row))
      const rows = sourceRows.map((row) => ({ ...row }))
      const personaConfig = {
        prefix: personaPrefix,
        complete: !!(bardPreset.options && bardPreset.options.complete),
        includeRuntimeContext: !(bardPreset.options && bardPreset.options.includeRuntimeContext === false),
      }
      const at = rows.findIndex((row) => row && row.name === '@deepseek-ai/dsh-persona')
      if (at >= 0) {
        rows[at] = { ...rows[at], disabled: false, config: { ...(rows[at].config || {}), ...personaConfig } }
      } else {
        rows.unshift({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: personaConfig })
      }
      return {
        id: `${PRESET_PREFIX}${bardPreset.id}`,
        name: `吟游 · ${bardPreset.name}`,
        description: describeCard(card, bardPreset.name),
        order: PRESET_ORDER_BASE + index,
        plugins: rows,
        __base: base.source,
      }
    }

    async function syncPresets() {
      const run = async () => {
        for (const dispose of runtime.presetDisposers.splice(0)) {
          try {
            await dispose()
          } catch (error) {
            /* the declaration is already gone */
          }
        }
        runtime.errors = []
        const bardPresets = listPresets()
        for (let index = 0; index < bardPresets.length; index++) {
          const bardPreset = bardPresets[index]
          let definition
          try {
            definition = await buildDefinition(bardPreset, index)
          } catch (error) {
            const reason = String((error && error.message) || error)
            bardPreset.lastBase = ''
            bardPreset.lastError = reason
            try {
              putPreset(bardPreset)
            } catch (writeError) {
              /* the record is unwritable; the runtime error below still reports it */
            }
            runtime.errors.push(`预设「${bardPreset.name}」无法生成：${reason}`)
            continue
          }
          const { __base, ...declaration } = definition
          bardPreset.lastBase = __base
          // Best-effort snapshot: a failed write must not abort preset sync.
          try {
            const snapshot = interpolateCard(getCard(bardPreset.cardId), {
              userName: (bardPreset.options && bardPreset.options.userName) || DEFAULT_USER_NAME,
            })
            if (snapshot) putRenderedCard(bardPreset.id, snapshot)
          } catch (error) {
            /* the snapshot is a convenience, never a requirement */
          }
          try {
            const dispose = await presetsService.register(declaration)
            runtime.presetDisposers.push(dispose)
            bardPreset.lastError = ''
          } catch (error) {
            bardPreset.lastError = String((error && error.message) || error)
            runtime.errors.push(`DSH 预设 ${declaration.id} 注册失败：${bardPreset.lastError}`)
          }
          // Persist the diagnostics: the settings page reads presets back from
          // disk, so in-memory-only fields would never reach it.
          try {
            putPreset(bardPreset)
          } catch (error) {
            /* a failed diagnostic write must not abort the remaining presets */
          }
        }
      }
      runtime.syncing = runtime.syncing.then(run, run)
      return runtime.syncing
    }

    runtime.syncPresets = syncPresets
    ctx.effect(() => () => {
      for (const dispose of runtime.presetDisposers.splice(0)) {
        try {
          dispose()
        } catch (error) {
          /* ignore */
        }
      }
    }, 'bard.preset-disposers')

    syncPresets().catch((error) => {
      runtime.errors.push(`预设同步失败：${String((error && error.message) || error)}`)
    })
  })

  // -- HTTP API ------------------------------------------------------------

  registerRoutes(ctx, runtime)

  // -- /bard command -----------------------------------------------------

  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'bard',
      description: 'Bard 角色扮演：查看当前角色、列出预设、输出角色卡开场白',
      input: { hint: '[list|greet <n>|card|presets]' },
      handler: (invocation) => runBardCommand(ctx, runtime, invocation),
    })
  })
}

// ---------------------------------------------------------------------------
// default toolset (used only when the profile's own default preset is unreadable)
// ---------------------------------------------------------------------------

function builtinToolRows() {
  const isWindows = process.platform === 'win32'
  return [
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: isWindows },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !isWindows },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  ]
}

// ---------------------------------------------------------------------------
// world-book activation
// ---------------------------------------------------------------------------

/** Render the lore a Bard preset's books activate for one session right now. */
function loreTextFor(runtime, bardPresetId, sessionId) {
  try {
    const bardPreset = getPreset(bardPresetId)
    if (!bardPreset) return ''
    const ids = Array.isArray(bardPreset.worldbookIds) ? bardPreset.worldbookIds : []
    if (ids.length === 0) return ''
    const books = ids.map((id) => getWorldBook(id)).filter(Boolean)
    if (books.length === 0) return ''
    const transcript = (runtime.recent.get(sessionId) || []).join('\n').slice(-8000)
    const options = bardPreset.options || {}
    const selected = selectLore(books, transcript, {
      maxEntries: Number.isFinite(options.maxEntries) ? options.maxEntries : 12,
      maxChars: Number.isFinite(options.maxChars) ? options.maxChars : 6000,
    })
    return renderLore(selected)
  } catch (error) {
    return ''
  }
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

function registerRoutes(ctx, runtime) {
  /** Reject anything that is not a same-origin request from this machine. */
  function denied(req, res) {
    try {
      const headers = req.headers || {}
      const host = String(headers.host || '')
      const hostname = host.replace(/:\d+$/u, '').toLowerCase().replace(/^\[|\]$/gu, '')
      const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
        || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)
      if (!loopback) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('bard: non-loopback Host')
        return true
      }
      const origin = headers.origin
      if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
        let originHost
        try {
          originHost = new URL(origin).host.toLowerCase()
        } catch (error) {
          originHost = undefined
        }
        if (!originHost || originHost !== host.toLowerCase()) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('bard: cross-origin request')
          return true
        }
      }
      return false
    } catch (error) {
      try {
        res.writeHead(403)
        res.end()
      } catch (inner) {
        /* the socket is already gone */
      }
      return true
    }
  }

  /** Wrap a JSON endpoint with the fence and uniform error reporting. */
  function route(kind, path, handler) {
    return ctx.webServer.register({
      kind,
      path,
      handler: async (req, res) => {
        if (denied(req, res)) return
        try {
          await handler(req, res)
        } catch (error) {
          json(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    })
  }

  const disposers = []
  const add = (kind, path, handler) => disposers.push(route(kind, path, handler))
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        /* ignore */
      }
    }
  }, 'bard.routes')

  function skillsService() {
    return ctx.get('skills')
  }

  async function presentSkills() {
    const service = skillsService()
    if (!service) return []
    try {
      const list = await service.list({})
      return list.map(skillSummary)
    } catch (error) {
      runtime.errors.push(`技能目录读取失败：${String((error && error.message) || error)}`)
      return []
    }
  }

  async function snapshot() {
    const cards = listCards()
    const worldbooks = listWorldBooks()
    const presets = listPresets()
    return {
      ok: true,
      home: 'bard',
      storage: undefined,
      cards: cards.map(cardSummary),
      worldbooks: worldbooks.map(worldBookSummary),
      presets: presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description || '',
        cardId: preset.cardId,
        cardName: (getCard(preset.cardId) || {}).name || '(已删除)',
        worldbookIds: preset.worldbookIds || [],
        skillNames: preset.skillNames || [],
        options: preset.options || {},
        createdAt: preset.createdAt,
        updatedAt: preset.updatedAt,
        dshPresetId: `${PRESET_PREFIX}${preset.id}`,
        base: preset.lastBase || '',
        error: preset.lastError || '',
      })),
      skills: await presentSkills(),
      errors: runtime.errors.slice(0, 20),
    }
  }

  add('exact', '/dsh-bard/api/state', async (req, res) => {
    json(res, 200, await snapshot())
  })

  add('exact', '/dsh-bard/api/card', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const bytes = bytesFromPayload(payload)
    const fileName = typeof payload.fileName === 'string' ? payload.fileName : ''
    const read = readCardDocument(bytes, fileName)
    const id = makeId(payload.name || fileName || 'card')
    const card = normalizeCard(read.raw, {
      id,
      name: typeof payload.name === 'string' && payload.name.trim().length > 0
        ? payload.name.trim()
        : fileName.replace(/\.[a-z0-9]+$/iu, ''),
      container: read.container,
      source: read.keyword ? `png:${read.keyword}` : 'json',
      importedAt: new Date().toISOString(),
    })
    let portrait = ''
    if (isPng(bytes)) {
      try {
        portrait = putPortrait(id, bytes)
      } catch (error) {
        runtime.errors.push(`头像保存失败：${String((error && error.message) || error)}`)
      }
    }
    card.portrait = portrait
    putCard(card)
    return json(res, 200, { ok: true, card: cardSummary(card), hasCharacterBook: card.characterBook !== null })
  })

  add('exact', '/dsh-bard/api/card/delete', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.id !== 'string') return json(res, 400, { ok: false, error: '缺少 id' })
    const used = listPresets().filter((preset) => preset.cardId === payload.id).map((preset) => preset.name)
    if (used.length > 0 && payload.force !== true) {
      return json(res, 200, { ok: false, error: `该角色卡仍被预设使用：${used.join('、')}`, inUse: used })
    }
    const removed = deleteCard(payload.id)
    if (removed) await runtime.syncPresets?.()
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/card/book', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const card = getCard(payload.id)
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    if (!card.characterBook) return json(res, 200, { ok: false, error: '这张角色卡没有内嵌世界书' })
    const id = makeId(`${card.name}-book`)
    const book = worldBookFromCharacterBook(card.characterBook, { id, name: `${card.name} 世界观` })
    putWorldBook(book)
    return json(res, 200, { ok: true, book: worldBookSummary(book), ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/card/detail', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const card = getCard(payload.id)
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    return json(res, 200, { ok: true, card })
  })

  add('exact', '/dsh-bard/api/card/update', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const card = getCard(payload.id)
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
    const next = updateCardEditable(card, patch)
    putCard(next)
    // The card's rendered persona feeds every preset that references it, so a
    // rename or a description edit must propagate through preset resync —
    // otherwise the running DSH agent preset keeps the old prefix.
    await runtime.syncPresets?.()
    return json(res, 200, { ok: true, card: cardSummary(next), ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/worldbook', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const bytes = bytesFromPayload(payload)
    const fileName = typeof payload.fileName === 'string' ? payload.fileName : ''
    const parsed = readWorldBookDocument(bytes, fileName)
    const id = makeId(payload.name || parsed.name || 'book')
    const book = { ...parsed, id, name: (typeof payload.name === 'string' && payload.name.trim()) || parsed.name, importedAt: new Date().toISOString() }
    putWorldBook(book)
    return json(res, 200, { ok: true, book: worldBookSummary(book) })
  })

  add('exact', '/dsh-bard/api/worldbook/detail', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const book = getWorldBook(payload.id)
    if (!book) return json(res, 404, { ok: false, error: '找不到世界书' })
    return json(res, 200, { ok: true, book })
  })

  add('exact', '/dsh-bard/api/worldbook/delete', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.id !== 'string') return json(res, 400, { ok: false, error: '缺少 id' })
    const removed = deleteWorldBook(payload.id)
    if (removed) await runtime.syncPresets?.()
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/preset', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.cardId !== 'string' || !getCard(payload.cardId)) {
      return json(res, 400, { ok: false, error: '请先选择一个角色卡' })
    }
    const name = typeof payload.name === 'string' && payload.name.trim().length > 0
      ? payload.name.trim()
      : (getCard(payload.cardId) || {}).name || '未命名'
    const existing = typeof payload.id === 'string' ? getPreset(payload.id) : undefined
    const now = new Date().toISOString()
    const preset = {
      id: existing ? existing.id : makeId(name),
      name,
      description: typeof payload.description === 'string' ? payload.description : '',
      cardId: payload.cardId,
      worldbookIds: Array.isArray(payload.worldbookIds) ? payload.worldbookIds.filter((id) => typeof id === 'string') : [],
      skillNames: Array.isArray(payload.skillNames) ? payload.skillNames.filter((id) => typeof id === 'string') : [],
      options: {
        styleHint: typeof payload.styleHint === 'string' ? payload.styleHint : DEFAULT_STYLE_HINT,
        extraInstructions: typeof payload.extraInstructions === 'string' ? payload.extraInstructions : '',
        complete: payload.complete === true,
        includeRuntimeContext: payload.includeRuntimeContext !== false,
        enableTools: payload.enableTools !== false,
        userName: typeof payload.userName === 'string' ? payload.userName.trim() : '',
        userGender: typeof payload.userGender === 'string' ? payload.userGender.trim() : '',
        outputLanguage: typeof payload.outputLanguage === 'string' ? payload.outputLanguage.trim() : '',
        maxEntries: Number.isFinite(payload.maxEntries) ? payload.maxEntries : 12,
        maxChars: Number.isFinite(payload.maxChars) ? payload.maxChars : 6000,
      },
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    }
    putPreset(preset)
    await runtime.syncPresets?.()
    const after = getPreset(preset.id)
    return json(res, 200, { ok: true, presetId: preset.id, dshPresetId: `${PRESET_PREFIX}${preset.id}`, error: (after && after.lastError) || '', ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/preset/delete', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.id !== 'string') return json(res, 400, { ok: false, error: '缺少 id' })
    const removed = deletePreset(payload.id)
    if (removed) {
      try {
        deleteRenderedCard(payload.id)
      } catch (error) {
        /* the snapshot is already gone */
      }
      await runtime.syncPresets?.()
    }
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/preset/preview', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const rawCard = getCard(payload.cardId)
    if (!rawCard) return json(res, 404, { ok: false, error: '找不到角色卡' })
    const userName = typeof payload.userName === 'string' && payload.userName.trim().length > 0
      ? payload.userName.trim()
      : DEFAULT_USER_NAME
    const card = interpolateCard(rawCard, { userName })
    const prefix = buildPersonaPrefix(card, [], {
      styleHint: typeof payload.styleHint === 'string' ? payload.styleHint : DEFAULT_STYLE_HINT,
      extraInstructions: typeof payload.extraInstructions === 'string' ? payload.extraInstructions : '',
      outputLanguage: typeof payload.outputLanguage === 'string' ? payload.outputLanguage.trim() : '',
      userGender: typeof payload.userGender === 'string' ? payload.userGender.trim() : '',
    })
    const cardLanguage = detectCardLanguage(rawCard)
    // Rough token estimate. The plugin carries no tokenizer, so this is an
    // order-of-magnitude hint, not a billing figure. CJK runs about 1 token
    // per 1.5-2 characters; Latin about 1 per 4.
    const divisor = cardLanguage === '中文' || cardLanguage === '日文' || cardLanguage === '韩文' ? 1.6 : 3.8
    const tokenEstimate = Math.round(prefix.length / divisor)
    // Section breakdown: split on top-level `## ` headers. The first chunk
    // (before any header) is the identity statement — label it explicitly
    // instead of letting it masquerade as a section.
    const parts = prefix.split(/^## /mu)
    const sections = []
    if (parts.length > 0 && parts[0].trim().length > 0) {
      sections.push({ name: '身份声明', chars: parts[0].trim().length })
    }
    for (let i = 1; i < parts.length; i += 1) {
      const chunk = parts[i]
      const text = chunk.trim()
      if (text.length === 0) continue
      const newline = text.indexOf('\n')
      const name = newline >= 0 ? text.slice(0, newline).trim() : text
      if (name.length === 0) continue
      // Add back the `## ` prefix the split consumed so the character totals
      // add up to the full prefix length.
      sections.push({ name, chars: chunk.length + 3 })
    }
    const warnings = []
    const usesUserMacro = /\{\{user\}\}/iu.test(rawCard.description || '')
      || /\{\{user\}\}/iu.test(rawCard.scenario || '')
      || /\{\{user\}\}/iu.test(rawCard.personality || '')
    if (usesUserMacro && userName === DEFAULT_USER_NAME) {
      warnings.push('这张卡使用了 {{user}}，但预设里没有设置「你的名字」。建议填写，否则替换值会是字面量 "User"。')
    }
    if (isRedundantField(rawCard.description, rawCard.scenario)) {
      warnings.push('「场景」与「角色简介」高度重复，persona 前缀已自动跳过「场景」section。')
    }
    if (tokenEstimate > 2500) {
      warnings.push(`persona 前缀约 ${tokenEstimate} token，比较长。可考虑精简卡片内容，或在角色卡编辑页拆分字段。`)
    }
    return json(res, 200, {
      ok: true,
      prefix,
      sections,
      chars: prefix.length,
      tokenEstimate,
      cardLanguage,
      warnings,
    })
  })

  add('exact', '/dsh-bard/api/greeting', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    let card = null
    if (typeof payload.cardId === 'string') card = getCard(payload.cardId)
    if (!card && typeof payload.presetId === 'string') {
      const preset = getPreset(payload.presetId)
      if (preset) card = getCard(preset.cardId)
    }
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    const greetings = cardGreetings(card)
    const index = Number.isInteger(payload.index) ? payload.index : 0
    const chosen = greetings[index] || greetings[0]
    if (!chosen) return json(res, 200, { ok: false, error: '这张角色卡没有开场白', greetings: [] })
    return json(res, 200, { ok: true, label: chosen.label, text: chosen.text, greetings })
  })

  add('prefix', '/dsh-bard/api/portrait', async (req, res) => {
    const id = new URL(req.url, 'http://x').pathname.split('/').pop()
    const file = portraitPath(id)
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('no portrait')
    }
    const bytes = fs.readFileSync(file)
    const ext = file.split('.').pop().toLowerCase()
    const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) })
    res.end(bytes)
  })
}

// ---------------------------------------------------------------------------
// /bard command
// ---------------------------------------------------------------------------

async function runBardCommand(ctx, runtime, invocation) {
  const raw = String(invocation.rawInput || '').trim()
  const [head] = raw.split(/\s+/u)
  const verb = (head || '').toLowerCase()

  const agentPresets = ctx.get('agentPresets')
  let composed
  try {
    composed = agentPresets && invocation.agent ? agentPresets.composedPreset(invocation.agent.ctx) : undefined
  } catch (error) {
    composed = undefined
  }
  const activeId = typeof composed === 'string' && composed.startsWith(PRESET_PREFIX) ? composed.slice(PRESET_PREFIX.length) : ''
  const active = activeId ? getPreset(activeId) : undefined

  if (verb === 'list' || verb === 'presets' || verb === '') {
    const presets = listPresets()
    const lines = ['Bard 预设：']
    if (presets.length === 0) lines.push('（还没有预设。请在 设置 → 吟游 里导入角色卡并保存预设）')
    for (const preset of presets) {
      const card = getCard(preset.cardId)
      const marks = [preset.id === activeId ? '← 当前会话' : '', `${(preset.worldbookIds || []).length} 本世界书`, `${(preset.skillNames || []).length} 个技能`]
        .filter(Boolean).join('，')
      lines.push(`· ${preset.name} — ${card ? card.name : '(角色卡已删除)'}（${marks}）`)
    }
    lines.push('', '用法：/bard greet [序号] 输出开场白；/bard card 查看当前角色。')
    return { kind: 'success', text: lines.join('\n') }
  }

  if (verb === 'card') {
    if (!active) return { kind: 'error', text: '当前会话没有使用 Bard 预设。请在会话的预设选择器里选择「吟游 · …」。' }
    const card = getCard(active.cardId)
    if (!card) return { kind: 'error', text: '这个预设引用的角色卡已被删除。' }
    return {
      kind: 'success',
      text: [
        `角色：${card.name}`,
        card.creator ? `作者：${card.creator}` : '',
        card.tags.length ? `标签：${card.tags.join('、')}` : '',
        card.description ? `\n简介：\n${card.description}` : '',
        `\n世界书：${(active.worldbookIds || []).length} 本 · 技能：${(active.skillNames || []).length} 个 · 开场白：${cardGreetings(card).length} 条`,
      ].filter(Boolean).join('\n'),
    }
  }

  if (verb === 'greet') {
    const target = active || listPresets()[0]
    if (!target) return { kind: 'error', text: '还没有 Bard 预设，无法输出开场白。' }
    const card = getCard(target.cardId)
    if (!card) return { kind: 'error', text: '这个预设引用的角色卡已被删除。' }
    const greetings = cardGreetings(card)
    if (greetings.length === 0) return { kind: 'error', text: `「${card.name}」这张角色卡没有开场白。` }
    const rest = raw.slice(head.length).trim()
    const index = rest.length > 0 && /^\d+$/u.test(rest) ? Number(rest) : 0
    const chosen = greetings[index] || greetings[0]
    return {
      kind: 'success',
      text: [`【${card.name} · ${chosen.label}】`, '', chosen.text].join('\n'),
    }
  }

  return { kind: 'error', text: `未知参数「${verb}」。用法：/bard [list|card|greet <序号>]` }
}
