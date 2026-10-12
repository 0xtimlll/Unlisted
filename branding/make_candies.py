#!/usr/bin/env python3
"""Генератор логотипов-конфет (стиль BiM BOM). Текст переводится в контуры — SVG не зависит от шрифтов.
python3 make_candies.py  ->  candy/<slug>.svg"""
import colorsys, random, sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

FONT = TTFont('/usr/share/fonts/opentype/inter/Inter-Black.otf')
GS, CMAP, UPM = FONT.getGlyphSet(), FONT.getBestCmap(), FONT['head'].unitsPerEm
OUT = Path(__file__).parent / 'candy'
INK = '#1b1033'      # тёмная обводка букв
YELLOW = '#ffd21f'

def shade(hexc, l=0.0, s=0.0):
    r, g, b = [int(hexc[i:i+2], 16)/255 for i in (1, 3, 5)]
    h, li, sa = colorsys.rgb_to_hls(r, g, b)
    li = min(1, max(0, li + l)); sa = min(1, max(0, sa + s))
    r, g, b = colorsys.hls_to_rgb(h, li, sa)
    return '#%02x%02x%02x' % (round(r*255), round(g*255), round(b*255))

def line_paths(text, size, seed):
    """Буквы по одной, с лёгким скачком по высоте и наклоном, как на оригинале."""
    rnd = random.Random(seed)
    sc, x, items = size / UPM, 0.0, []
    for ch in text:
        gn = CMAP[ord(ch)]
        adv = GS[gn].width * sc * 0.93
        pen = SVGPathPen(GS)
        GS[gn].draw(TransformPen(pen, (sc, 0, 0, -sc, 0, 0)))
        items.append((pen.getCommands(), x, adv, rnd.uniform(-5, 5), rnd.uniform(-0.05, 0.05) * size))
        x += adv
    return items, x

def text_line(text, cy, fill, max_w, max_size, seed):
    size = max_size
    items, w = line_paths(text, size, seed)
    if w > max_w:
        size *= max_w / w
        items, w = line_paths(text, size, seed)
    x0, cap = 512 - w / 2, size * 0.73
    g = []
    for d, x, adv, rot, dy in items:
        t = f'translate({x0+x:.1f} {cy+cap/2+dy:.1f}) rotate({rot:.1f} {adv/2:.1f} {-cap/2:.1f})'
        g.append(f'<path transform="{t}" d="{d}" fill="{fill}" stroke="{INK}" stroke-width="{size*0.2:.1f}" stroke-linejoin="round" paint-order="stroke"/>')
    return '\n'.join(g)

def wing(base):
    hi, lo, dk = shade(base, .12), shade(base, -.10), shade(base, -.22)
    folds = ''.join(
        f'<path d="M742 512 C800 {512+k*.35} 860 {512+k} 905 {512+k*1.15}" stroke="{c}" stroke-width="{w}" fill="none" stroke-linecap="round" opacity="{o}"/>'
        for k, c, w, o in [(-190, hi, 9, .8), (-120, dk, 7, .55), (-45, hi, 10, .7), (50, dk, 8, .6), (125, hi, 9, .65), (200, dk, 7, .5)])
    return (f'<path d="M730 478 C790 455 850 380 915 292 C945 330 925 380 940 430 C925 480 950 540 935 590 '
            f'C950 640 930 690 905 735 C850 650 790 575 730 546 Z" fill="url(#wg)" stroke="{dk}" stroke-width="3" stroke-linejoin="round"/>' + folds)

def candy(slug, base, l1, l2, c1='#ffffff', c2=YELLOW, seed=1):
    hi, lo, dk = shade(base, .20), shade(base, -.12), shade(base, -.26)
    two = l2 is not None
    t = text_line(l1, 478 if two else 512, c1 if two else c2, 390, 165 if two else 200, seed)
    if two: t += '\n' + text_line(l2, 612, c2, 390, 165, seed + 7)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
<radialGradient id="bg" cx="36%" cy="30%" r="80%"><stop offset="0" stop-color="{hi}"/><stop offset=".45" stop-color="{base}"/><stop offset="1" stop-color="{dk}"/></radialGradient>
<linearGradient id="wg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{base}"/><stop offset="1" stop-color="{lo}"/></linearGradient>
<filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="26" stdDeviation="22" flood-color="#000" flood-opacity=".22"/></filter>
</defs>
<g filter="url(#sh)" transform="rotate(-24 512 512) translate(512 512) scale(.93) translate(-512 -512)">
<g>{wing(base)}</g>
<g transform="translate(1024 0) scale(-1 1)">{wing(base)}</g>
<circle cx="512" cy="512" r="238" fill="url(#bg)"/>
<path d="M330 400 C350 330 420 290 500 290" stroke="#fff" stroke-width="26" fill="none" stroke-linecap="round" opacity=".55"/>
<ellipse cx="640" cy="690" rx="70" ry="22" transform="rotate(-35 640 690)" fill="#fff" opacity=".12"/>
<g transform="rotate(9 512 512)">{t}</g>
</g></svg>'''

CANDIES = [
    # slug,        цвет конфеты, строка 1, строка 2, цвет 1, цвет 2
    ('unlisted',   '#15131c', 'UN',    'LISTED', '#ffffff', YELLOW),
    ('arbitrage',  '#7b3df0', 'ARBI',  'TRAGE',  '#ffffff', YELLOW),
    ('spread',     '#ff7a1a', 'SPREAD', None,    '#ffffff', '#ffffff'),
    ('ntt',        '#13b8a6', 'NTT',   None,     '#ffffff', '#ffffff'),
]
OUT.mkdir(exist_ok=True)
for i, (slug, col, a, b, c1, c2) in enumerate(CANDIES):
    (OUT / f'{slug}.svg').write_text(candy(slug, col, a, b, c1, c2, seed=i + 3))
    print(slug)
