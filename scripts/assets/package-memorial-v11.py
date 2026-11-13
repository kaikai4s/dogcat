"""Package four independently rendered directional animations; no pose synthesis."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path('output/imagegen/pet-memorial-v11')
OLD = Path('output/imagegen/pet-memorial-v10')
DOCS = Path('docs/design/pet-memorial/characters-v11')
DIRECTIONS = {'sw': '左前方 ↙', 'se': '右前方 ↘', 'nw': '左后方 ↖', 'ne': '右后方 ↗'}
DURATIONS = {'walk': 140, 'idle': 320}
FONT = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 17)
SCALE = json.loads((OLD / 'verification.json').read_text(encoding='utf-8'))['frames']['walk'][0]['scale'] * 416


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    (ROOT / 'cloud-upload').mkdir(exist_ok=True)
    clips, report, animations = {}, {}, {}
    for direction, label in DIRECTIONS.items():
        for action, duration in DURATIONS.items():
            key = f'{action}-{direction}'
            folder = ROOT / 'frames' / direction / action
            folder.mkdir(parents=True, exist_ok=True)
            checks = []
            if direction == 'sw':
                source = OLD / 'cloud-upload' / f'{action}-sw.png'
                frames = [Image.open(OLD / 'frames' / action / f'{i+1:02d}.png').convert('RGBA') for i in range(8)]
                origin = 'Copied unchanged from v10.1 stabilized runtime frames'
            else:
                suffix = '-final' if key in ('walk-nw', 'idle-se') else '-refined' if action == 'walk' else ''
                source = ROOT / 'raw' / f'{key}{suffix}.png'
                sheet = Image.open(source).convert('RGBA')
                assert sheet.width % 4 == 0 and sheet.height % 2 == 0
                cw, ch = sheet.width // 4, sheet.height // 2
                scale = SCALE / ch
                prepared = []
                for i in range(8):
                    box = (i % 4*cw, i//4*ch, (i%4+1)*cw, (i//4+1)*ch)
                    cell = sheet.crop(box)
                    alpha = np.asarray(cell)[:, :, 3]
                    assert np.any(alpha == 0)
                    bounds = Image.fromarray(np.where(alpha > 32, 255, 0).astype('uint8')).getbbox()
                    assert bounds
                    edge_count = int((alpha[0] > 32).sum() + (alpha[-1] > 32).sum() + (alpha[:, 0] > 32).sum() + (alpha[:, -1] > 32).sum())
                    assert edge_count == 0, f'{key} frame {i+1}: source content touches crop boundary'
                    top = bounds[1]
                    hx = float(np.where(alpha[top:top+round((bounds[3]-top)*.22)] > 128)[1].mean())
                    sprite = cell.resize((round(cw*scale), round(ch*scale)), Image.Resampling.LANCZOS)
                    a = np.asarray(sprite)[:, :, 3]
                    top = int(np.where(a > 128)[0].min())
                    hy = float(np.where(a[top:top+50] > 128)[0].mean()) + top
                    offset = (round(128-hx*scale), round(230-bounds[3]*scale))
                    prepared.append((sprite, offset, hy, box))
                target = float(np.median([offset[1]+hy for _, offset, hy, _ in prepared]))
                frames = []
                for i, (sprite, offset, hy, box) in enumerate(prepared):
                    before = offset[1]+hy
                    if action == 'walk':
                        offset = (offset[0], round(target-hy))
                    out = Image.new('RGBA', (256, 256))
                    out.alpha_composite(sprite, offset)
                    frames.append(out)
                    checks.append({'frame': i+1, 'sourceBox': box, 'scale': scale, 'translation': offset,
                                   'headYBefore': before, 'headYAfter': offset[1]+hy})
                origin = 'Complete model-generated frames, native alpha, shared scale and whole-frame registration only'
            atlas = Image.new('RGBA', (1024, 512))
            contact = Image.new('RGB', (1024, 568), '#293e36')
            gif = []
            for i, frame in enumerate(frames):
                a = np.asarray(frame)[:, :, 3]
                assert a[0].max() == 0 and a[-1].max() == 0 and a[:, 0].max() == 0 and a[:, -1].max() == 0
                assert np.any(a == 255) and np.any(a == 0)
                frame.save(folder / f'{i+1:02d}.png')
                atlas.alpha_composite(frame, (i%4*256, i//4*256))
                bg = Image.new('RGBA', (256, 256), '#293e36')
                bg.alpha_composite(frame)
                gif.append(bg.convert('RGB'))
                contact.paste(bg.convert('RGB'), (i%4*256, i//4*284))
                ImageDraw.Draw(contact).text((i%4*256+12, i//4*284+257), f'{label} · {i+1:02d}', font=FONT, fill='#eee4ce')
            atlas_path = ROOT / 'cloud-upload' / f'{key}.png'
            atlas.save(atlas_path)
            stored = Image.open(atlas_path).convert('RGBA')
            for i, frame in enumerate(frames):
                assert np.array_equal(np.asarray(frame), np.asarray(stored.crop((i%4*256, i//4*256, (i%4+1)*256, (i//4+1)*256))))
            assert len({hashlib.sha256(f.tobytes()).hexdigest() for f in frames}) == 8, 'Repeated identical frames'
            contact.save(ROOT / f'{key}-contact.jpg', quality=94)
            gif[0].save(ROOT / f'{key}.gif', save_all=True, append_images=gif[1:], duration=duration, loop=0, disposal=2)
            animations[key] = frames
            clips[key] = {'path': f'cloud-upload/{key}.png', 'frameCount': 8, 'columns': 4, 'rows': 2,
                          'frameSize': [256, 256], 'anchor': [128, 230], 'durationMs': duration,
                          'source': str(source), 'sourceSha256': sha(source), 'atlasSha256': sha(atlas_path), 'method': origin}
            report[key] = {'transparentBorders': True, 'atlasMatchesFrames': True, 'uniqueFrames': 8, 'frames': checks}
            if checks:
                report[key]['headYRange'] = max(r['headYAfter'] for r in checks)-min(r['headYAfter'] for r in checks)
                if action == 'walk':
                    assert report[key]['headYRange'] < 1.01
    overview = []
    for tick in range(64):
        img = Image.new('RGBA', (1024, 580), '#23372f')
        draw = ImageDraw.Draw(img)
        for c, (direction, label) in enumerate(DIRECTIONS.items()):
            for r, action in enumerate(DURATIONS):
                f = tick*80//DURATIONS[action] % 8
                draw.text((c*256+16, r*290+10), f'{label} · {"行走" if action == "walk" else "待机"}', font=FONT, fill='#eee4ce')
                img.alpha_composite(animations[f'{action}-{direction}'][f], (c*256, r*290+28))
        overview.append(img.convert('RGB'))
    overview[0].save(ROOT / 'four-directions.gif', save_all=True, append_images=overview[1:], duration=80, loop=0, disposal=2)
    overview[0].save(ROOT / 'four-directions.jpg', quality=95)
    manifest = {'version': 11, 'character': 'boy', 'directions': DIRECTIONS, 'clips': clips,
                'totalFrames': 64, 'modelRequested': 'gpt-image-2.6-sunburst',
                'generationMode': 'imagegen bundled CLI edit', 'productionIntegrated': False,
                'visualStatus': 'candidate-needs-user-review',
                'referenceMirroring': 'Mirrored guides used for right-facing pose/direction only; final new sheets re-rendered by model. Costume asymmetry needs review.'}
    (ROOT/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (ROOT/'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    shutil.copy2(OLD/'garden.jpg', ROOT/'garden.jpg')
    for name in ['preview.html', 'README.md']:
        if (DOCS/name).exists(): shutil.copy2(DOCS/name, ROOT/name)
    shutil.copytree(DOCS/'prompts', ROOT/'prompts', dirs_exist_ok=True)
    with zipfile.ZipFile(ROOT/'boy-four-directions-v11.zip', 'w', zipfile.ZIP_DEFLATED) as z:
        for f in sorted(ROOT.rglob('*')):
            if f.is_file() and f.suffix != '.zip' and not {'raw','reference'}.intersection(f.relative_to(ROOT).parts):
                z.write(f, f.relative_to(ROOT))
    print(json.dumps({'clips': len(clips), 'frames': 64, 'headYRanges': {k: round(v.get('headYRange', 0), 3) for k,v in report.items()}}, indent=2))


if __name__ == '__main__':
    main()
