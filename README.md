# dsh-writing-style —— DSH 里的「写作风格」插件

给 DeepSeek Harness 装一套**每轮强制生效、可调、可存、可撤销**的写作风格：

- **预设**：冷硬派 / 古典雅致 / 网文爽感 / 文学意识流 / 剧本体 / 轻小说 / 临床白描 / 哥特阴郁 / 均衡
- **自己写预设**：设置 →「写预设」页签，填 id + 维度 + 自由指令 + 禁用词 + 范文，直接写成一份新预设
- **11 个维度旋钮**：句式长度、描写密度、对话占比、心理描写、感官细节、节奏、词汇色彩、段落长度、修辞密度、露骨程度、幽默感
  （**叙事视角**与**叙述时态**已按需求取消：人称和时态由正文本身决定，量化成分档既不好使，也常常和剧情打架。旧存档里残留的 `pov` / `tense` 读进来会被静默忽略，不报错、也不会写回。）
- **禁用词 + 偏好词**：直接掐掉「不禁」「仿佛」「嘴角勾起」这类 AI 套话
- **范文 few-shot**：贴一段你自己写的，让模型照语感写（比任何形容词都准）
- **触发性条目**：只有最近几条消息命中关键词时才追加注入的规则（酒馆世界书那套）
- **两条改法**：设置页里调，或者直接对 AI 说「换成冷硬派，句式再短一点」

> 一句话：**风格不再是每轮重打的一段提示词，而是会话里的一等公民。**

## 它解决什么问题

| 传统做法 | 本插件 |
|---|---|
| 每轮开头重贴一遍「请用冷硬派笔法」 | 存在会话日志里，每轮自动注入成硬规范 |
| 说「写短一点」，下一轮又变回长句 | 11 个维度量化成具体分档指令，模型照着执行 |
| 换了预设，AI 还是老样子 | 规范正文里带**落笔前自检**，且明确「优先于默认写作习惯」 |
| 想调只能重新 prompt | 说一句话立即生效，对话里只回一句确认 |
| 调坏了没法回头 | 每次改动都是一条日志记录，`↺` 一键回退 |
| 全局配置一改，所有对话都变 | 每个会话独立，编码对话不受影响（默认关闭） |

## 装了什么

**宿主侧（`lib/index.js`）**

- 4 个模型工具：`style_get` / `style_set` / `style_preset` / `style_rules`
- 1 个会话投影 `writingStyle`（客户端渲染的唯一输入）
- 每轮注入：
  - 系统提示段 `writing-style:directive`（order **3300**，紧跟 RPG 状态段之后）
  - 动态上下文 `writing-style:rules`（order **3310**，只放命中的触发性条目）
- 1 个本机路由 `/dsh-writing-style/*`，只接受回环 + 同源请求
- 用户预设落盘：`<DSH home>/writing-style/presets.json`
  （DSH home 五级惰性解析：`WRITING_STYLE_HOME` → 环境变量 → 宿主包 → 模块路径上溯 → 进程 argv → `~/.dsh`；
  面板与 `style_get` 都会回带解析结果，见「坑 11」）

**客户端（`client/index.jsx` → `client.js`）**

- `settings.section` 完整面板，3 个页签：**预设 / 条目 / 预览**（2026-11-01 改版：
  维度/禁用词/偏好词/附加要求/范文**全部收进预设** —— 每张卡左块点=套用、右条「更改」进入
  该预设的完整编辑器；编辑器是隐藏视图，不在页签栏）
- 「预览」页签展示本轮注入正文；切过去会**强拉一次状态**（不等 45s 轮询）
- 编辑器里有**「预览注入效果」**：把草稿五项发给服务端 `preview`（带 `body.doc`，与每轮注入
  同一个渲染器），改完立刻看到会注入什么；保存「正在使用的」预设但没套用时，出现持久提示
  「当前对话还是套用那一刻的快照」—— 保存生效与否不再靠猜（2026-11-02）
