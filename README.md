# dsh-tavern · 酒馆角色扮演

给 DeepSeek Harness 加上「酒馆」式的角色扮演能力：导入 SillyTavern 角色卡和世界书，挑选 Harness 技能，把组合存成一个**原生 DSH agent preset**，然后在会话里用 Harness 自己的预设选择器选它即可开演。

插件不会另造一套对话循环——它把酒馆的素材翻译成 Harness 原生的东西（agent preset、system prompt 上下文、技能列表），所以历史记录、工具、权限、上下文压缩全部沿用 Harness 既有行为。

---

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 角色卡导入 | SillyTavern V1 / V2 / V3 卡片；JSON 文件，或 PNG 卡片（读 `tEXt` 块，`ccv3` 优先于 `chara`） |
| 世界书导入 | 独立世界书 JSON，或角色卡内嵌的 `character_book`（可一键抽出来存成独立世界书） |
| 关键词选择 | 世界书条目按关键词、常驻（constant）、次级门控（secondary keys）命中，停用条目跳过 |
| 预算裁剪 | 按条数和字符双预算裁剪，且**排名最高的条目即使超预算也强制注入** |
| 技能绑定 | 一个预设可绑定若干 Harness 技能，随 system prompt 一起生效 |
| 开场白 | 读取角色卡的 `first_mes` 与 `alternate_greetings`，可在界面里预览，也能用命令输出 |
| 预设落库 | 保存为原生 agent preset，名称前缀 `tavern-`，出现在 Harness 的预设选择器里 |
| 立绘 | 导入 PNG 卡时保留原图，界面里直接显示 |

## 数据存放

一切都放在 `$DSH_HOME/tavern/`（默认 `~/.dsh/tavern/`）下，纯文件、可读、可手改、不依赖数据库，升级插件不会丢：

```
~/.dsh/tavern/
  cards/<id>.json        归一化后的角色卡
  worldbooks/<id>.json   归一化后的世界书
  portraits/<id>.png     从 PNG 卡里保留下来的原图
  presets/<id>.json      角色卡 + 世界书 + 技能的组合
```

写入是原子的（临时文件 + rename），崩溃不会留下半截记录。

## 安装与启用

插件目录需要能作为 bundle 被解析到。两种方式任选其一：

**A. 作为 bundle 启用（推荐）** — 在 profile 的 `package.json` 里把包名加进 `dsh.profile.bundles`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-tavern"] } }
}
```

包本身声明了 `dsh.bundle.patch: ./cordis.patch.yml`，该 patch 会插入一行 `{ id: tavern, name: dsh-tavern }`。解析顺序是「安装锚点优先，然后 profile 目录」，因此只要 `dsh-tavern` 出现在 profile 的 `node_modules` 下（symlink/junction 或真实安装均可）就能被找到，**不需要**导出 `./package.json`。

**B. 直接改 profile 的 `cordis.patch.yml`** — 加入与插件自带 patch 相同的内容：

```yaml
- insert:
    - id: tavern
      name: dsh-tavern
```

profile 的 `package.json` 与 `cordis.patch.yml` 都受 HMR 监视：实时 profile 下改动即时生效，启动型 profile 需要重启。

启用后：

1. 插件会在 `$DSH_HOME/tavern/` 下创建 `cards` / `worldbooks` / `portraits` / `presets` 四个目录；
2. **设置 → 酒馆** 出现四个标签页：角色卡、世界书、技能、预设；
3. 会话的预设选择器里出现「酒馆 · …」条目。

## 使用

### 界面

**设置 → 酒馆**，四个标签页：

- **角色卡** — 导入 JSON / PNG 卡，预览立绘、简介、开场白，删除卡片（会提示哪些预设正在引用它）
- **世界书** — 导入世界书；角色卡内嵌的世界书可一键提取；查看条目与关键词
- **技能** — 从 Harness 技能列表里勾选，绑定进预设
- **预设** — 选角色卡 + 世界书 + 技能，命名并保存；保存后立即注册为原生 agent preset

### 命令

```
/tavern                    列出所有酒馆预设（等同 /tavern list、/tavern presets）
/tavern card               查看当前会话正在使用的角色
/tavern greet [序号]       输出开场白（第 n 条备选，缺省用当前会话的角色）
```

`card` 与 `greet` 依赖当前会话已经选中某个「酒馆 · …」预设；没有选中时会给出提示而不是静默失败。

### 开演

1. 在 设置 → 酒馆 里导入角色卡，按需挑世界书和技能，保存预设；
2. 在会话的预设选择器里选择「酒馆 · <你的预设名>」；
3. 角色卡的 persona、命中的世界书条目、绑定的技能会自动进入该会话的 system prompt。

## 工作原理

插件分 Host 侧与 Web 客户端两部分。

**Host（`lib/index.js`）**

- `inject: ['webServer']`，插件名 `tavern`。
- 把每个酒馆预设注册成原生 agent preset，名称前缀 `tavern-`，排序基址 `PRESET_ORDER_BASE = 50`（排在 Harness 自带预设之后）。
- 预设的插件列表从 profile 当前默认 agent preset 的 `inherited.plugins` 深拷贝而来，取不到时回退到一份内置工具清单——这样酒馆预设与用户当前的默认配置保持一致。
- 通过 `agentPresets.composedPreset(agent.ctx)` 判断某个 agent 是否正在跑酒馆预设；是则用 `systemPrompt.context({ name: 'tavern:world-book', order: 130, text })` 注入世界书。
- 注入文本取自该会话最近 `RECENT_LIMIT = 24` 条消息，截尾 8000 字符，再按世界书选择器裁剪（默认 `maxEntries = 12`、`maxChars = 6000`）。
- 注册 `/tavern` 命令。
- HTTP 端点挂在 `/dsh-tavern/api/` 下，并对 **loopback host + 同源 origin** 做校验（不通过返回 403），上传上限 `MAX_UPLOAD_BYTES = 12 MiB`。

**Web 客户端（`client.js`）**

- 以 `settings.section` 槽位注册「酒馆」设置节（`id: 'tavern'`, `order: 25`）。
- 只通过 `/dsh-tavern/api` 与 Host 通信。

**模块划分**

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | Host 主体：预设注册、世界书注入、HTTP 路由、`/tavern` 命令 |
| `lib/cards.js` | 角色卡读取与归一化（JSON / PNG tEXt，V1/V2/V3，`ccv3` 优先于 `chara`） |
| `lib/lorebook.js` | 世界书归一化、关键词选择、渲染 |
| `lib/persona.js` | 角色 prompt 前缀拼装（身份 + 技能） |
| `lib/store.js` | 原子文件存储与目录管理 |
| `client.js` | Web 设置页（四个标签页） |
| `cordis.patch.yml` | bundle patch：插入 `tavern` 行 |
| `locale/zh.json`、`locale/en.json` | 设置节的标题与描述 |

## 开发

离线自测，不需要启动 Harness：

```bash
node tools/tavern-selftest.mjs
```

覆盖 13 项检查：PNG 与 JSON 判别、V2 JSON 卡、PNG 内嵌卡、`ccv3` 优先级、V1 扁平卡、无卡数据的 PNG 报错、世界书对象键归一化、`character_book` 反向 flag、关键词/常驻/次级门控/停用条目选择、预算裁剪、渲染去重、persona 前缀、空节省略。

语法检查：

```bash
node --check lib/index.js && node --check client.js
```

## 许可

MIT
