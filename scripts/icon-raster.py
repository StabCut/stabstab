#!/usr/bin/env python3
"""StabStab 图标光栅化后端（Pillow）。

直接解析 build/icon.svg 里的 <rect> / <polygon>，用 Pillow 渲染成 PNG + 多尺寸 ICO。
这样「SVG 是唯一真相」：光栅化结果严格由 icon.svg 驱动，不需要 ImageMagick 或 cairo。

做法：每个目标尺寸都按目标分辨率原生重绘（不做大图缩小的模糊降采样），
并在 4 倍超采样下用 lanczos 缩小，得到干净的抗锯齿边缘。

用法：
    python scripts/icon-raster.py <icon.svg> <out.png> [out.ico] [--size 1024]

依赖：Pillow >= 9
"""
import re
import sys

from PIL import Image, ImageDraw

SS = 4                      # 超采样倍率
ICO_SIZES = (256, 128, 64, 48, 32, 16)


def _hex_to_rgb(value, alpha=255):
    v = (value or "").strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) != 6:
        raise ValueError("非法颜色值: %r" % (value,))
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16), alpha)


def parse_svg(text):
    """抽取 (画布边长, [图层...])；只支持绘制本图标所需的 rect / polygon。"""
    vb = re.search(r'viewBox="([^"]+)"', text)
    if vb:
        parts = [float(x) for x in re.split(r"[,\s]+", vb.group(1).strip())]
        width, height = parts[0], parts[1]
        if len(parts) >= 4:
            width, height = parts[2], parts[3]
    else:
        width = height = float(re.search(r'width="([\d.]+)"', text).group(1))
    if abs(width - height) > 1e-6:
        raise ValueError("图标画布必须是正方形：%s x %s" % (width, height))

    layers = []
    for m in re.finditer(r"<rect\b([^>]*)/?>", text):
        attrs = m.group(1)

        def get(k, d=None, _a=attrs):
            hit = re.search(re.escape(k) + r'="([^"]+)"', _a)
            return hit.group(1) if hit else d

        layers.append({
            "kind": "rect",
            "x": float(get("x", 0)), "y": float(get("y", 0)),
            "w": float(get("width")), "h": float(get("height")),
            "r": float(get("rx", 0)),
            "color": get("fill"),
        })
    for m in re.finditer(r"<polygon\b([^>]*)/?>", text):
        attrs = m.group(1)
        pts = re.search(r'points="([^"]+)"', attrs).group(1)
        coords = [float(x) for x in re.split(r"[,\s]+", pts.strip())]
        fill = re.search(r'fill="([^"]+)"', attrs).group(1)
        layers.append({
            "kind": "poly",
            "points": list(zip(coords[0::2], coords[1::2])),
            "color": fill,
        })
    return width, layers


def render(width, layers, size, ss=SS):
    """渲染为 size x size 的 RGBA 图（内部按 ss 倍超采样）。"""
    scale = (size * ss) / float(width)
    canvas = size * ss
    base = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(base)

    for layer in layers:
        color = _hex_to_rgb(layer["color"])
        if layer["kind"] == "rect":
            x0, y0 = layer["x"] * scale, layer["y"] * scale
            x1, y1 = (layer["x"] + layer["w"]) * scale, (layer["y"] + layer["h"]) * scale
            draw.rounded_rectangle([x0, y0, x1 - 1, y1 - 1], radius=layer["r"] * scale, fill=color)
        else:
            draw.polygon([(px * scale, py * scale) for px, py in layer["points"]], fill=color)

    return base.resize((size, size), Image.LANCZOS)


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        sys.stderr.write(__doc__)
        return 2

    svg_path, png_path = args[0], args[1]
    ico_path = args[2] if len(args) > 2 else None

    master = 1024
    if "--size" in argv:
        master = int(argv[argv.index("--size") + 1])

    with open(svg_path, "r", encoding="utf-8") as fh:
        width, layers = parse_svg(fh.read())

    render(width, layers, master).save(png_path, "PNG")
    print("  - PNG %dx%d" % (master, master))

    if ico_path:
        frames = [render(width, layers, s).convert("RGBA") for s in ICO_SIZES]
        frames[0].save(
            ico_path,
            format="ICO",
            sizes=[(s, s) for s in ICO_SIZES],
            append_images=frames[1:],
        )
        print("  - ICO " + ", ".join(str(s) for s in ICO_SIZES))

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
