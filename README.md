# Sproutbook 🌱

像素风（farm-sim 风格）的**植物养护管理桌面应用**。本地优先：数据全部存在你自己的电脑上，没有账号、没有云端。

用「物种库 + 我的植株」两层结构管理植物档案，用可编辑的信息模板定义你想记录什么，用 AI 帮你查资料——但 AI 只是**建议**，永远不会绕过你的确认直接写入。

![我的花园](docs/screenshot-garden.png)

| 物种库 | 可编辑信息模板 | 设置与养护位置 |
|---|---|---|
| ![物种库](docs/screenshot-species.png) | ![信息模板](docs/screenshot-templates.png) | ![设置](docs/screenshot-settings.png) |

> 以上截图由应用自身的 `--screenshot` 自检开关生成（见下文），数据来自 `scripts/seed-demo.mjs`。

> 名称 `Sproutbook` 是**暂定代号**，与任何商业游戏无关。仓库内不含任何第三方游戏素材。

---

## 目录

- [现在能做什么](#现在能做什么)
- [设计取舍（为什么这么做）](#设计取舍为什么这么做)
- [快速开始](#快速开始)
- [AI 配置](#ai-配置)
- [数据与备份](#数据与备份)
- [常见问题](#常见问题)
- [路线图](#路线图)
- [English](#english)

---

## 现在能做什么

### ✅ 已实现

| 功能 | 说明 |
|---|---|
| **物种库** | 植物百科信息：名称 / 学名 / 别名 / 科属 / 株型 / 花期 / 春花需求 / 光照 / 耐热耐寒 / 毒性等 |
| **可编辑信息模板** | 字段是数据不是代码。加一个字段，所有编辑表单立刻生效，无需改前端。**「所属物种 / 养护位置 / 状态」也在模板里**，与其它字段一样可排序、改标签、换分组 |
| **我的植株** | 你实际养的那一株：昵称、所属物种、养护位置、状态、入手日期、盆径、备注、图片 |
| **养护位置管理** | 位置不只是标签：光照等级与每日直射时长用于匹配度提示，城市 / 经纬度与可加温 / 能防冻是将来霜冻预警的输入 |
| **多段月份** | 花期、休眠期可以选多段（月季 4~6 月 **+** 9~11 月），区间只是特例；索引一个月一行，「本月开花」查询天然精确 |
| **列表 / 搜索 / 筛选 / 统计** | 按名称别名搜索、按科筛选、「本月开花」筛选、位置分布统计 |
| **图片管理** | 上传后复制进应用数据目录并自动生成缩略图，数据库只存文件名 |
| **导入导出** | 物种 / 植株导出为 CSV（Excel 可编辑）或 JSON（保留原生类型）；导入前先预览列匹配、必填缺失与重名，可选择跳过或覆盖。「所属物种 / 养护位置」导出的是**名字**而非数据库 ID，换台电脑也能用 |
| **配方** | 配土 / 肥料 / 药剂的配法。支持**比例写法**（泥炭 : 珍珠岩 : 蛭石 = 5 : 3 : 2）与**绝对用量**（缓释肥 20 克）两种方式并存；边填边显示比例摘要，输入份数立刻算出「配 10 盆各要多少」。材料库统一管理分类与单位，库外的临时材料也能直接写名字 |
| **养护计划** | 规则库按「哪个月做什么」定义（内置 20 条，可增删改），一键为每株植物生成全年任务。支持**周期与轮换**（如「每 8 天一轮：花多多1号 → 海藻精 → 腐植酸水溶肥」循环）。任务带**时间窗**（±15 天）而不是死线，窗口内做都算准时；逾期任务永远置顶，不会被翻月翻掉。月历视图看节奏，打勾完成会**自动写一条养护日志**形成时间线；侧栏角标显示压着几件事 |
| **AI 自动补全** | 输入植物名 → 生成字段草稿 → 逐字段勾选确认后才写入；**安全字段强制人工核实**，且可逐个标记 / 撤回 |
| **备份与恢复** | 启动 / 退出 / 结构升级前自动滚动备份，也可手动立即备份 |
| **启动自诊断** | 启动日志记录参数、关键路径可写性与窗口显示情况；页面级错误边界避免白屏 |

> 还没做的功能与顺序见文末的[路线图](#路线图)。

---

## 设计取舍（为什么这么做）

这部分解释了代码里那些看起来「多此一举」的设计，也是后续开发的约定。

### 1. 物种（species）与植株（plants）必须分两层

「月季的科是蔷薇科」是**物种级知识**，养三盆月季不需要抄三遍，AI 也只需要补全一次。
「这盆月季是 2023 年买的」是**实例级数据**，每株都不同。

所以：`species 1—N plants`，AI 补全与图片挂两边各取所需，统计按物种聚合。

### 2. 可编辑模板 = JSON 列 + 索引投影表

没有用「动态 ALTER TABLE」（迁移地狱），也没有用纯 EAV（查询拼装复杂）。
字段值存在 `attributes_json`，同时投影到 `attr_index` 表：

- 多值字段（多选、标签）→ 一行一个值
- 月份字段（花期 4~6 月 + 9~11 月）→ 一行一个月，多段就是多行，查询无需字符串切分

于是「本月开花」是一次普通的索引命中，而不是在 SQL 里切 JSON 字符串。
投影是**纯派生数据**，随时可以从 JSON 全量重建（自检里就有一项专门验证重建前后一致）。

### 3. 字段只归档，不物理删除

删字段等于删数据。系统字段不可删不可改类型；已被使用的字段只能归档；
只有从未被填写过的字段才允许真删。改类型时界面会明确告知影响面。

### 4. 用 `node:sqlite`，不用 better-sqlite3

`better-sqlite3` 是原生模块，需要本地编译或匹配 ABI 的预编译包，在没有 MSVC 构建工具的机器上直接装不上。
`node:sqlite` 是 Node 22+ 内置的，**零原生依赖、零编译**，对「任何人 clone 下来就能跑」和 CI 稳定性是决定性的。

代价：它只接受 `string / number / bigint / null / Uint8Array` 作为绑定值，
**传 boolean 或 undefined 会直接抛错**。这个坑统一收口在 `src/main/db/connection.ts` 的 `normalize()` 里。

### 5. AI 永远不会绕过确认

- AI 产出的是**草稿**，界面上逐字段勾选后才写入
- 安全字段（毒性、有毒部位、中毒症状、急救）额外标记，必须人工核实，界面持续提示
- 安全字段的「待核实」状态精确到字段，不会把用户手填的信息也标成待核实
- **没配 API Key 时全部功能照常可用** —— AI 是增强，不是依赖
- 每次调用写 `ai_runs` 审计表，出问题能复盘「它当时到底收到了什么」

### 6. 领域逻辑与框架解耦

`src/core/` 是纯逻辑：字段类型系统、校验、投影、格式化。零 DOM、零 Node API、零 Electron 依赖。
主进程和渲染进程共用同一份实现，杜绝「两边行为不一致」。
将来要做手机版时，这一层可以原样复用，只需换壳。

### 7. 一个自检，两个入口

`src/main/smoke.ts` 把整条数据链路真实跑一遍（迁移幂等、绑定归一化、投影展开、
部分更新不丢字段、必填校验、字段删除保护、投影重建一致性、备份产出），
**不依赖 Electron、也不依赖打包器**，所以既能当 CI 冒烟测试，也能在真实运行时里跑。

---

## 快速开始

### 环境要求

- **Node.js ≥ 20**（推荐 22 / 24）
- **pnpm**（推荐；npm 也能用，但构建脚本白名单是本仓库按 pnpm 配的）
- Windows / macOS / Linux

### 安装与运行

```bash
pnpm install
pnpm dev          # 开发模式（热更新）
```

首次 `pnpm install` 时 pnpm 会提示有依赖被禁止执行安装脚本（`ERR_PNPM_IGNORED_BUILDS`）。
本仓库已在 `pnpm-workspace.yaml` 里放行了必需的 `electron` 与 `esbuild`，正常情况不会出现该提示。
若新增依赖触发提示，请先确认该包确实需要脚本再放行。

### 自检与构建

```bash
pnpm smoke        # 数据层端到端自检（不需要 Electron，适合 CI）
pnpm typecheck    # 类型检查（主进程 + 渲染进程）
pnpm build        # 类型检查 + 打包前端产物到 out/
pnpm dist:win     # 生成 Windows 安装包到 release/
pnpm dist         # 按当前平台打包
```

界面自检（用于排查白屏 / 渲染崩溃这类只在真实窗口里暴露的问题）：

```bash
electron . --screenshot=out.png                          # 截图后自动退出
electron . --screenshot=out.png --screenshot-route=settings   # 截指定页面
```

支持的路由：`garden` / `species` / `plans` / `recipes` / `templates` / `settings`。
界面本身也用 URL hash 记路由（`#/species`），刷新不会跳回首页。

升级 Electron 版本后，建议跑一次运行时能力探测，确认数据库层依赖的假设仍然成立：

```bash
ELECTRON_RUN_AS_NODE=1 electron scripts/runtime-probe.cjs   # Windows: 用 cmd 执行
```

它会验证 `node:sqlite` 是否可用、WAL 能否开启、以及**布尔值/undefined 是否仍会被拒绝绑定**
（这是本项目在 `connection.ts` 里做归一化的原因）。

### 体验演示数据

不想手动录入也能看到完整界面：

```bash
node scripts/seed-demo.mjs .cache/demo
electron . --data-dir=.cache/demo
```

`--data-dir=<目录>` 会把数据目录指到别处（便携模式 / 多套数据 / 测试隔离），不影响你的正式数据。

### 国内网络

`.npmrc` 已配置 npmmirror 镜像（registry、Electron 二进制、electron-builder 二进制）。
若你的网络环境不同，删掉或修改 `.npmrc` 里的 `*_mirror` 即可。

---

## AI 配置

「设置 → AI」里填写，支持**任何 OpenAI 兼容接口**：
OpenAI、DeepSeek、Moonshot、智谱 GLM、OpenRouter、本地 Ollama / LM Studio，
以及各类中转网关。界面上内置了几个常用预设，选一下会自动填好地址与模型名。

- **接口地址（Base URL）**：通常以 `/v1` 结尾。应用会访问 `{地址}/chat/completions`
- **对话模型**：用于信息补全
- **视觉模型**：为将来的识图功能预留
- **API Key**：保存在操作系统钥匙串（Windows DPAPI / macOS Keychain / Linux libsecret），
  **不写数据库、不进 git、不回显**。若系统钥匙串不可用，会降级为明文保存并**明确提示你**
- **超时 / 重试**：只对网络错误、429、5xx 重试；4xx 立即失败并给出服务端原文
- **测试连接**：先尝试列出模型，不支持时改用一次极短对话验证

> ⚠️ 安全提醒：AI 在**毒性、有毒部位、急救处理**这类信息上可能出错。
> 应用会把这类字段标记为「待核实」并持续提示，但**最终判断请务必对照可靠资料**。
> 涉及儿童或宠物误食风险的场景，不要仅依赖本应用。

---

## 数据与备份

所有数据都在你的用户目录下（「设置 → 数据与备份」里可以直接打开）：

| 内容 | 位置 |
|---|---|
| 数据库 | `<用户数据目录>/data/sproutbook.db` |
| 图片 | `<用户数据目录>/images/` |
| 自动备份 | `<用户数据目录>/backups/`（滚动保留最近 5 份） |
| API Key | `<用户数据目录>/secrets/credentials.json`（系统钥匙串加密） |

备份文件是完整的 SQLite 数据库，可以直接复制保存。应用在**每次启动、退出、以及数据库结构升级前**都会自动备份。

---

## 常见问题

**双击 `Sproutbook.exe` 没反应 / 一闪就没了（异常码 `0x80000003`）**

按下面的顺序排查。**第 ① 步最容易被忽略，也最容易被误判成「Chromium 沙箱坏了」——
但它是真实项目里最常见的原因，先查它。**

### ① 先查程序目录的权限（最常见）

在 PowerShell 里对**程序所在目录**执行：

```powershell
icacls "C:\你的\程序目录"
```

输出里只要出现下面任意一项，就是这个问题：

| 看到什么 | 含义 |
|---|---|
| `Mandatory Label\Low Mandatory Level` | 可执行文件被打上了低完整性标签 |
| `S-1-4-...`（AppContainer 能力 SID） | 文件被某个沙箱环境标记过 |
| `Everyone:(DENY)(DC)` | 显式拒绝删除子项 |

**典型症状：同一个 `Sproutbook.exe`，右键「以管理员身份运行」能起来，普通双击不行。**
这是因为管理员令牌能绕开这些限制。同一个原因还会导致：

- 安装程序报「Sproutbook 无法关闭」—— 它没法替换被 `DENY Delete Child` 保护的文件
- 事件查看器里出现 `0x80000003`（STATUS_BREAKPOINT），看起来像沙箱崩溃

**这些标记是怎么来的**：如果在**受限/沙箱化的环境里构建**（低完整性终端、某些 CI runner、
带目录沙箱的 Agent 工具等），构建过程产生的**每一个**文件都会带上这些标记 ——
包括 `node_modules` 里的 `electron.exe`。打包时它被原样复制成产物里的 `Sproutbook.exe`，
于是污染代代相传，**换目录重新 `git clone` 也没用，因为 `node_modules` 会被重新装成脏的**。

**修复（管理员 PowerShell）**：

```powershell
$dir = "C:\你的\程序目录"
icacls $dir /reset /T /C /Q
icacls $dir /setintegritylevel "(OI)(CI)Medium" /T /C /Q
```

> ⚠️ `"(OI)(CI)Medium"` 的括号**必须加引号**。不加的话 PowerShell 会把 `(OI)` 当成命令，
> 报「无法将"OI"项识别为 cmdlet」。

修完用 `icacls` 复查，确认 `Low Mandatory Level` / `S-1-4-` / `DENY` 都消失了，
然后**重新执行完整构建**：

```bash
rmdir /s /q release
pnpm install        # 必须重装：node_modules 是污染源
pnpm dist:win
```

> 只删 `release` 重打包是不够的 —— `node_modules` 里的 `electron.exe` 还是脏的，
> 而它会被原样复制成 `Sproutbook.exe`。

### ② 检查是不是在受限终端里启动的

```powershell
whoami /groups | Select-String "Mandatory"
```

- `Medium Mandatory Level` = 正常
- `Low Mandatory Level` = 你正处在一个受限环境里（沙箱化终端、部分远程会话、CI runner）。
  Chromium 的进程沙箱需要创建受限令牌并派生中等完整性的子进程，低完整性令牌做不到，
  **必然崩溃**。换一个普通终端，或在 Windows 资源管理器里直接双击即可。

### ③ 检查安全软件

360、火绒、腾讯电脑管家等会注入进程、破坏沙箱初始化。临时退出后测试即可确认。

### ④ 以上都排除了，才考虑沙箱兜底

与 exe 同目录的 `Sproutbook-compat.cmd` 会额外传入 `--no-sandbox` 与 `--disable-gpu`：

```
Sproutbook.exe --no-sandbox --disable-gpu
```

或者用**兼容模式快捷方式**：`设置 → 启动兼容性 → 在桌面创建兼容模式快捷方式`，
它用 Electron 内置的 `shell.writeShortcutLink` 生成一个原生 `.lnk`，
把参数烘焙进去，之后双击桌面图标即可。

> 安全影响：关闭渲染进程沙箱会降低隔离强度。本应用只加载本地文件、CSP 已禁止一切远程资源、
> `contextIsolation` 开启、`nodeIntegration` 关闭，因此风险可控；但**它是绕过症状，不是修复**，
> 请务必先走完 ①②③。

**补充事实（已实测）**：应用**无法**在启动时自救 —— 曾经实现过「标记文件 +
`app.commandLine.appendSwitch('no-sandbox')`」，实测仍然是 `0x80000003`，
因为 Chromium 的沙箱初始化早于主进程 JavaScript。所以 `--no-sandbox` 只能出现在命令行上。

### ⑤ 其他

- 修复系统文件：`sfc /scannow`，必要时再跑 `DISM /Online /Cleanup-Image /RestoreHealth`
- 检查是否启用了 AppContainer / Device Guard / 应用控制相关策略

### 仍然无解时

应用会写启动日志，里面记录了启动参数、三个关键路径、**每个目录的可写性探测**，
以及窗口是否成功显示：

```
%APPDATA%\Sproutbook\startup.log
```

把它发出来通常一眼就能定位。

**Windows 提示「已保护你的电脑」/ macOS 提示「已损坏」**
安装包没有代码签名，这是正常现象。Windows：点「更多信息 → 仍要运行」。
macOS：右键点图标选「打开」，或执行 `xattr -dr com.apple.quarantine /Applications/Sproutbook.app`。

**为什么节点包安装要用 hoisted 布局？**
pnpm 默认的符号链接布局在 Windows 上会创建 junction，而 Node 的 ESM 解析器在部分路径下不会 realpath 它们，
导致 Vite 工具链解析不到自己的传递依赖。扁平布局让任意层级的解析都能成功。
详见 `pnpm-workspace.yaml` 里的注释。

**`pnpm dist` 打包失败怎么办？**

打包路径上有两处已知的上游坑，仓库都已修正，如果你改动依赖树后复现，按下面排查：

| 报错 | 原因 | 修正位置 |
|---|---|---|
| `Cannot read properties of undefined (reading 'ReadWrite')` | electron-builder 26 声明 `@electron/get: ^3.0.0`，但代码要用 3.1.0 才有的 `ElectronDownloadCacheMode` | `pnpm-workspace.yaml` 里的 `overrides` |
| `No JSON content found in output` | electron-builder 调用 `pnpm list --json` 收集依赖树，而 pnpm 11 会在 JSON 前后打印供应链校验横幅 | `build/before-build.cjs` 返回 `false`，跳过依赖收集（本项目零运行时依赖，语义上就是对的） |
| `unable to verify the first certificate` | 打包时想重新下载 Electron（公司代理 / TLS 中间人） | `electron-builder.yml` 的 `electronDist` 直接复用已下载的运行时，打包完全离线 |

**注意**：若将来引入了**运行时**依赖（即需要真实存在于 `node_modules` 里的包），必须删掉 `electron-builder.yml` 里的 `beforeBuild` 配置，否则那些依赖不会被打进安装包。

**数据库能直接用别的工具打开吗？**
能。就是标准 SQLite 文件。但请注意：`attr_index` 是派生表，手改 `attributes_json` 后筛选会不一致——
在应用里重新保存一次记录即可自动同步。

---

## 路线图

| 版本 | 内容 | 状态 |
|---|---|---|
| **v0.1** | 物种库 / 可编辑模板 / 植株管理 / 搜索统计 / 图片 / AI 补全 / 备份 | ✅ 已完成 |
| **v0.2** | 导入导出（CSV / JSON）、养护位置管理、多段月份、`relation` 字段类型 | ✅ 已完成 |
| **v0.3** | 配方（材料库 + 比例/用量 + 换算） | ✅ 已完成 |
| **v0.3** | 养护计划（规则库 + 任务生成 + 时间窗 + 月历 + 完成打勾 + 养护日志时间线 + 侧栏角标） | ✅ 已完成 |
| **v0.3** | 养护规则的**周期与轮换**（每 N 天一轮、多肥循环） | ✅ 已完成 |
| **v0.4** | 停用规则（休眠期停某类任务）、规则绑定配方、AI 生成规则草稿 | 计划中 |
| **v0.4** | 天气与霜冻预警（Open-Meteo）、高温自动提示暂停施肥 | 计划中 |
| **v1.0** | 像素风花园视图（生长展现）、月历导出成图片、双语、代码签名 | 计划中 |
| **v1.x** | 移动端（复用 `src/core` + 换壳）、真推送通知 | 计划中 |

### 🚧 计划中

- **停用规则**：现在规则只能「增加」任务，不能「抑制」——表达不了
  「休眠期停止所有水溶追肥」「花苞显色后全部停肥」这类条件
- **物候阶段**：花芽分化期是**观察到的状态**而不是固定月份，
  需要「手动标记已现蕾 → 自动切换阶段」这一层
- **事件触发**：缓苗、暴雨后救苗这类只能手动建任务，可做成预设模板一键生成
- **规则绑定配方**：底肥的「羊粪 + 缓释肥 + 少量骨粉」现在只能写成文本说明，
  应该直接引用配方，让材料比例结构化
- **天气与霜冻预警**：接入 Open-Meteo，在低温来临前提示；
  也可以在持续 35℃ 时自动提示「暂停花多多，只用海藻精」
- **配方与植株的关联**：记录「这盆用的是什么土」，并在养护任务里直接引用配方
- **星露谷式花园视图**：用当前月份 + 播种日期推导生长阶段（卡片布局已就绪，**生长阶段美术素材待补**）
- **识图生成**：拍照 → Top-3 候选 → 人工确认 → 生成信息草稿（设置里已有「视觉模型」占位）

---

## 许可

代码：MIT（见 [LICENSE](LICENSE)）。
本仓库**不包含**任何第三方游戏的美术资源；界面全部由 CSS 与系统字体绘制。
将来引入的像素素材会逐个记录来源与许可见 `CREDITS.md`。

---

## English

**Sproutbook** is a local-first, pixel-art styled desktop app for managing your houseplants.

Records are split into two layers that most plant apps conflate:

- **Species** — encyclopedic knowledge (family, toxicity, cold hardiness, bloom months). Shared, AI-fillable, one entry per species.
- **Plants** — the actual pot on your balcony (nickname, location, status, acquired date, photos).

An **editable field template** defines what you can record: fields are data, not code.
Adding a field immediately shows up in every form. Values live in a JSON column and are
projected into an index table, so queries like "what blooms this month?" hit an index
instead of scanning JSON.

**AI is strictly opt-in and never bypasses confirmation.** It produces a draft that you
review field by field. Toxicity-related fields are flagged and must be verified by a human.
The app is fully usable with no API key at all.

Tech: Electron 41 + React 19 + TypeScript 5.9 + `node:sqlite` (zero native compilation).

```bash
pnpm install
pnpm dev        # develop
pnpm smoke      # data-layer end-to-end self-check (no Electron needed)
pnpm dist:win   # package for Windows
```

Licensed under MIT.
