"""Derive aligned seasonal foliage from the existing garden artwork.

No new silhouettes, pivots or collision shapes. Alpha is copied byte-for-byte.
The runtime atlas is tree/shrub columns and spring/summer/autumn/winter rows.
"""
from pathlib import Path
import colorsys
import hashlib
import json
import math
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'miniprogram/packageMemorial/assets/world-v2/props.png'
OUT = ROOT / 'miniprogram/packageMemorial/assets/seasons-v1'
REPORT = ROOT / 'docs/design/pet-memorial/seasons'
OUT.mkdir(parents=True, exist_ok=True)
REPORT.mkdir(parents=True, exist_ok=True)
source = Image.open(SOURCE).convert('RGBA')
atlas = Image.new('RGBA', (512, 1024))
seasons = ['spring', 'summer', 'autumn', 'winter']
for row, season in enumerate(seasons):
    for col in range(2):
        original = source.crop((col * 256, 0, col * 256 + 256, 256))
        art = original.copy()
        pixels = art.load()
        for y in range(256):
            for x in range(256):
                r, g, b, a = pixels[x, y]
                h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                if not a or season == 'summer' or not (.12 < h < .46 and s > .20 and g > r * .90):
                    continue
                patch = (math.sin(x * .09 + y * .04) + math.sin(y * .11 - x * .05)) / 2
                if season == 'spring':
                    color = colorsys.hsv_to_rgb(.24, s * .75, min(1, v * 1.08))
                    if patch > .08 and v > .32:
                        light = .35 + v * .65
                        blossom = (light, light * .78, light * .84)
                        strength = min(.88, (patch - .08) * 1.7)
                        color = tuple(c * (1 - strength) + d * strength for c, d in zip(color, blossom))
                elif season == 'autumn':
                    color = colorsys.hsv_to_rgb(.075 + patch * .025, min(.86, s * 1.08), min(1, v * 1.18))
                else:
                    color = colorsys.hsv_to_rgb(.32, s * .28, v * .85)
                    frost = min(.88, max(0, (v - .27) * 1.9 + patch * .18))
                    color = tuple(c * (1 - frost) + d * frost for c, d in zip(color, (.87, .92, .90)))
                pixels[x, y] = (*[round(c * 255) for c in color], a)
        assert art.getchannel('A').tobytes() == original.getchannel('A').tobytes()
        atlas.paste(art, (col * 256, row * 256))
atlas.save(OUT / 'foliage.png', optimize=True)
sheet = Image.new('RGB', (1024, 320), '#e9edde')
draw = ImageDraw.Draw(sheet)
for row, season in enumerate(seasons):
    for col in range(2):
        art = atlas.crop((col * 256, row * 256, col * 256 + 256, row * 256 + 256))
        art.thumbnail((200 if col == 0 else 100, 245 if col == 0 else 100))
        sheet.paste(art, (row * 256 + (16 if col == 0 else 140), 28 if col == 0 else 200), art)
    draw.text((row * 256 + 20, 8), season.upper(), fill='#304539')
sheet.save(REPORT / 'contact-sheet.png')
manifest = {
    'source': 'miniprogram/packageMemorial/assets/world-v2/props.png',
    'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    'method': 'Deterministic color and frost treatment of project-owned existing art; no new AI generation.',
    'rights': 'Same provenance and usage restrictions as source garden artwork.',
    'file': 'seasons-v1/foliage.png', 'size': [512, 1024], 'cell': [256, 256],
    'rows': seasons, 'columns': ['tree', 'shrub'], 'anchor': [0.5, 0.84],
    'alphaMatchesSource': True, 'collision': 'Existing tree/shrub footprints; cosmetic only.',
    'bytes': (OUT / 'foliage.png').stat().st_size,
    'sha256': hashlib.sha256((OUT / 'foliage.png').read_bytes()).hexdigest()
}
(REPORT / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'atlas': str(OUT / 'foliage.png'), 'bytes': manifest['bytes'], 'alphaMatchesSource': True}))