- `conversation.input.dock` 上一颗**「文风·开 / 文风·关」徽标**（`order:4`，与 RPG 状态条同一 dock）：
  点一下只翻**当前这个对话**的 `enabled`。之所以要有它 ——
  每个**新**对话的文档默认 `enabled:false`（`lib/style.js` 的 `defaultDoc()`），
  以前只能去设置页或开口让 AI 开，看起来就像「插件装了却不生效」。
  ⚠️ 2026-11-02 从 `conversation.composer.dock` 搬过来：宿主对 composer.dock 的渲染条件是
  `variant === "composer" && sessionId !== void 0`，**新会话的 hero 形态整个席位不渲染** ——
  徽标在初始界面上根本不出现；input.dock 只要 `zone`（session+input）存在就渲染，开聊之前就能拨。
- 仍然**没有输入框底栏**：徽标只有一颗小按钮（行容器右对齐），不占对话区垂直空间

## 改风格之后对话里出现什么

只有一句确认，例如：

```
已启用写作风格：冷硬派 · 第一人称 · 句式20 · 描写30 · 对话55 · 节奏55
```

规范正文**不会**贴进对话 —— 它是系统提示段，每轮自动生效。这样既不重复占用上下文，
也不会让你误以为「风格是一段贴在聊天里的文字」。

## 为什么这样设计

### ① 为什么用会话日志而不是配置文件

用户要的是「每个会话可以不一样」。配置文件是全局的，日志是会话的。
用日志还顺带得到：撤销 = 历史快照、导出会话即导出风格、换窗口/重开客户端都还在。

### ② 为什么是「预设 + 维度 + 自由指令 + 范文」四件套

- 预设解决「我想要冷硬派但说不清」
- 维度解决「预设差一点点」
- 自由指令兜住所有维度表达不了的东西
- 范文是 few-shot，模仿语感最有效的手段

### ③ 为什么渲染出来那么长

模型对「祈使句 + 具体数字 + 正反例」的执行率最高，对「请写得优美一些」几乎无感。
宁可多两百字，也要把要求说死 —— 包括最后那句「落笔前自检」。

### ④ 三个踩过的坑（别改回去）

**坑 1：事件类型必须走 `plugin:` 命名空间 + `ignorable: true`**

DSH 冷读会话日志时逐条校验事件类型，不认识又没标 `ignorable` 就**整份拒绝**：

```
session "..." contains event type "writing/state" (seq 67) unknown to this harness
and not marked ignorable; refusing to interpret the log
```

一条记录废掉一整份会话（表现为「历史加载失败」，连新对话都进不去）。
本插件写的是 `plugin:writing-style/state`，走 `appendPluginRecord()`。

**坑 2：`prompt.section()` 的正文走 `text`，不是 `provider`**

写成 `provider: () => ...` 会被当成未知字段静默忽略 —— 段落永远为空，
表现为「插件装了、开关也开了，但 AI 完全不遵守」。正文要么是字符串，要么是
`text: (context) => string`。

**坑 3：必须 `interpolate: false`**

用户会在自由指令或范文里写 `{{...}}`。默认的变量插值会把它当 prompt variable 解析，
抛 `unknown prompt variable`，**整轮 assemble 直接失败**（AI 连回复都发不出来）。

**坑 4：locale 字典值必须是字符串**

宿主 `translate()` 内部直接 `template.replace(...)`，字典里放函数会在带参数时抛
`template.replace is not a function`。函数形态只留在源码的 `ZH` 表里做兜底。

**坑 5：`Config` 在 junction 安装下会静默变成 `undefined`**

插件被 junction/symlink 装进 profile 时，Node 会把 `import.meta.url` realpath 到真实目录，
于是从「插件自己的位置」找不到 profile 的 `node_modules/@deepseek-ai/schemastery` ——
`Config` 静默变成 `undefined`，**所有配置项失效且不报错**。
现在按「插件位置 → profile → 宿主安装目录」多个基准解析，且改成真实目录安装。

**坑 6：读失败 ≠ 没有（会覆盖你的风格）**

