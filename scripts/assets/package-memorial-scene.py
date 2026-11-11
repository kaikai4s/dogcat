"""Build small, local mini-program assets from the approved v12 candidate bundle.

No frame realignment or synthetic animation: resize the entire registered atlas.
Run from any directory; originals stay outside the mini-program package.
"""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=ROOT / 'output/imagegen/pet-memorial-v12')
    args = parser.parse_args()
    target = ROOT / 'miniprogram/packageMemorial/assets'
    target.mkdir(parents=True, exist_ok=True)
    manifest = {'version': 'garden-v1', 'columns': 4, 'rows': 2, 'frames': 8,
                'cell': 128, 'anchor': [64, 115], 'sources': {}}
    for gender, folder in [('girl', args.source), ('boy', args.source / 'boy')]:
        (target / gender).mkdir(exist_ok=True)
        for action in ['walk', 'idle']:
            for direction in ['sw', 'se', 'nw', 'ne']:
                name = f'{action}-{direction}.png'
                source = folder / 'cloud-upload' / name
                original = Image.open(source).convert('RGBA')
                assert original.size == (1024, 512), source
                compact = original.resize((512, 256), Image.Resampling.LANCZOS)
                compact = compact.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
                path = target / gender / name
                compact.save(path, optimize=True)
                decoded = Image.open(path).convert('RGBA')
                for n in range(8):
                    frame = decoded.crop(((n % 4) * 128, (n // 4) * 128,
                                          (n % 4 + 1) * 128, (n // 4 + 1) * 128))
                    box = frame.getbbox()
                    assert box and box[0] > 0 and box[1] > 0 and box[2] < 128 and box[3] < 128, (source, n, box)
                manifest['sources'][f'{gender}/{name}'] = {
                    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                    'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}
    Image.open(args.source / 'garden.jpg').convert('RGB').save(target / 'garden.jpg', quality=86, optimize=True)
    manifest['assetBytes'] = sum(p.stat().st_size for p in target.rglob('*') if p.is_file() and p.name != 'manifest.json')
    assert manifest['assetBytes'] < 1800000, 'Leave room for scene code under the 2 MB subpackage limit'
    (target / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"Built 16 transparent atlases + garden: {manifest['assetBytes']:,} bytes")


if __name__ == '__main__':
    main()
