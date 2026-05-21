"""
Generează icon-ul Dropwise (.ico) — logo-ul site-ului: frunza pe disc verde.
Rulare: py -3.12 make_icon.py
Rezultat: static/favicon.ico (multi-rezoluţie, pentru favicon + .exe)

svglib nu suportă gradiente, aşa că:
  1. desenăm discul cu gradient în Pillow,
  2. randăm DOAR frunza din SVG (svglib),
  3. compunem frunza peste disc.
"""

import io
import tempfile
from pathlib import Path

from svglib.svglib import svg2rlg
from reportlab.graphics import renderPM
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
ICO  = HERE / "static" / "favicon.ico"

S = 1024
LEAF_DARK = (74, 140, 95)    # --color-leaf
LEAF_HI   = (125, 201, 154)  # --color-leaf-bright

# ---- 1. Discul cu gradient diagonal (leaf -> leaf-bright) ----
disc = Image.new("RGBA", (S, S), (0, 0, 0, 0))
grad = Image.new("RGBA", (S, S), (0, 0, 0, 255))
gd = ImageDraw.Draw(grad)
for y in range(S):
    for x in range(0, S, 4):
        t = (x + y) / (2 * S)
        r = int(LEAF_DARK[0] + (LEAF_HI[0] - LEAF_DARK[0]) * t)
        g = int(LEAF_DARK[1] + (LEAF_HI[1] - LEAF_DARK[1]) * t)
        b = int(LEAF_DARK[2] + (LEAF_HI[2] - LEAF_DARK[2]) * t)
        gd.line([(x, y), (x + 3, y)], fill=(r, g, b, 255))

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).ellipse([0, 0, S - 1, S - 1], fill=255)
disc.paste(grad, (0, 0), mask)

# ---- 2. Randăm DOAR frunza dintr-un SVG temporar fără disc ----
leaf_svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <g transform="translate(6.4 6.4) scale(2.13)" fill="none"
     stroke="#b8f0c9" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 20A7 7 0 0 1 4 13L4 5C4 4.4 4.4 4 5 4L13 4A7 7 0 0 1 20 11C20 16 16 20 11 20Z"/>
    <path d="M4 4 L20 20"/>
  </g>
</svg>"""

with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False,
                                 encoding="utf-8") as tf:
    tf.write(leaf_svg)
    tmp_path = tf.name

drawing = svg2rlg(tmp_path)
scale = S / drawing.width
drawing.scale(scale, scale)
drawing.width  *= scale
drawing.height *= scale
png = renderPM.drawToString(drawing, fmt="PNG", bg=0x000000)
leaf = Image.open(io.BytesIO(png)).convert("RGBA")

# renderPM dă fundal negru — îl facem transparent (frunza e mentă deschisă).
leaf_data = []
for r, g, b, a in leaf.getdata():
    leaf_data.append((r, g, b, 0) if (r < 12 and g < 12 and b < 12)
                      else (r, g, b, 255))
leaf.putdata(leaf_data)

# ---- 3. Compunem frunza peste disc ----
icon = Image.alpha_composite(disc, leaf)

sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
icon.save(ICO, format="ICO", sizes=sizes)
print("Scris:", ICO)

icon.resize((256, 256), Image.LANCZOS).save(HERE / "static" / "favicon_preview.png")
print("Previzualizare: static/favicon_preview.png")

Path(tmp_path).unlink(missing_ok=True)