事故链：日志读不出来 → 读路径回落到 `defaultDoc()` → 模型照常写 →
一份「全默认」的空壳覆盖掉你真实设好的风格。表现是「昨天调好的今天全没了」。
现在写入前走 `trustedBase()`：日志里有可信存档就用它，一条都没有才允许从默认起步；
并且「既没预设也没维度」的空壳不算可信存档。

**坑 7：内部短键泄漏给面板 → 滑块全空 + 整页空白（一次踩中两个症状）**

维度表内部用短键 `{ k, l, options: [[v, label]] }`，面板按 `{ key, label, options: [{value,label}] }` 取值。
曾经有三处直接把内部表原样返回给面板，结果：

| 症状 | 用户看到的 |
|---|---|
| 「写预设」页签：11 个滑块 `find()` 全部落空 | 一个滑块都不渲染 → 拖不了 → **存进去是空预设 → 「点了没反应」** |
| 「维度」页签：同一份数据 | 每行都取不到 → **整页空白** |

**后端全程不报错**，只有肉眼能发现。现在：

1. 所有对外出口统一走 `lib/style.js` 的 `dimsMeta()`，内部形状不再泄漏
2. 前端 `normalizeDimsMeta()` 再兜一层：形状不对就地转换，转不了用内置表
3. 每个页签的渲染包在 `try` 里，某页出错只显示该页错误，**不会整页白屏**

**坑 8：预设是全局的，不该受会话解析影响**

`write-preset` 曾被放在「会话必须存在」的检查之后。但预设存在
`<DSH home>/writing-style/presets.json`，与会话无关；而面板传的 session id
与宿主 `agents` 注册的 id 不一定一致 → 写预设莫名其妙 404。
现在 `write-preset` / `delete-preset` 在会话检查**之前**处理；
其余写操作（改风格、套预设）仍然必须解析到具体会话，绝不串档。

**坑 9：链式三元把后面的页签全吃掉（六个页签只活一个）**

`renderTab()` 一度写成**一条**链式三元：

```js
return tab === 'presets' ? X
  : null,
  tab === 'editor' ? Y : null,   // ← 从这行起，全部是被丢弃的逗号表达式
  tab === 'dims'   ? Z : null,
  ...
```

第一个 `: null,` 就把 `return` 结束了，后面每一个 `? :` 都变成独立语句、结果被丢掉。
表现是：**点任何页签都只有第一个分支可能有内容，其余全空白**。

现在改成独立 `if (...) return ...` 分支，并加了结构守卫测试
（`renderTab 不能写成链式三元`）—— 一旦有人改回去，测试立刻失败。

**坑 10：`doc && doc[key]` 在 doc 为 null 时返回 null，不是 undefined**

```js
const v = doc && doc[key]
return v === undefined ? fallback : v   // ← doc 为 null 时 v 是 null，兜底被跳过
```

调用方拿到 `null` 再 `.join('、')` → `Cannot read properties of null (reading 'join')`。
这正是「用词」页签报的错。两处修正：

1. `docVal` 的兜底判断改成 `v == null`（同时覆盖 null 与 undefined）
2. `useStyle` 里 `doc` 不再可能是 null：`normalizeDocClient()` 把任何输入
   （包括 null / 字段类型全错）都补成合法对象，维度缺值用内置默认填满

**坑 11：桌面端 rc.5 起 Host 进程没有 `DSH_HOME`，预设「点了没反应」**

launcher 把 `DSH_` 前缀从子进程环境里剥掉了（`app.asar/lib/main.js` 的
`LAUNCHER_OWNED_PREFIXES`），`dsh-desktop-host` 自己也不设置它。于是
`process.env.DSH_HOME` 在 Host 里是空的，连锁后果全是**静默**的：

| 依赖 home 的东西 | 表现 |
|---|---|
| `presetFile()` 返回 `''` | `writeUserPresets()` 直接 `return false`，面板只 flash「已保存」 |
| `readUserPresets()` 的 `catch { return [] }` | 读不到就当没有，内置预设照常显示，看不出异常 |
| `probe()` 早期版本 `if (!home) return` | `boot.log` 停在十几天前，工具却还在工作 —— 最容易误判成「插件没加载」 |

