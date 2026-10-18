# 皮肤系统（星露谷主题）

> 应用**不自带任何游戏素材**。皮肤从本机 `textures/` 目录读取，读不到就退回 CSS 默认外观。
> 改皮肤不需要动代码；改代码必须重新打包。两条路分得很清楚，见第 5 节。

---

## 1. 素材从哪读

`src/main/ipc/index.ts` 的 `app:textures` 按顺序扫两个目录：

| 顺序 | 目录 | 什么时候用 |
|---|---|---|
| 1 | `<userData>/textures`（Windows：`%APPDATA%\Sproutbook\textures`） | **始终优先**，用户自己放素材的地方 |
| 2 | `<appPath>/textures`（仓库根目录 `textures/`） | 只有开发模式（`!app.isPackaged`）才会读 |

找到的第一个 `theme.json` 生效；`icons/` 目录两个地方都会扫，先找到的优先。
`textures/` 在 `.gitignore` 里，不进仓库（版权素材）。

---

## 2. `theme.json`

**必须无 BOM**。PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，导致 `JSON.parse` 静默失败、皮肤整体失效（表现：看起来"没生效"）。

当前配置：

```json
{
  "slots": {
    "sign":   { "file": "image/logo.png" },
    "panel":  { "file": "ui/panel.png",  "slice": [28, 34, 30, 28] },
    "button": { "file": "ui/button.png", "slice": [34, 34, 22, 34] }
  },
  "backgrounds": ["image/bg_winter.png"]
}
```

### 字段

| 字段 | 说明 |
|---|---|
| `file` | 相对 `textures/` 的路径，可以带子目录 |
| `crop` | `{x,y,w,h}`，从大图里裁一块（运行时用 `nativeImage.crop`，裁切后转 PNG 保留透明） |
| `slice` | 九宫格边距。**单值**=四边相同；**数组**=`[上, 右, 下, 左]`。单位是**源图像素** |
| `backgrounds` | 首页/全局背景轮播，最多 8 张 |

`slice` 的实际渲染宽度由 CSS 的 `border-width` 决定：素材放 2× 就把 `slice` 也写 2×，这样边框按 1:1 像素绘制，不会糊。

### 五个槽位

| 槽位 | 作用 | 没有 `slice` 时 | 有 `slice` 时 |
|---|---|---|---|
| `panel` | 整页木框（`.content`） | 拉伸铺满 | `border-image` 九宫格 |
| `button` | 首页大按钮 + 小按钮 | 整张图拉伸，**会隐藏文字**（图必须自带字） | `border-image`，文字保留 |
| `sign` | 首页木牌（整张带字图） | 按图片比例显示 | — |
| `cloud` | 首页云朵 | 拉伸 | — |
| `home-bg` | 首页整屏背景 | `cover` | — |

### 图标覆盖

`textures/icons/<name>.png` 会替换 `PixelIcon` 里同名的字符图标（没有就回退到画的 SVG）。
可用名字：`garden` `species` `care` `exit` `gear` `sound` `mute`。
当前放了 4 个：garden（白萝卜）、species（红皮书）、care（洒水壶）、exit（白鸡，16×16）。

---

## 3. CSS 钩子

`App.tsx` 读到素材后给 `<html>` 加类、给 `:root` 写变量：

| 类 | 变量 | 说明 |
|---|---|---|
| `tex-panel` | `--tex-panel` | 面板图 |
| `tex-panel-slice` | `--tex-panel-slice`（=上） | 额外写 `-t` `-r` `-b` `-l` 四个 |
| `tex-button` | `--tex-button` | 按钮图 |
| `tex-button-slice` | `--tex-button-slice-t/r/b/l` | 同上 |
| `tex-sign` / `tex-home` / `tex-cloud` | `--tex-*` | 整张图 |

`theme.css` 里所有皮肤规则都以 `html.tex-*` 开头，没皮肤时一条都不生效。

---

## 4. 当前这版的参数

| 项 | 值 | 位置 |
|---|---|---|
| 页面宽 | `1120px` | `html.tex-panel-slice .content { width }` |
| 外圈留白 | `50px` | `html.tex-panel-slice .main { padding }` |
| 顶行高度 | `50px`（tab / HUD 本体 38px） | `.page-topbar` |
| 面板框 | `ui/panel.png`，**1×**，`[14,17,15,14]` | theme.json |
| 大按钮 | `ui/button.png`，2×，`[34,34,22,34]`，最小 150×110 | theme.json + `.home-btn` |
| 小按钮（齿轮/后退/tab） | 同一张图压到 8px 边框（small 6px） | `.home-gear` `.back-btn` `.care-tab` `.pixel-btn` |
| 弹窗 | 同一张 panel 图，`[14,17,15,14]`，头脚改虚线分割 | `.modal` |
| 选中 tab | `#9ec46a`（同 primary 按钮） | `.care-tab.on` `.pixel-btn.primary` |
| 卡片 | 单线 2px，去掉 inset 高光 | `.pixel-panel` `.pixel-card` |
| 标题栏 | 高 40，按钮 10/10 内缩 | `.titlebar` |
| HUD | 日期 / 天气 / 待办 三块，宽屏常显；<1080 隐藏日期 | `components/TopHud.tsx` |
| 字体 | 平滑中文（微软雅黑 / 思源黑体），`font-weight: 600` | `body` |
| 滚动条 | 页面竖条隐藏（`overlay` + `gutter:auto`），内部条保留 | `.content` |
| 切页动画 | 套皮时关掉（`page-in` / `panel-rise`） | `.content-inner` |
| 页面底色 | `#ffcb7b`（与框内一致） | `.content` |

