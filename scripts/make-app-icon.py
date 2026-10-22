"""
生成应用图标（像素风「花盆里的嫩芽」）。

用法：python scripts/make-app-icon.py

产出：
  build/icon.png                512×512（electron-builder 的通用图标）
  build/icon.ico                16/24/32/48/64/128/256 多尺寸（Windows exe/快捷方式）
  .cache/app-icon-preview.png   预览图（大图 + 真实小尺寸，用眼睛检查）

**为什么要脚本而不是手画一张**
  1. 像素图必须**整数倍**放大，否则边缘会糊；脚本能保证每一档都是最近邻。
  2. 16px 好不好认，是这类图标唯一的硬指标 —— 改一版生成一次，预览图里并排看。
  3. 颜色跟着应用走：木头色 + 嫩绿，和皮肤、按钮是同一套。

设计：浅米色圆角底板 + 陶土花盆 + 一株两片叶子的嫩芽。
底板不是装饰：透明图标在深色桌面上会糊成一团，垫一层浅色底轮廓才立得住。
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
S = 32  # 母版尺寸；所有档位都由它最近邻放大

OUTLINE = (46, 38, 24, 255)       # 深棕描边（和 UI 的木框同色系）
PLATE = (243, 232, 205, 255)      # 底板：浅米色
PLATE_EDGE = (206, 176, 118, 255)  # 底板描边
POT = (201, 114, 74, 255)         # 陶土
POT_DARK = (164, 82, 47, 255)     # 盆的暗面
POT_LIGHT = (226, 148, 106, 255)  # 盆的高光
SOIL = (112, 76, 46, 255)         # 土
STEM = (93, 159, 60, 255)         # 茎
LEAF = (124, 194, 66, 255)        # 叶


def layer(draw_fn) -> Image.Image:
    """在一张透明蒙版上画白色图形，返回 L 蒙版。"""
    mask = Image.new("L", (S, S), 0)
    draw_fn(ImageDraw.Draw(mask))
    return mask


def paint(mask: Image.Image, color) -> Image.Image:
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(color, mask=mask)
    return out


def outlined(mask: Image.Image, color=OUTLINE, width: int = 1) -> Image.Image:
    """把蒙版向外扩 width 像素，减去自身，得到描边环。"""
    dilated = mask.filter(ImageFilter.MaxFilter(width * 2 + 1))
    ring = ImageChops.subtract(dilated, mask)
    return paint(ring, color)


def build() -> Image.Image:
    # ---- 花盆：盆沿比盆身宽，盆身是收口的梯形 ----
    pot_rim = layer(lambda d: d.rectangle([(7, 19), (24, 22)], fill=255))
    pot_body = layer(lambda d: d.polygon([(8, 22), (23, 22), (21, 30), (10, 30)], fill=255))
    pot = ImageChops.lighter(pot_rim, pot_body)

    # ---- 茎：露在叶子之间和盆口上方 ----
    stem = layer(lambda d: d.rectangle([(14, 12), (16, 20)], fill=255))

    # ---- 两片叶子：左右错开，中间留出茎（不然缩到 16px 会糊成一根棍）----
    leaf_l = layer(
        lambda d: d.polygon([(15, 17), (11, 15), (7, 13), (4, 12), (6, 15), (10, 18), (14, 19)], fill=255)
    )
    leaf_r = layer(
        lambda d: d.polygon([(16, 12), (18, 9), (21, 6), (25, 5), (23, 8), (20, 11), (17, 13)], fill=255)
    )

    subject = ImageChops.lighter(ImageChops.lighter(pot, stem), ImageChops.lighter(leaf_l, leaf_r))

    # ---- 底板：满版的圆角方块（切角实现，像素图里比抗锯齿圆角干净）----
    # 不画边：描一道边会变成"相框"，16px 下尤其明显。留白交给图形自己。
    plate = Image.new("L", (S, S), 0)
    pd = ImageDraw.Draw(plate)
    pd.rectangle([(0, 2), (31, 29)], fill=255)
    pd.rectangle([(2, 0), (29, 31)], fill=255)
    for x, y in ((0, 0), (31, 0), (0, 31), (31, 31), (1, 1), (30, 1), (1, 30), (30, 30)):
        pd.rectangle([(x, y), (x, y)], fill=0)

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.alpha_composite(paint(plate, PLATE))

    # ---- 主体先在单独一层画完，再整体上移 2px ----
    # 不然盆底会顶到（甚至越过）底板下边缘，描边被切掉，看着像"盆被裁了一刀"
    art = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    art.alpha_composite(outlined(subject))
    art.alpha_composite(paint(pot, POT))
    art.alpha_composite(paint(stem, STEM))
    art.alpha_composite(paint(leaf_l, LEAF))
    art.alpha_composite(paint(leaf_r, LEAF))

    # ---- 细节：只画大色块，碎高光在 16px 下会变成噪点 ----
    detail = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(detail)
    d.rectangle([(7, 19), (24, 19)], fill=POT_LIGHT)  # 盆沿上亮边
    d.rectangle([(8, 20), (23, 20)], fill=SOIL)       # 盆口的土
    d.rectangle([(7, 22), (24, 22)], fill=POT_DARK)   # 盆沿下暗边
    d.polygon([(11, 23), (13, 23), (12, 28), (10, 28)], fill=POT_LIGHT)
    d.polygon([(21, 23), (22, 23), (21, 28), (20, 28)], fill=POT_DARK)
    art.alpha_composite(Image.composite(detail, Image.new("RGBA", (S, S), (0, 0, 0, 0)), subject))

    # 上移 2px 让盆底落在底板内
    img.alpha_composite(ImageChops.offset(art, 0, -2))
    return img


def main() -> None:
    base = build()
    build_dir = ROOT / "build"
    build_dir.mkdir(exist_ok=True)

    sizes = [16, 24, 32, 48, 64, 128, 256, 512]
    rendered = {size: base.resize((size, size), Image.NEAREST) for size in sizes}

    rendered[512].save(build_dir / "icon.png")
    rendered[256].save(build_dir / "icon.ico", sizes=[(s, s) for s in [16, 24, 32, 48, 64, 128, 256]])

    # 预览：两行 —— 同一组尺寸分别在浅色 / 深色桌面上看
    # （图标要同时在浅色资源管理器和深色桌面上立得住）
    cache = ROOT / ".cache"
    cache.mkdir(exist_ok=True)
    pad = 16
    row_h = 512
    width = 512 + pad * 2 + sum(s + 16 for s in [16, 32, 64, 128])
    preview = Image.new("RGBA", (width, row_h * 2 + pad * 3), (250, 245, 232, 255))
    preview.paste(Image.new("RGBA", (width, row_h), (43, 43, 43, 255)), (0, row_h + pad * 2))

    smalls = [16, 32, 64, 128]
    x = 512 + pad + 8
    for y0 in (pad, row_h + pad * 3):
        preview.alpha_composite(rendered[512], (pad, y0))
        for size in smalls:
            preview.alpha_composite(rendered[size], (x, y0 + (row_h - size) // 2))
            x += size + 16
        x = 512 + pad + 8
    preview.convert("RGB").save(cache / "app-icon-preview.png")

    print("written: build/icon.png build/icon.ico .cache/app-icon-preview.png")


if __name__ == "__main__":
    main()