现在 `dshHome()` 按 **override → env → host-package → 模块路径上溯 → argv → `~/.dsh`**
五级解析，且**惰性求值**（不在模块顶层固化），并带一条不依赖 env 的 `argv` 兜底：
Host 命令行里有 `…\profiles\desktop`，`profiles` 的父目录就是 home。
`state` 响应带 `storage: {file, home, homeFrom, error}`，面板把它显示在
「写入预设」按钮上方；`write-preset` 失败现在返回 **500 + 具体原因**，
前端直接把错误写在页面上。**存不上必须看得见，不能再靠用户猜。**

> 想让预设放别处：`WRITING_STYLE_HOME=/path/to/home`（测试与自定义位置都走它）。

**坑 12：取消一个维度时，要同时处理「旧数据」和「旧请求」**

删掉 `DIMENSIONS` 里的 `pov` / `tense` 只是第一步。真正会咬人的是三处：

1. `renderSummary()` 里按 key 取值的地方 → 取到 `undefined` 再读 `.label` 直接抛
2. 客户端 `FALLBACK_DIMS` → 不改就等于每次 normalize 都把 `pov` 塞回 `doc.dims`，
   界面上看不到，日志里却一直长出这个键
3. 旧会话日志 / 旧预设 JSON 里已经存在的 `pov` / `tense` → 必须**静默忽略**，
   但对用户传来的同名维度要给「已从本插件移除」的理由（`RETIRED_DIMS`），
   而不是含糊的「未知维度」

`test/style.test.mjs` 里那几条退役断言就是钉这三点的。

## 安装

本插件是标准 DSH bundle（`package.json` 里 `dsh.bundle.patch` + `dsh.client`）。

```bash
# Web profile
dsh plugin --profile web add link:/绝对/路径/dsh-writing-style

# 桌面客户端读的是 desktop profile，用内置的 plugin_manager：
#   「用当前桌面端内置的 plugin_manager 安装 link:<本目录绝对路径>」
```

装完**完全退出客户端（含托盘）再打开**；Web 端刷新页面（`Ctrl+F5`）。

> 已经装过、只是改了代码：`node tools/sync-to-profile.mjs`。安装目录里
> `vendor/` 和 `node_modules/` 是**同一份文件的硬链接**，这个脚本用截断写入
> 覆盖内容、不换 inode，所以链接不会断（`rm` + `cp` 会把两份拆成不同版本，
> 宿主读的是 `node_modules` 那份 —— 拆开了就会出现「改了没反应」）。
> `lib/` 的改动必须重启宿主才生效：插件在启动时被加载一次。
> `client.js` 也要重启（客户端 bundle 由宿主注入），改 `client/index.jsx`
> 之前记得先 `node client/build.mjs`。

## 它会不会像 RPG 插件那样「有时不生效」

会遇到的失效模式有两类，**这个插件把已知的都堵了**，但机制上仍有一类环境问题防不住。
先看怎么自查，再看原理。

### 自查：三步定位

```bash
# ① 插件到底加载了吗
type C:\Users\<你>\.dsh\writing-style\boot.log

# ② 风格真的进提示词了吗（面板「预览」页签最直接，等价于这个）
#    或者看 AI 本轮是否按新风格写

# ③ 是不是被当成「没开」
```

`boot.log` 里的阶段标记就是为这个准备的：

| 标记 | 含义 |
|---|---|
| 没有 `apply` | 宿主根本没加载这个 bundle（profile / 依赖问题） |
| `services-missing` | 加载了但服务契约不符（宿主版本变了） |
| `route-skipped` / `route-failed` | 面板路由没挂上，但**注入仍然可用**（路由必须由独立的 inject 块注册，见下） |
| `tool-failed` + `tools-registered {"count":0}` | `output.schema` 被宿主拒（**一个工具都没注册上**），错误里会写明是哪个属性 |
| `tool-params-invalid` | 某个工具的 `parameters` 不是 `type:'object'` 的 JSON Schema（裸映射）→ 该工具被**跳过**，避免整轮对话被上游拒 |
| `ready` | 全部就绪 |