### 顶行结构（所有分区一致）

```tsx
<main>
  <div className="page-topbar">      {/* 50px，养护区左边是 tab，其他区只有右边的 HUD */}
    <div className="care-tabs">…</div>   {care ? 四个 tab : null}
    <TopHud … />
  </div>
  <div className="content">…</div>   {/* 所有分区都是 .main 的直接子元素 */}
</main>
```

**不要**再给某个分区单独包一层容器把 `.content` 挪深——结构一变，切页时 `.content` 会被卸载重建，产生一帧重排（表现：切页"跳一下"）。

### 素材来源

`textures/stardew-1.6.15/`（游戏 1.6.15 的完整导出，1044 张 PNG + BMFont + 提取工具）。
`ui/*.png` 是从游戏画面上裁的框，`stardew-1.6.15/` 是原始素材，两者互不依赖。

### `button.png` 的内圈被清成透明

边框 slice 给的是 34px，而实际木框只有 ~22px，多出的 12px 是按钮**填色**（`#ffd78a`）。它会被压进边框最里侧约 3px：平时和底色一样看不出来，一旦按钮变绿（选中 tab / primary 按钮），就会露出一圈没被覆盖的浅色带。

所以 `button.png` 里**边框环内、颜色等于填色的像素已被置为透明**，让底色透出来。改这张图时要保留这个处理，否则绿底按钮会重新出现那道浅边。


---

## 5. 改哪里、怎么生效

| 改什么 | 要做什么 |
|---|---|
| 只换图 / 调 `slice` / 换 `theme.json` | 放进 `<userData>/textures`，**重启应用** |
| 改 `theme.css` / `App.tsx` / `PixelIcon.tsx` / `ipc` | `npm run build` → `npx electron-builder --dir --win` → 重启 |
| 开发时快速试 | `npm run dev`（读仓库 `textures/`，热更新；`--screenshot` 系列参数只在 dev 生效） |

桌面快捷方式指向 `release\win-unpacked\Sproutbook.exe`（**打包版**，读 asar 里的代码）。
所以只 `npm run build` 是不够的，asar 不重打就看不到代码改动。

---

## 6. 踩过的坑（都是真金白银）

1. **BOM**：`theme.json` 带 BOM → 整份皮肤静默失效。写文件用 `[IO.File]::WriteAllText` + `new UTF8Encoding($false)`。
2. **userData 优先**：改了仓库 `textures/theme.json` 但用户那边没变，因为 `%APPDATA%` 里有一份旧的。
3. **`--data-dir` 会换掉 userData**：打包版截图时加了它，就读不到用户自己的皮肤（会看到默认外观）。
4. **滚动条占位导致切页横向跳**：`scrollbar-gutter: stable both-edges` 会随"这页要不要滚"预留/收回 12px。套皮时改 `auto` + `overlay` + 隐藏。
5. **`page-in` 动画**：内容上浮 6px，框固定不动 → 看起来像"跳一下"。套皮时关掉。
6. **边框被压扁**：`border-image` 的边框总宽超过盒子尺寸时，浏览器会整体缩小（底部最先消失）。按钮加了 `min-height: calc(上下 slice + 56px)` 兜底。
7. **`slice` 大于真实边框**：底部边框会被划进"中心"然后被拉伸填平。所以 `slice` 要按实测值给，四边不同就用数组。
8. **exe 占用**：重打包时若应用还开着，`electron-builder` 报 `EPERM: unlink Sproutbook.exe`。先 `Get-Process Sproutbook | Stop-Process -Force`。
9. **切片大于实际边框 → 内圈浅色带**：`slice` 把填色也算进边框后，绿底按钮会露出一圈没被覆盖的颜色。处理见第 4 节最后一段。
10. **图标网格用了不存在的色号**：`PixelIcon` 的字符网格只认 `PALETTE` 里的字母（`k o O w g G b B r y`）。写了别的字母（比如 `Y`）会**静默跳过**，图标就缺一块——太阳图标当初就是这么"消失"的。
11. **SVG 图标偏高**：按钮默认 `inline-block`，里面的 SVG 会贴文字基线。要 `display: inline-flex; align-items: center`；又因为汉字字形在行框里重心偏下，再补 `transform: translateY(1px)` 才视觉居中。
12. **emoji 和像素 UI 不搭**：tab 图标原来用 `🌤️ 📅 📓 🧪`，是彩色平滑字形，在木牌上非常出戏。已换成 `PixelIcon` 的 `sun` / `calendar` / `journal` / `flask`。

---

## 7. 相关文件

| 文件 | 作用 |
|---|---|
| `src/main/ipc/index.ts` | `app:textures`：读 theme.json、裁切、九宫格边距、icons 扫描 |
| `src/shared/api.ts` | `textures()` 返回类型 |
| `src/renderer/src/App.tsx` | 应用槽位 → CSS 变量 + `html` 类；`setIconUrls`；`.page-topbar` |
| `src/renderer/src/components/TopHud.tsx` | 顶部状态条：日期 / 天气 / 待办数 |
| `src/renderer/src/theme.css` | 所有 `html.tex-*` 规则（约 3300 行起） |
| `src/renderer/src/components/PixelIcon.tsx` | 图标：字符网格 + 图片覆盖 |
| `textures/stardew-1.6.15/` | 游戏素材包（1044 PNG + BMFont + 提取工具） |
| `textures/ui/*.png` | 本皮肤用的九宫格块 |
| `textures/icons/*.png` | 图标覆盖 |
