"""Normalize orthographic props; preserve generated alpha; build a uniform ground tile."""
from pathlib import Path
from PIL import Image, ImageOps, ImageEnhance
import json
import hashlib

ROOT = Path(__file__).resolve().parents[2]
out = ROOT / 'miniprogram/packageMemorial/assets/world-v2'
out.mkdir(parents=True, exist_ok=True)
source = ROOT / 'output/imagegen/memorial-orthographic-v2/props-source.png'
image = Image.open(source).convert('RGBA')
assert image.width % 3 == 0 and image.height % 2 == 0
atlas = Image.new('RGBA', (768, 512))
records = {}
for i, kind in enumerate(['tree', 'shrub', 'fountain', 'gazebo', 'cottage', 'memorial']):
    w, h = image.width // 3, image.height // 2
    cell = image.crop((i % 3 * w, i // 3 * h, (i % 3 + 1) * w, (i // 3 + 1) * h))
    box = cell.getbbox()
    assert box, kind
    prop = cell.crop(box)
    prop.thumbnail((240, 240), Image.Resampling.LANCZOS)
    atlas.alpha_composite(prop, (i % 3 * 256 + (256 - prop.width) // 2, i // 3 * 256 + 248 - prop.height))
    records[kind] = {'sourceBox': list(box), 'index': i}
atlas.save(out / 'props.png', optimize=True)
# Uniform orthographic grass, downsampled and mirrored for matching tile edges.
grass_source = ROOT / 'output/imagegen/memorial-orthographic-v2/grass-source.png'
ground = Image.open(grass_source).convert('RGB').resize((128, 128), Image.Resampling.LANCZOS)
ground = ImageEnhance.Color(ground).enhance(.48)
tile = Image.new('RGB', (256, 256))
tile.paste(ground, (0, 0)); tile.paste(ImageOps.mirror(ground), (128, 0))
tile.paste(ImageOps.flip(ground), (0, 128)); tile.paste(ImageOps.flip(ImageOps.mirror(ground)), (128, 128))
tile.save(out / 'grass.jpg', quality=90, optimize=True)
(out / 'art-provenance.json').write_text(json.dumps({'propsSourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'props': records, 'grassSourceSha256': hashlib.sha256(grass_source.read_bytes()).hexdigest(),
    'grassMethod': 'uniform generated orthographic texture, downsampled, desaturated and mirrored',
    'prompt': 'docs/design/pet-memorial/orthographic-props-prompt.txt'}, indent=2) + '\n', encoding='utf-8')
print('Packed alpha props atlas 768x512 and seamless grass tile 256x256')