### 已堵住的失效模式

| 模式 | 现在的防护 |
|---|---|
| 提示段写成 `provider` 被静默忽略 | 用 `text: (ctx) => string`，且测试断言段落真能渲染出正文 |
| 用户范文里的 `{{ }}` 让整轮 assemble 崩 | `interpolate: false` |
| 配置项因 schemastery 解析不到而全失效 | 多基准解析 + 真实目录安装 |
| 读失败用默认值覆盖真实风格 | `trustedBase()` 写前兜底 + 空壳不算存档 |
| 面板写到别的会话上 | 显式 `?session=` 解析不到就 404，绝不回落到「最近会话」 |
| 一条日志记录废掉整份会话 | `plugin:` 命名空间 + `ignorable: true` |
| **`output.schema` 用了宿主不认的 `type:'json'` → 4 个工具全被退** | 假宿主照宿主规则调 `assertSupportedJsonSchema`（`test/support/host-schema.mjs`），并有 `tools/check-host-schema.mjs` 用 **app.asar 里真宿主的校验器**复核 |
| **在没声明 `webServer` 的 inject 块里 `get('webServer')` → `route-skipped`，面板空白且不报错** | 路由搬到第二个 `root.inject(['webServer','agents'], …)` 块；假宿主复刻 Cordis「未声明的服务 get 到 undefined、缺服务则整块不跑」，并专门测「没有 webServer 的宿主」 |
| **`parameters` 写成裸映射 → 宿主原样发上游 → 每轮对话都报 `Invalid schema for function 'style_get': schema must be a JSON Schema of 'type: "object"', got 'type: null'`**（2026-11-01 真机，boot.log 却显示 count:4 一切正常） | 4 个工具的 `parameters` 改成 `{type:'object', additionalProperties:false, properties:{…}}`；`test/tool-schema.test.mjs` 钉住根部契约；注册前跑 `toolParametersProblem()` 守卫，坏的那个工具**当场跳过并在 boot.log 记 `tool-params-invalid`**（宁可少个工具，不让整轮挂掉）；negative-check 有对应变体 + 守卫验证 |
| **首次 `/state` 请求失败一次 → 预设页签一个卡都没有，点一下「刷新」又都回来了**（2026-11-01 真机） | 根因是 4s 超时（首屏要跑 8MB 插件包）+ 失败后进入退避、45s 轮询一次次被退避挡回去，客户端**从不自己重试**。现在：超时 8s；失败后 1.2/2.4/4.8…秒自动重试（封顶 15s，最多 8 次）；上次成功的数据缓存在内存 + `sessionStorage`，失败时先画旧的、绝不白屏；「刷新」和写后拉取用 `force` 绕过退避；`retry.test.mjs` 4 项钉住 |
| **内置预设的卡片只有七个键：点「更改」载入的 `prefer`/`sample` 是 `undefined`**（2026-11-02 真机查 `/state` 逐张核对发现） | 内置预设本来就是「差异对象」，`allPresets()` 直接 `PRESETS.slice()` 交出去，`JSON.stringify` 又把 `undefined` 键整个丢掉 —— 于是面板与后端对同一份预设看到不同形状。现在 `normalizePreset(p, custom)` 给内置也补齐 `prefer: []`、`sample: ''`、`custom: false`，`features.test.mjs` 用「覆盖内置 → 删掉 → 原版五项一起回来」钉住 |
| **初始会话（hero 形态）看不到文风徽标**（2026-11-02 真机：用户要求开聊之前就能拨开关） | 宿主对 `conversation.composer.dock` 的渲染条件是 `variant === "composer" && sessionId !== void 0`，新会话是 hero 形态、整个席位不渲染（ui-conversation InputBar 源码核对）。徽标搬到 `conversation.input.dock`（`zone = {session, input}` 存在即渲染，宿主 queue dock 证明 inject 第一参数就是会话 id）；`client.test.mjs` 判死席位、negative-check 变体⑧拦住「搬回去」 |
| **改了预设点保存 → 预览/注入纹丝不动，用户以为没存上**（2026-11-02） | 语义本身没错：会话文档是「套用那一刻」的五项快照，只存预设不动文档。但界面必须把这件事说出来：编辑器加「预览注入效果」（`preview` op 带 `body.doc`，与每轮注入同一渲染器，只读）；保存**正在使用的**预设且没套用时出现持久提示「当前对话还是旧快照」；切「预览」页签强拉一次状态；`tabs.test.mjs` 4 项 + negative-check 变体⑨钉住 |

