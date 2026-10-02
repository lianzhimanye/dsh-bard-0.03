/**
 * dsh-tavern — Web settings page.
 *
 * Contributes one `settings.section` entry ("酒馆") that manages everything the
 * Host half stores: character cards, world books, the Harness skills a character
 * may use, and the Tavern presets that become native DSH agent presets.
 *
 * Deliberately dependency-free: only `react` is required, styling uses the
 * `--dsw-alias-*` theme tokens, and every operation goes through the Host's
 * `/dsh-tavern/api/*` endpoints so the page never reimplements storage rules.
 */

window.__ModuleLoader__.load({
  id: 'dsh-tavern',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/dsh-tavern/api'

    // -----------------------------------------------------------------------
    // data access
    // -----------------------------------------------------------------------

    async function call(path, body) {
      const init = body === undefined
        ? { headers: { Accept: 'application/json' } }
        : { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }
      let response
      try {
        response = await fetch(`${API}${path}`, init)
      } catch (error) {
        throw new Error(`无法连接插件服务：${String((error && error.message) || error)}`)
      }
      let data = {}
      try {
        data = await response.json()
      } catch (error) {
        data = {}
      }
      if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (HTTP ${response.status})`)
      return data
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }

    // -----------------------------------------------------------------------
    // styles
    // -----------------------------------------------------------------------

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: 1.6 },
      card: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      between: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      tabs: { display: 'flex', gap: '4px', borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: '6px', flexWrap: 'wrap' },
      tab: {
        border: '1px solid transparent', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
        borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', fontSize: '13px', font: 'inherit',
      },
      tabActive: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', fontWeight: 600,
      },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', borderRadius: '8px', padding: '5px 11px',
        cursor: 'pointer', fontSize: '12px', font: 'inherit',
      },
      primary: {
        border: '1px solid var(--dsw-alias-brand-primary)', background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)', borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', fontSize: '12px', font: 'inherit',
      },
      danger: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)', borderRadius: '8px', padding: '5px 11px',
        cursor: 'pointer', fontSize: '12px', font: 'inherit',
      },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', borderRadius: '8px', padding: '5px 9px',
        fontSize: '12px', font: 'inherit', width: '100%', boxSizing: 'border-box',
      },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', display: 'block', marginBottom: '3px' },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      item: {
        display: 'flex', gap: '10px', alignItems: 'flex-start', border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '10px',
      },
      thumb: { width: '48px', height: '48px', borderRadius: '8px', objectFit: 'cover', flex: '0 0 auto', background: 'var(--dsw-alias-bg-layer-2)' },
      grow: { flex: '1 1 240px', minWidth: '0' },
      name: { fontWeight: 600, fontSize: '13px' },
      pre: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '9px',
        fontSize: '12px', maxHeight: '320px', overflow: 'auto', margin: '6px 0 0',
      },
      alert: {
        border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)',
        borderRadius: '8px', padding: '8px 10px', fontSize: '12px', wordBreak: 'break-word',
      },
      ok: {
        border: '1px solid var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-state-success-primary)',
        borderRadius: '8px', padding: '8px 10px', fontSize: '12px',
      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '6px' },
      check: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' },
      fieldset: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px', padding: '10px', margin: '0' },
      legend: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', padding: '0 5px' },
      tag: {
        display: 'inline-block', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '999px',
        padding: '0 7px', marginRight: '4px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)',
      },
    }

    function Field(props) {
      return h('label', { style: { display: 'block', marginBottom: '8px' } }, [
        h('span', { key: 'l', style: S.label }, props.label),
        props.children,
      ])
    }

    function Btn(props) {
      const style = props.variant === 'primary' ? { ...S.primary, ...(props.style || {}) }
        : props.variant === 'danger' ? { ...S.danger, ...(props.style || {}) }
          : { ...S.button, ...(props.style || {}) }
      return h('button', {
        type: 'button', style, disabled: props.disabled === true, onClick: props.onClick, title: props.title,
      }, props.children)
    }

    // -----------------------------------------------------------------------
    // copy-to-clipboard greeting block
    // -----------------------------------------------------------------------

    function GreetingBlock(props) {
      const [copied, setCopied] = useState('')
      const greetings = props.greetings || []
      const [index, setIndex] = useState(0)
      if (greetings.length === 0) {
        return h('div', { style: S.muted }, '这张角色卡没有开场白（first_mes 为空）。')
      }
      const current = greetings[Math.min(index, greetings.length - 1)]
      const copy = () => {
        const done = () => { setCopied('已复制到剪贴板'); setTimeout(() => setCopied(''), 2000) }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(current.text).then(done, () => setCopied('复制失败，请手动选择文本'))
            return
          }
        } catch (error) {
          /* fall through to the manual path */
        }
        setCopied('（浏览器未授权剪贴板，请手动选择文本）')
      }
      return h('div', null, [
        h('div', { key: 'bar', style: { ...S.row, marginBottom: '4px' } }, [
          h('select', {
            key: 'sel', style: { ...S.input, width: 'auto' }, value: String(index),
            onChange: (event) => setIndex(Number(event.target.value)),
          }, greetings.map((greeting, at) => h('option', { key: at, value: String(at) }, greeting.label))),
          h(Btn, { key: 'copy', onClick: copy }, '复制开场白'),
          copied ? h('span', { key: 'st', style: S.muted }, copied) : null,
        ]),
        h('pre', { key: 'txt', style: S.pre }, current.text),
      ])
    }

    // -----------------------------------------------------------------------
    // cards tab
    // -----------------------------------------------------------------------

    function CardsTab(props) {
      const { state, reload, notify } = props
      const [openId, setOpenId] = useState('')
      const fileRef = useRef(null)
      const [busy, setBusy] = useState(false)

      const onFiles = async (event) => {
        const files = Array.from(event.target.files || [])
        event.target.value = ''
        if (files.length === 0) return
        setBusy(true)
        try {
          for (const file of files) {
            const dataUrl = await readFileAsDataUrl(file)
            const result = await call('/card', { dataUrl, fileName: file.name })
            notify(`已导入角色卡「${result.card.name}」${result.hasCharacterBook ? '（含内嵌世界书）' : ''}`)
          }
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const remove = async (card) => {
        if (!window.confirm(`删除角色卡「${card.name}」？使用它的预设会失效。`)) return
        setBusy(true)
        try {
          await call('/card/delete', { id: card.id, force: true })
          notify(`已删除「${card.name}」`)
          if (openId === card.id) setOpenId('')
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const importBook = async (card) => {
        setBusy(true)
        try {
          const result = await call('/card/book', { id: card.id })
          notify(`已从「${card.name}」导入世界书「${result.book.name}」（${result.book.entryCount} 条）`)
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const open = state.cards.find((card) => card.id === openId)

      return h('div', { style: S.list }, [
        h('div', { key: 'imp', style: S.card }, [
          h('div', { key: 'a', style: S.between }, [
            h('span', { key: 't', style: S.name }, '导入角色卡'),
            h(Btn, { key: 'b', variant: 'primary', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, busy ? '处理中…' : '选择文件'),
          ]),
          h('div', { key: 'b', style: { ...S.muted, marginTop: '4px' } },
            '支持 SillyTavern 角色卡：PNG（内嵌 chara / ccv3 数据块）或 JSON（Character Card V1 / V2 / V3）。可以一次选多个文件。'),
          h('input', {
            key: 'f', ref: fileRef, type: 'file', multiple: true, style: { display: 'none' },
            accept: '.json,.png,.webp,.jpg,.jpeg,application/json,image/png,image/jpeg,image/webp',
            onChange: onFiles,
          }),
        ]),

        state.cards.length === 0
          ? h('div', { key: 'empty', style: S.muted }, '还没有角色卡。')
          : state.cards.map((card) => h('div', { key: card.id, style: S.item }, [
            card.portrait
              ? h('img', { key: 'p', src: card.portrait, style: S.thumb, alt: card.name })
              : h('div', { key: 'p', style: { ...S.thumb, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '18px' } }, '🎭'),
            h('div', { key: 'm', style: S.grow }, [
              h('div', { key: 'n', style: S.name }, card.name),
              h('div', { key: 's', style: S.muted }, [
                card.spec,
                card.creator ? `作者 ${card.creator}` : '',
                `${card.greetingCount} 条开场白`,
                card.hasCharacterBook ? '含内嵌世界书' : '',
                card.tags.length ? card.tags.slice(0, 5).join(' / ') : '',
              ].filter(Boolean).join(' · ')),
              h('div', { key: 'b', style: { ...S.row, marginTop: '6px' } }, [
                h(Btn, { key: 'd', onClick: () => setOpenId(openId === card.id ? '' : card.id) }, openId === card.id ? '收起' : '详情 / 开场白'),
                card.hasCharacterBook ? h(Btn, { key: 'bk', disabled: busy, onClick: () => importBook(card) }, '导入内嵌世界书') : null,
                h(Btn, { key: 'x', variant: 'danger', disabled: busy, onClick: () => remove(card) }, '删除'),
              ]),
            ]),
          ])),

        open ? h('div', { key: 'detail', style: S.card }, [
          h('div', { key: 'h', style: S.name }, `${open.name} — 详情`),
          open.description ? h('div', { key: 'd' }, [h('div', { key: 'l', style: S.label }, '角色简介'), h('pre', { key: 'p', style: S.pre }, open.description)]) : null,
          open.personality ? h('div', { key: 'pe' }, [h('div', { key: 'l', style: S.label }, '性格'), h('pre', { key: 'p', style: S.pre }, open.personality)]) : null,
          open.scenario ? h('div', { key: 'sc' }, [h('div', { key: 'l', style: S.label }, '场景'), h('pre', { key: 'p', style: S.pre }, open.scenario)]) : null,
          h('div', { key: 'g', style: { marginTop: '10px' } }, [
            h('div', { key: 'l', style: S.label }, '开场白（初始文本）'),
            h(GreetingBlock, { key: 'b', greetings: [
              open.firstMes ? { label: '开场白', text: open.firstMes } : null,
              ...(open.alternateGreetings || []).map((text, index) => ({ label: `备用开场白 ${index + 1}`, text })),
            ].filter(Boolean) }),
          ]),
          open.mesExample ? h('div', { key: 'me' }, [h('div', { key: 'l', style: S.label }, '对话示例'), h('pre', { key: 'p', style: S.pre }, open.mesExample)]) : null,
        ]) : null,
      ])
    }

    // -----------------------------------------------------------------------
    // world books tab
    // -----------------------------------------------------------------------

    function BooksTab(props) {
      const { state, reload, notify } = props
      const [openId, setOpenId] = useState('')
      const [detail, setDetail] = useState(null)
      const fileRef = useRef(null)
      const [busy, setBusy] = useState(false)

      const onFiles = async (event) => {
        const files = Array.from(event.target.files || [])
        event.target.value = ''
        if (files.length === 0) return
        setBusy(true)
        try {
          for (const file of files) {
            const dataUrl = await readFileAsDataUrl(file)
            const result = await call('/worldbook', { dataUrl, fileName: file.name })
            notify(`已导入世界书「${result.book.name}」（${result.book.entryCount} 条，${result.book.keywordCount} 条关键词触发）`)
          }
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const remove = async (book) => {
        if (!window.confirm(`删除世界书「${book.name}」？`)) return
        setBusy(true)
        try {
          await call('/worldbook/delete', { id: book.id })
          notify(`已删除「${book.name}」`)
          if (openId === book.id) { setOpenId(''); setDetail(null) }
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const open = async (book) => {
        if (openId === book.id) { setOpenId(''); setDetail(null); return }
        setBusy(true)
        try {
          const result = await call('/worldbook/detail', { id: book.id })
          setDetail(result.book)
          setOpenId(book.id)
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: S.list }, [
        h('div', { key: 'imp', style: S.card }, [
          h('div', { key: 'a', style: S.between }, [
            h('span', { key: 't', style: S.name }, '导入世界书'),
            h(Btn, { key: 'b', variant: 'primary', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, busy ? '处理中…' : '选择文件'),
          ]),
          h('div', { key: 'b', style: { ...S.muted, marginTop: '4px' } },
            '支持 SillyTavern World Info 导出（entries 为对象或数组）与 Character Card V2 的 character_book。条目按 recent transcript 里的关键词命中，constant 条目常驻。'),
          h('input', {
            key: 'f', ref: fileRef, type: 'file', multiple: true, style: { display: 'none' },
            accept: '.json,application/json', onChange: onFiles,
          }),
        ]),

        state.worldbooks.length === 0
          ? h('div', { key: 'empty', style: S.muted }, '还没有世界书。')
          : state.worldbooks.map((book) => h('div', { key: book.id, style: S.item }, [
            h('div', { key: 'm', style: S.grow }, [
              h('div', { key: 'n', style: S.name }, book.name),
              h('div', { key: 's', style: S.muted }, [
                `${book.entryCount} 条条目`,
                `${book.enabledCount} 条启用`,
                `${book.constantCount} 条常驻`,
                `${book.keywordCount} 条关键词`,
                book.source === 'character_book' ? '来自角色卡' : '',
              ].filter(Boolean).join(' · ')),
              h('div', { key: 'b', style: { ...S.row, marginTop: '6px' } }, [
                h(Btn, { key: 'd', onClick: () => open(book) }, openId === book.id ? '收起' : '查看条目'),
                h(Btn, { key: 'x', variant: 'danger', disabled: busy, onClick: () => remove(book) }, '删除'),
              ]),
            ]),
          ])),

        openId && detail ? h('div', { key: 'detail', style: S.card }, [
          h('div', { key: 'n', style: S.name }, `${detail.name} — 条目`),
          h('div', { key: 'list' }, (detail.entries || []).map((entry) => h('div', { key: entry.id, style: { marginTop: '8px' } }, [
            h('div', { key: 'h' }, [
              h('span', { key: 'c', style: { fontWeight: 600 } }, entry.comment),
              h('span', { key: 'k', style: { ...S.muted, marginLeft: '6px' } },
                [entry.constant ? '常驻' : `关键词：${entry.keys.join('、') || '（无）'}`,
                  entry.selective && entry.secondaryKeys.length ? `· 需附带：${entry.secondaryKeys.join('、')}` : '',
                  entry.enabled ? '' : '· 已停用'].filter(Boolean).join(' ')),
            ]),
            h('pre', { key: 'p', style: S.pre }, entry.content),
          ]))),
        ]) : null,
      ])
    }

    // -----------------------------------------------------------------------
    // skills tab
    // -----------------------------------------------------------------------

    function SkillsTab(props) {
      const { state } = props
      return h('div', { style: S.list }, [
        h('div', { key: 'h', style: S.card }, [
          h('div', { key: 't', style: S.name }, `DSH 技能目录（${state.skills.length}）`),
          h('div', { key: 's', style: { ...S.muted, marginTop: '4px' } },
            '这些是本机 DSH 已安装的 Skill。在「预设」页把技能挂到某个角色上，它的内容会被写进角色的系统提示，让角色按需使用。'),
        ]),
        ...state.skills.map((skill) => h('div', { key: skill.name, style: S.item }, [
          h('div', { key: 'm', style: S.grow }, [
            h('div', { key: 'n', style: S.name }, skill.name),
            h('div', { key: 'd', style: S.muted }, skill.description || '（无描述）'),
            skill.whenToUse ? h('div', { key: 'w', style: S.muted }, `适用：${skill.whenToUse}`) : null,
            h('div', { key: 'p', style: { ...S.muted, marginTop: '2px' } }, `来源：${skill.provider} · ${skill.source}`),
          ]),
        ])),
      ])
    }

    // -----------------------------------------------------------------------
    // presets tab
    // -----------------------------------------------------------------------

    const EMPTY_DRAFT = {
      id: '', name: '', cardId: '', worldbookIds: [], skillNames: [],
      styleHint: '第二人称叙事，一次回复 1-3 段；对白用「」，动作与神态描写贴紧角色当下的状态与目标。',
      extraInstructions: '', complete: false, includeRuntimeContext: true, maxEntries: 12, maxChars: 6000,
    }

    function PresetsTab(props) {
      const { state, reload, notify } = props
      const [draft, setDraft] = useState(EMPTY_DRAFT)
      const [busy, setBusy] = useState(false)
      const [greetFor, setGreetFor] = useState('')

      const set = (patch) => setDraft((current) => ({ ...current, ...patch }))

      const edit = (preset) => {
        setGreetFor('')
        setDraft({
          id: preset.id,
          name: preset.name,
          cardId: preset.cardId,
          worldbookIds: preset.worldbookIds.slice(),
          skillNames: preset.skillNames.slice(),
          styleHint: preset.options.styleHint || '',
          extraInstructions: preset.options.extraInstructions || '',
          complete: preset.options.complete === true,
          includeRuntimeContext: preset.options.includeRuntimeContext !== false,
          maxEntries: Number.isFinite(preset.options.maxEntries) ? preset.options.maxEntries : 12,
          maxChars: Number.isFinite(preset.options.maxChars) ? preset.options.maxChars : 6000,
        })
      }

      const toggle = (field, value) => {
        const list = draft[field].slice()
        const at = list.indexOf(value)
        if (at >= 0) list.splice(at, 1)
        else list.push(value)
        set({ [field]: list })
      }

      const save = async () => {
        if (!draft.cardId) { notify('请先选择一个角色卡', 'error'); return }
        setBusy(true)
        try {
          const result = await call('/preset', draft)
          notify(result.error
            ? `预设已保存，但注册到 DSH 时出错：${result.error}`
            : `已保存预设，DSH 预设 ID：${result.dshPresetId}。到会话的预设选择器里选「酒馆 · ${draft.name || '…'}」即可开始扮演。`,
          result.error ? 'error' : 'info')
          setDraft(EMPTY_DRAFT)
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const remove = async (preset) => {
        if (!window.confirm(`删除预设「${preset.name}」？对应的 DSH 预设会同时注销。`)) return
        setBusy(true)
        try {
          await call('/preset/delete', { id: preset.id })
          notify(`已删除预设「${preset.name}」`)
          if (draft.id === preset.id) setDraft(EMPTY_DRAFT)
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: S.list }, [
        h('div', { key: 'form', style: S.card }, [
          h('div', { key: 'h', style: S.between }, [
            h('span', { key: 't', style: S.name }, draft.id ? '编辑预设' : '新建预设'),
            draft.id ? h(Btn, { key: 'c', onClick: () => setDraft(EMPTY_DRAFT) }, '新建 / 取消编辑') : null,
          ]),

          h('div', { key: 'f1', style: { marginTop: '8px' } }, [
            h(Field, { key: 'a', label: '预设名称' },
              h('input', { style: S.input, value: draft.name, placeholder: '留空则使用角色名', onChange: (e) => set({ name: e.target.value }) })),
            h(Field, { key: 'b', label: '角色卡' },
              h('select', { style: S.input, value: draft.cardId, onChange: (e) => set({ cardId: e.target.value }) }, [
                h('option', { key: '', value: '' }, '— 请选择 —'),
                ...state.cards.map((card) => h('option', { key: card.id, value: card.id }, card.name)),
              ])),
          ]),

          h('fieldset', { key: 'wb', style: { ...S.fieldset, marginBottom: '8px' } }, [
            h('legend', { key: 'l', style: S.legend }, `世界书（${draft.worldbookIds.length} 已选）`),
            state.worldbooks.length === 0
              ? h('div', { key: 'e', style: S.muted }, '还没有世界书，请先在「世界书」页导入。')
              : h('div', { key: 'g', style: S.grid }, state.worldbooks.map((book) => h('label', { key: book.id, style: S.check }, [
                h('input', { type: 'checkbox', checked: draft.worldbookIds.includes(book.id), onChange: () => toggle('worldbookIds', book.id) }),
                h('span', null, `${book.name}（${book.entryCount}）`),
              ]))),
          ]),

          h('fieldset', { key: 'sk', style: { ...S.fieldset, marginBottom: '8px' } }, [
            h('legend', { key: 'l', style: S.legend }, `技能（${draft.skillNames.length} 已选）`),
            state.skills.length === 0
              ? h('div', { key: 'e', style: S.muted }, '本机没有可用的 Skill。')
              : h('div', { key: 'g', style: S.grid }, state.skills.map((skill) => h('label', { key: skill.name, style: S.check, title: skill.description }, [
                h('input', { type: 'checkbox', checked: draft.skillNames.includes(skill.name), onChange: () => toggle('skillNames', skill.name) }),
                h('span', null, skill.name),
              ]))),
          ]),

          h(Field, { key: 'sh', label: '输出风格' },
            h('textarea', { style: { ...S.input, minHeight: '52px' }, value: draft.styleHint, onChange: (e) => set({ styleHint: e.target.value }) })),

          h(Field, { key: 'ei', label: '附加作者指令（可选，会写在角色设定里）' },
            h('textarea', { style: { ...S.input, minHeight: '52px' }, value: draft.extraInstructions, placeholder: '例如：多用环境描写；不要替玩家决定行动。', onChange: (e) => set({ extraInstructions: e.target.value }) })),

          h('details', { key: 'adv', style: { marginBottom: '8px' } }, [
            h('summary', { key: 's', style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' } }, '高级选项'),
            h('div', { key: 'b', style: { marginTop: '8px' } }, [
              h('div', { key: 'r', style: { ...S.row, gap: '16px', marginBottom: '8px' } }, [
                h('label', { key: 'a', style: { ...S.check, flexDirection: 'row' }, title: '开启后角色设定会完全替代 Harness 的系统提示。' }, [
                  h('input', { type: 'checkbox', checked: draft.complete, onChange: (e) => set({ complete: e.target.checked }) }),
                  h('span', null, '完全接管系统提示（complete）'),
                ]),
                h('label', { key: 'b', style: { ...S.check, flexDirection: 'row' }, title: '关闭后连工作目录、时间等运行环境信息也不注入。' }, [
                  h('input', { type: 'checkbox', checked: draft.includeRuntimeContext, onChange: (e) => set({ includeRuntimeContext: e.target.checked }) }),
                  h('span', null, '注入运行环境信息'),
                ]),
              ]),
              h('div', { key: 'n', style: S.row }, [
                h('span', { key: 'a' }, [h('span', { key: 'l', style: S.label }, '世界书最多注入条数'),
                  h('input', {
                    key: 'i', type: 'number', min: 1, max: 64, style: { ...S.input, width: '90px' }, value: draft.maxEntries,
                    onChange: (e) => set({ maxEntries: Number(e.target.value) || 12 }),
                  })]),
                h('span', { key: 'b' }, [h('span', { key: 'l', style: S.label }, '世界书最多字符数'),
                  h('input', {
                    key: 'i', type: 'number', min: 500, step: 500, style: { ...S.input, width: '110px' }, value: draft.maxChars,
                    onChange: (e) => set({ maxChars: Number(e.target.value) || 6000 }),
                  })]),
              ]),
            ]),
          ]),

          h('div', { key: 'act', style: S.row }, [
            h(Btn, { key: 's', variant: 'primary', disabled: busy || !draft.cardId, onClick: save }, busy ? '保存中…' : (draft.id ? '保存修改' : '保存为 DSH 预设')),
          ]),
          h('div', { key: 'tip', style: { ...S.muted, marginTop: '6px' } },
            '保存后会在 DSH 里注册一个真正的 Agent 预设，可以在会话输入框上方的预设选择器里直接切换。'),
        ]),

        state.presets.length === 0
          ? h('div', { key: 'empty', style: S.muted }, '还没有预设。')
          : state.presets.map((preset) => h('div', { key: preset.id, style: S.item }, [
            h('div', { key: 'm', style: S.grow }, [
              h('div', { key: 'n', style: S.name }, preset.name),
              h('div', { key: 's', style: S.muted }, [
                `角色 ${preset.cardName}`,
                `${preset.worldbookIds.length} 本世界书`,
                `${preset.skillNames.length} 个技能`,
                preset.options.complete ? '完全接管系统提示' : '',
              ].filter(Boolean).join(' · ')),
              h('div', { key: 'id', style: { ...S.muted, fontFamily: 'monospace' } }, `DSH 预设 ID：${preset.dshPresetId}`),
              preset.error ? h('div', { key: 'e', style: { ...S.muted, color: 'var(--dsw-alias-state-error-primary)' } }, `注册错误：${preset.error}`) : null,
              h('div', { key: 'b', style: { ...S.row, marginTop: '6px' } }, [
                h(Btn, { key: 'e', onClick: () => edit(preset) }, '编辑'),
                h(Btn, { key: 'g', onClick: () => setGreetFor(greetFor === preset.id ? '' : preset.id) }, greetFor === preset.id ? '收起开场白' : '输出开场白'),
                h(Btn, { key: 'x', variant: 'danger', disabled: busy, onClick: () => remove(preset) }, '删除'),
              ]),
              greetFor === preset.id ? h(GreetingBlock, {
                key: 'gb',
                greetings: (() => {
                  const card = state.cards.find((item) => item.id === preset.cardId)
                  if (!card) return []
                  return [
                    card.firstMes ? { label: '开场白', text: card.firstMes } : null,
                    ...(card.alternateGreetings || []).map((text, index) => ({ label: `备用开场白 ${index + 1}`, text })),
                  ].filter(Boolean)
                })(),
              }) : null,
            ]),
          ])),

        h('div', { key: 'cmd', style: S.card }, [
          h('div', { key: 't', style: S.name }, '聊天里的快捷命令'),
          h('pre', { key: 'p', style: S.pre }, [
            '/tavern           列出所有 Tavern 预设',
            '/tavern card      显示当前会话扮演的角色',
            '/tavern greet     输出当前会话角色卡的开场白',
            '/tavern greet 2   输出第 2 条开场白（备用开场白 1）',
          ].join('\n')),
        ]),
      ])
    }

    // -----------------------------------------------------------------------
    // shell
    // -----------------------------------------------------------------------

    const TABS = [
      { id: 'cards', label: '角色卡' },
      { id: 'worldbooks', label: '世界书' },
      { id: 'skills', label: '技能' },
      { id: 'presets', label: '预设' },
    ]

    function TavernSettings() {
      const [state, setState] = useState(null)
      const [tab, setTab] = useState('presets')
      const [notice, setNotice] = useState(null)
      const [failure, setFailure] = useState('')

      const notify = useCallback((text, kind) => {
        setNotice({ text, kind: kind === 'error' ? 'error' : 'info' })
      }, [])

      const load = useCallback(async (silent) => {
        try {
          const next = await call('/state')
          setState(next)
          setFailure('')
          return next
        } catch (error) {
          if (!silent) setFailure(String((error && error.message) || error))
          return undefined
        }
      }, [])

      useEffect(() => {
        let live = true
        load().then((next) => {
          if (!live) return
          if (next && next.presets.length === 0 && next.cards.length === 0) setTab('cards')
          else if (next && next.presets.length === 0) setTab('presets')
        })
        return () => { live = false }
      }, [load])

      const counts = useMemo(() => {
        if (!state) return {}
        return { cards: state.cards.length, worldbooks: state.worldbooks.length, skills: state.skills.length, presets: state.presets.length }
      }, [state])

      const reload = useCallback(() => load(true), [load])

      if (failure) {
        return h('div', { style: S.page }, [
          h('div', { key: 't', style: S.name }, '酒馆'),
          h('div', { key: 'e', style: S.alert }, `读取酒馆数据失败：${failure}`),
          h(Btn, { key: 'r', onClick: () => load() }, '重试'),
        ])
      }
      if (!state) {
        return h('div', { style: S.page }, [h('div', { key: 'l', style: S.muted }, '正在读取酒馆数据…')])
      }

      const common = { state, reload, notify }

      return h('div', { style: S.page }, [
        h('div', { key: 'head', style: S.between }, [
          h('div', { key: 'l' }, [
            h('div', { key: 't', style: { ...S.name, fontSize: '15px' } }, '酒馆'),
            h('div', { key: 's', style: S.muted }, '导入角色卡与世界书，挂上技能，保存成 DSH 预设后即可开始角色扮演。'),
          ]),
          h('div', { key: 'r', style: S.row }, [
            h('span', { key: 'c', style: S.muted }, `${counts.cards} 角色卡 · ${counts.worldbooks} 世界书 · ${counts.skills} 技能 · ${counts.presets} 预设`),
            h(Btn, { key: 'r', onClick: () => load() }, '刷新'),
          ]),
        ]),

        notice ? h('div', { key: 'n', style: notice.kind === 'error' ? S.alert : S.ok }, [
          h('span', { key: 't' }, notice.text),
          h('button', {
            key: 'x', type: 'button', onClick: () => setNotice(null),
            style: { float: 'right', border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit' },
          }, '×'),
        ]) : null,

        state.errors && state.errors.length > 0
          ? h('div', { key: 'se', style: S.alert }, state.errors.map((line, at) => h('div', { key: at }, line)))
          : null,

        h('div', { key: 'tabs', style: S.tabs }, TABS.map((item) => h('button', {
          key: item.id, type: 'button',
          style: { ...S.tab, ...(tab === item.id ? S.tabActive : {}) },
          onClick: () => setTab(item.id),
        }, `${item.label}${counts[item.id] !== undefined ? ` (${counts[item.id]})` : ''}`))),

        tab === 'cards' ? h(CardsTab, { key: 'c', ...common })
          : tab === 'worldbooks' ? h(BooksTab, { key: 'w', ...common })
            : tab === 'skills' ? h(SkillsTab, { key: 'k', ...common })
              : h(PresetsTab, { key: 'p', ...common }),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'tavern', order: 25, label: '酒馆' },
          TavernSettings,
        ))
      },
    }
  },
})
