"""Package supplied front sprites and API-generated rear sprites; never calls an API."""
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/imagegen/playground-four-directions'
DIRECTIONS = ['sw', 'se', 'nw', 'ne']
ACTIONS = ['idle', 'walk', 'run']


def key_green(im):
    data = np.asarray(im.convert('RGBA')).copy()
    rgb = data[:, :, :3].astype(float)
    excess = rgb[:, :, 1] - np.maximum(rgb[:, :, 0], rgb[:, :, 2])
    alpha = np.clip((120 - excess) / 80, 0, 1)
    # Despill only chroma edges; preserve the original skin, brown hair and blue clothes.
    edge = excess > 25
    rgb[:, :, 1][edge] = np.maximum(rgb[:, :, 0], rgb[:, :, 2])[edge]
    data[:, :, :3] = np.clip(rgb, 0, 255).astype('uint8')
    data[:, :, 3] = (data[:, :, 3] * alpha).astype('uint8')
    data[data[:, :, 3] == 0, :3] = 0
    return Image.fromarray(data, 'RGBA')


def bounds(im):
    return im.getchannel('A').point(lambda x: 255 if x > 32 else 0).getbbox()


def head(im):
    x0, y0, x1, y1 = bounds(im)
    box = bounds(im.crop((0, y0, im.width, y0 + round((y1-y0)*.30))))
    return (box[0]+box[2])/2, y0, box[2]-box[0]