### 防不住的那一类

**插件整体没被加载**（profile 依赖没装、客户端更新覆盖了配置、bundle 列表被改）。
这类问题任何插件都防不住 —— 但它有明确信号：`boot.log` 里连 `apply` 都没有，
且面板页签不出现。看到这个就知道不是「风格没生效」，而是「插件没进来」。

**还有一个不是 bug 的行为**：风格是**系统提示段**，优先级低于你在当轮的直接指令。
你说「这轮用轻松点的语气」时，模型听你的而不是听预设 —— 这是设计如此。

## 用起来

### 面板

```
设置 → 写作风格
        ├ 预设    [冷硬派][古典雅致][网文爽感][文学意识流][剧本体][轻小说][临床白描][哥特阴郁]
        ├ 写预设  自己写一份新的：id + 显示名 + 维度 + 自由指令 + 禁用词 + 范文
        ├ 维度    11 条滑块（视角/时态已取消）
        ├ 用词    禁用词 / 偏好词 / 附加要求 / 语感范文
        ├ 条目    [战斗场面 ← 战斗/交手] [日常（总是）]
        └ 预览    本轮注入的完整正文（可复制）
```

### 直接对 AI 说

- 「换成冷硬派」→ 它调 `style_preset`
- 「句式再短一点，对话多一点」→ 它调 `style_set`
- 「别再用『不禁』和『仿佛』了」→ 它调 `style_set` 的 `avoidAdd`
- 「战斗场面用短句，日常放慢」→ 它调 `style_rules add`
- 「把现在这套存成预设，叫 my-noir」→ 它调 `style_preset save`

### 维度一览

| 维度 | 类型 | 默认 | 说明 |
|---|---|---|---|
| 句式长度 `sentence` | 0-100 | 45 | 短促 ↔ 绵长 |
| 描写密度 `density` | 0-100 | 50 | 白描 ↔ 稠密 |
| 对话占比 `dialogue` | 0-100 | 40 | 叙述 ↔ 对白 |
| 心理描写 `interior` | 0-100 | 45 | 外在 ↔ 内心 |
| 感官细节 `sensory` | 0-100 | 50 | 信息 ↔ 五感 |
| 叙事节奏 `pace` | 0-100 | 50 | 舒缓 ↔ 紧凑 |
| 词汇色彩 `vocabulary` | 0-100 | 50 | 平实 ↔ 华丽 |
| 段落长度 `paragraph` | 0-100 | 50 | 短段 ↔ 长段 |
| 修辞密度 `rhetoric` | 0-100 | 40 | 直陈 ↔ 繁复 |
| 露骨程度 `explicitness` | 0-100 | 50 | 含蓄 ↔ 直露 |
| 幽默感 `humor` | 0-100 | 30 | 严肃 ↔ 诙谐 |

工具调用里**中文名和 key 都认**：`["句式长度:20"]` 与 `["sentence:20"]` 等价。

## 配置项（profile patch 里可调）

```yaml
- id: writing-style
  disabled: false
  config:
    enabled: true          # 总闸：关掉后不注册任何东西（二分排查用）
    injectPerTurn: true    # 每轮注入风格规范
    triggerRules: true     # 触发性条目（关键词命中才注入）
    sampleLimit: 4000      # 范文最多注入多少字
```

## 开发

