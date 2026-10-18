# 第三方素材

本项目尽量不引入外部素材：云、木牌、草地、图标、动画都由 CSS / SVG 生成。
下面是唯一的第三方资源。

## Fusion Pixel Font

- 用途：界面像素字体（正文、标题、按钮）
- 版本：12px proportional，zh_hans 子集
- 文件：`src/renderer/src/assets/fusion-pixel-12px-proportional-zh_hans.woff2`（约 680 KB）
- 作者：TakWolf
- 来源：https://github.com/TakWolf/fusion-pixel-font
- 许可：SIL Open Font License 1.1，全文见 `src/renderer/src/assets/FUSION-PIXEL-OFL.txt`

## 评估过但未采用的字体

- **IPix**（itch.io，作者 Sadi）：由 HZK16 字模矢量化而来；HZK16 出自 DOS 时代的
  UCDOS / Compufont 字模，[作者自己的说明](https://github.com/TakWolf/hzk-pixel-font/blob/master/LICENSE-FONT.md)
  明确写着「并非公有领域，请自负版权风险」。本仓库是公开 MIT 项目，
  因此**不打包**这套字体。界面字体继续用 OFL 授权的 Fusion Pixel（见上）。