def normalize(person, action):
    source = key_green(Image.open(OUT / 'raw' / f'{person}-{action}-nw.png'))
    reference = Image.open(OUT / 'references' / person / 'idle-sw.png').convert('RGBA')
    if action == 'idle':
        box = bounds(source)
        fg = source.crop(box)
        scale = 430 / fg.height
        fg = fg.resize((round(fg.width*scale), 430), Image.Resampling.LANCZOS)
        result = Image.new('RGBA', (512, 512))
        result.alpha_composite(fg, (256-fg.width//2, 30))
        return [result]
    assert source.width % 4 == 0 and source.height % 3 == 0
    w, h = source.width//4, source.height//3
    cells = [source.crop((i%4*w, i//4*h, (i%4+1)*w, (i//4+1)*h)) for i in range(12)]
    reference = Image.open(OUT / 'references' / person / f'{action}-sw.png').convert('RGBA').crop((0, 0, 256, 256))
    # One scale for the entire animation preserves body volume and bent-leg poses.
    _, ref_top, ref_width = head(reference)
    scale = ref_width / float(np.median([head(cell)[2] for cell in cells]))
    scale = min(scale, 216 / max(bounds(cell)[3]-bounds(cell)[1] for cell in cells))
    tops = [head(cell)[1] for cell in cells]
    median_top = float(np.median(tops))
    frames = []
    for cell in cells:
        cx, top, _ = head(cell)
        box = bounds(cell)
        fg = cell.crop(box)
        fg = fg.resize((round(fg.width*scale), round(fg.height*scale)), Image.Resampling.LANCZOS)
        x = round(128 + (box[0]-cx)*scale)
        y = round(ref_top + np.clip((top-median_top)*scale, -2, 2))
        frame = Image.new('RGBA', (256, 256))
        frame.alpha_composite(fg, (x, y))
        frames.append(frame)
    return frames


def split(im, action):
    if action == 'idle':
        return [im]
    return [im.crop((i%4*256, i//4*256, (i%4+1)*256, (i//4+1)*256)) for i in range(12)]


def main():
    atlas_dir = OUT / 'cloud-upload'
    manifest = {'status': 'candidate assets; not uploaded or deployed',
                'modelRequested': 'gpt-image-2', 'generationMode': 'imagegen CLI edit via user-configured API',
                'directions': {'sw': '左前', 'se': '右前', 'nw': '左后', 'ne': '右后'},
                'method': 'SW original files; NW generated using SW identity/action references; SE/NE mirrored per frame from SW/NW. Chroma-keyed and registered locally.',
                'style': {'idleSize': [512, 512], 'atlasSize': [1024, 768], 'columns': 4, 'rows': 3, 'frames': 12, 'anchor': [0.5, 460/512]},
                'assets': []}
    all_frames = {}
    for person in ['boy', 'girl']:
        (atlas_dir / person).mkdir(parents=True, exist_ok=True)
        for action in ACTIONS:
            original = Image.open(OUT / 'references' / person / f'{action}-sw.png').convert('RGBA')
            left = {'sw': split(original, action), 'nw': normalize(person, action)}
            for direction in DIRECTIONS:
                frames = left[direction] if direction in left else [ImageOps.mirror(f) for f in left['sw' if direction == 'se' else 'nw']]
                size = 512 if action == 'idle' else 256
                atlas = Image.new('RGBA', (512, 512) if action == 'idle' else (1024, 768))
                frame_dir = OUT / 'frames' / person / f'{action}-{direction}'
                frame_dir.mkdir(parents=True, exist_ok=True)
                checks = []
                for i, frame in enumerate(frames):
                    box = bounds(frame)
                    assert box and box[0] > 1 and box[1] > 1 and box[2] < size-1 and box[3] < size-1, (person, action, direction, i, box)
                    assert frame.getchannel('A').getextrema() == (0, 255)
                    frame.save(frame_dir / f'{i+1:02}.png', optimize=True)
                    atlas.alpha_composite(frame, (0, 0) if action == 'idle' else (i%4*size, i//4*size))
                    checks.append({'frame': i+1, 'bounds': box, 'hash': hashlib.sha256(frame.tobytes()).hexdigest()})
                dest = atlas_dir / person / f'{action}-{direction}.png'
                if direction == 'sw':
                    shutil.copyfile(OUT / 'references' / person / f'{action}-sw.png', dest)
                else:
                    atlas.save(dest, optimize=True)
                assert len({c['hash'] for c in checks}) == len(frames)
                reloaded = Image.open(dest).convert('RGBA')
                for a,b in zip(frames, split(reloaded, action)):
                    assert np.array_equal(np.asarray(a),np.asarray(b))
                all_frames[(person, action, direction)] = frames
                manifest['assets'].append({'character': person, 'action': action, 'direction': direction,
                    'file': str(dest.relative_to(OUT)), 'size': list(atlas.size), 'frames': len(frames),
                    'fps': 1 if action == 'idle' else 12 if action == 'walk' else 18,
                    'sha256': hashlib.sha256(dest.read_bytes()).hexdigest(), 'verification': checks})
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    # Contact sheet and animated review at the game's native character scale.
    for person in ['boy', 'girl']:
        preview = []
        for t in range(12):
            bg = Image.new('RGB', (768, 750), '#e7eee2')
            draw = ImageDraw.Draw(bg)
            for row, action in enumerate(ACTIONS):
                for col, direction in enumerate(DIRECTIONS):
                    frames = all_frames[person, action, direction]
                    fg = frames[t%len(frames)].resize((192, 192), Image.Resampling.LANCZOS)
                    x,y=col*192,row*250+30
                    bg.paste(fg,(x,y),fg)
                    draw.text((x+12,y-16), f'{person} {action} {direction}', fill='#253426')
            preview.append(bg)
        preview[0].save(OUT / f'{person}-overview.jpg', quality=94)
        preview[0].save(OUT / f'{person}-preview.gif', save_all=True, append_images=preview[1:], duration=90, loop=0)
    archive = OUT / 'playground-four-directions.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for folder in ['cloud-upload', 'frames', 'prompts']:
            for p in sorted((OUT / folder).rglob('*')):
                if p.is_file():
                    z.write(p, p.relative_to(OUT))
        for name in ['manifest.json', 'source-manifest.json', 'README.md', 'preview.html', 'boy-preview.gif', 'girl-preview.gif', 'boy-overview.jpg', 'girl-overview.jpg']:
            if (OUT/name).exists():
                z.write(OUT/name,name)
    print(json.dumps({'atlases': len(manifest['assets']), 'frames': sum(a['frames'] for a in manifest['assets']), 'archive': str(archive)},ensure_ascii=False))


if __name__ == '__main__':
    main()