```bash
node client/build.mjs   # 改 client/index.jsx 后重新生成 client.js（不跑这步，界面改动不会生效）
node test/run.mjs       # 一把跑完 141 项
node test/negative-check.mjs   # 反向验证：把代码改回旧 bug，测试必须失败（11 变体 + 1 守卫 + 6 对照）
node tools/check-host-schema.mjs  # 用 app.asar 里**真宿主**的校验器复核所有 output.schema 与 parameters
node tools/dsh-home-probe.mjs --no-env --sim-host   # 看「预设存到哪、凭什么解析出来的」
node tools/probe-live.mjs 127.0.0.1:64446           # 问运行中的宿主：预设五字段/预览契约/线上 bundle 是不是磁盘这份
node tools/sync-to-profile.mjs                      # 同步到桌面端安装目录（保住硬链接）
```

> **两个「参数编译器」别搞混**（2026-11-01 踩过一次，测试红了一整天）：
> 插件走 `ctx.tools.register({ parameters })`，`parameters` **原样发给上游**
> （`dsh-llm-pi-ai` 里就是 `parameters: tool.parameters`），所以必须是完整 JSON Schema
> `{ type:'object', properties:{…} }`；宿主自家的 `defineTool({ parameters })` 才用
> 「裸映射」，由 `parameterSchemaSpecToJsonSchema()` 编译成上面那个形状。拿后者去喂已经
> 成型的 JSON Schema 会抛 `parameters.type must be a value schema object` —— 那是用错编译器。

| 套件 | 管什么 |
|---|---|
| `style.test.mjs` | 纯逻辑：文档规范化、维度解析、预设、渲染、**退役维度的中文旧名**（20 项） |
| `host.test.mjs` | 宿主侧：4 工具 + 投影 + 注入段 + 触发性条目 + 路由 + 日志契约 + **inject 分块/缺服务形态**（27 项） |
| `host-schema.test.mjs` | **output.schema 回归门**：`type:'json'` 必须被拒；本机有 app.asar 时用真宿主校验器复核并跟副本对账（4 项） |
| `tool-schema.test.mjs` | **parameters 的上游契约**：根部必须 `type:'object'`、不能是裸映射、`required` 名字要对得上、注册守卫行为（6 项） |
| `client.test.mjs` | bundle 形状、**席位形状（设置页 + input.dock 徽标；不许搬回 hero 不渲染的 composer.dock，也不许复活底栏）**、徽标读/写/失败/兜底、locale 契约、DOM 降级（14 项） |
| `retry.test.mjs` | **首次请求失败后的自愈**：自动重试、缓存兜底不白屏、没有数据时的提示、手动刷新绕过退避（4 项） |
| `concurrency.test.mjs` | **RPC 并发契约**：GET 不借用 POST 的在途响应、不跨会话复用、同键仍去重、同会话写串行不丢（4 项） |
| `home.test.mjs` | **home 解析优先级**：真实 argv 赢过「~/.dsh」猜测（宿主升级后它曾顶掉真实 home）、显式覆盖赢过一切（2 项） |
| `features.test.mjs` | 自己写预设、范文不丢、读失败不覆盖、回执只回一句、**同 id 覆盖内置 → ★ → 删掉后原版与五项一起回来**（14 项） |
| `blank-panel.test.mjs` | **白屏 / 存不进预设**：形状契约、会话无关性、页签容错、**storage 回执**（13 项） |
| `tabs.test.mjs` | **面板改版后的页签**：页签栏只有 预设/条目/预览、卡片两段（套用/更改）、编辑器载入五项且锁 id、删除只对自定义出现、**保存生效可见化**（预览注入效果 / 在用预设保存后的旧快照提示 / 切预览页签强拉状态）（19 项） |
| `cookie-doctor.test.mjs` | 启动失败诊断工具：计数准确、只删 dsh-auth-*、自动备份（9 项） |
| `real-host.test.mjs` | 用 `app.asar` 里的**真实** `dsh-session` / `dsh-session-projection` 跑一遍（5 项） |

`real-host.test.mjs` 找不到宿主源码时整组跳过（换机器不算失败）；
`host-schema.test.mjs` 的「真宿主对账」那条同理（只在拿得到 `app.asar` 的机器上跑）。

## 已知边界

- 面板写入依赖回环访问（本机浏览器）。手机端能看到状态，但按钮写入会被宿主信任栅栏挡住 —— 这是有意的。
- 用户预设存在 `<DSH home>/writing-style/presets.json`（全局，跨会话）；**当前选中的风格**在会话日志里（按会话独立）。
- 预设只存**与「均衡」不同的维度**（有意设计，不是 bug）：日后新增旋钮时，老预设不会把新维度钉死在旧默认值上。面板上「写入预设」按钮上方会显示实际存了哪几项。
- 「写预设」存的是**模板**，不会自动应用到当前会话 —— 存完还要点一下「预设」页签里那张卡。
- 套用预设是**完整替换**：维度、禁用词、偏好词、附加要求、范文五项都换成这份预设的，预设里没有的项就清空。
  这是有意的（每个预设是一整套，不继承上一套），但副作用要知道：先自己写了偏好词再点「冷硬派」，
  那几个词会被清掉。想留住就把偏好词连同维度一起「写入预设」，另存成一个同 id 的自定义预设覆盖它。
- 内置的 9 个预设不能就地改（它们是代码里的常量）；要改就换个新 id 另存一份。
- 范文超过 `sampleLimit` 会被截断并标注，防止一段范文吃光上下文。
- 风格规范是**系统提示段**，优先级低于用户在当轮的直接指令 —— 用户说「这轮用轻松点的语气」时，模型应当听用户的。
- 面板的轮询**失败后会自愈**（1.2/2.4/4.8… 秒重试，封顶 15s、最多 8 次），并把上一次成功的数据留在内存与
  `sessionStorage` 里，所以一次网络抖动不会让页签变空；真要卡住时页签上方会写「连接失败，正在自动重试…」。
  若长期空白：先跑 `tools/probe-live.mjs <host:port>` 分清是接口还是前端，再怀疑代码。

## 附：`tools/dsh-cookie-doctor.mjs`（启动失败诊断工具）

**这不是本插件的功能**，而是一个独立小工具，用来诊断 DSH 桌面端自身的启动问题。

### 它解决什么

桌面端每次启动都会在 `127.0.0.1` 上留下一条 `dsh-auth-<hash(host:端口)>` cookie。
浏览器 cookie **不按端口隔离**，所以每次启动是「新增」而不是「覆盖」。约 70 条后
`Cookie` 请求头超过 Node 默认的 16 KB，Host 返回 **HTTP 431**，客户端把 431 误报成：

```
The application could not start or stopped unexpectedly.
desktop welcome: Web authentication failed
```

**这个报错文案是误导的** —— 不是鉴权失败，是请求头太大。排查时容易被
`authenticateWebHost`（用 undici，不带 cookie jar，永远返回 303）的成功误导。

### 用法

```bash
# 诊断（应用运行时也能跑，只读）
node tools/dsh-cookie-doctor.mjs check

# 清理（必须先完全退出应用，含托盘）
node tools/dsh-cookie-doctor.mjs clean --keep-latest

# 只看会删多少
node tools/dsh-cookie-doctor.mjs clean --dry-run
```

### 安全约束

- 只动 `host_key IN ('127.0.0.1','localhost')` 且 `name LIKE 'dsh-auth-%'` 的行
- 其它 cookie 一条不碰（测试里断言了）
- 清理前自动备份 `Cookies.bak-<时间戳>`
- 应用正在运行时**拒绝**操作（否则会写坏 Chromium 的 SQLite）
- 用 `node:sqlite` 原生读写，不做二进制补丁

### 为什么不能只修一次

根因在 `app.asar` 里：`cookieName()` 用 `hash(authority)`，而 `authority` **包含端口**，
而桌面 shell 用 `--port 0` 随机端口。所以每启动一次就多一条，**大约每 70 次启动复发**。
Chromium 单 host 上限 180 条，到那时头部约 38 KB，会永久无法启动。

真正的修复要改 DSH 本身（cookie 名去掉端口 / 启动时清理历史 cookie / 提高 `maxHeaderSize`）。
在那之前，这个工具是止血方案。
