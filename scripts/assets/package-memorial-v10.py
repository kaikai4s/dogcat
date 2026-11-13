"""Package generated poses, retaining native alpha and using one scale for both actions.

No generated in-between poses, limb replacement, recoloring or per-frame scaling.
Run from the repository root after the imagegen CLI requests have completed.
"""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path('output/imagegen/pet-memorial-v10')
DOCS = Path('docs/design/pet-memorial/characters-v10')
SOURCES = {'walk': ROOT / 'raw/walk-preserved.png', 'idle': ROOT / 'raw/idle-refined.png'}
DURATIONS = {'walk': 140, 'idle': 320}
FONT = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 16)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    frames = {}
    max_height = 0
    for action, path in SOURCES.items():
        source = Image.open(path).convert('RGBA')
        assert source.width % 4 == 0 and source.height % 2 == 0
        cw, ch = source.width // 4, source.height // 2
        records = []
        for i in range(8):
            box = (i % 4 * cw, i // 4 * ch, (i % 4 + 1) * cw, (i // 4 + 1) * ch)
            frame = source.crop(box)
            alpha = np.asarray(frame)[:, :, 3]
            assert np.any(alpha == 0), 'Source must have real alpha'
            bounds = Image.fromarray(np.where(alpha > 32, 255, 0).astype('uint8')).getbbox()
            assert bounds
            left, top, right, bottom = bounds
            max_height = max(max_height, (bottom - top) / ch)
            # Register the head horizontally instead of following the waving cape.
            head_band = alpha[top:top + round((bottom - top) * .22)] > 128
            head_x = float(np.where(head_band)[1].mean())
            records.append({'image': frame, 'box': box, 'bounds': bounds, 'head_x': head_x,
                            'cell_height': ch, 'source_edge_pixels': int((alpha[0] > 32).sum() + (alpha[-1] > 32).sum() + (alpha[:, 0] > 32).sum() + (alpha[:, -1] > 32).sum())})
        frames[action] = records
    # Same normalized source scale across actions; never normalize individual frames.
    normalized_scale = 195 / max_height
    manifest = {'version': '10.1', 'character': 'boy', 'direction': 'sw', 'frameCount': 8,
                'columns': 4, 'rows': 2, 'frameSize': [256, 256], 'anchor': [128, 230],
                'modelRequested': 'gpt-image-2.6-sunburst', 'generationMode': 'imagegen bundled CLI edit',
                'method': 'New complete model-generated poses; native alpha; shared normalized scale; whole-frame registration. Walk uses a stable head-height reference instead of each frame lowest boot.',
                'productionIntegrated': False, 'visualStatus': 'candidate-needs-user-review', 'actions': {}}
    (ROOT / 'cloud-upload').mkdir(exist_ok=True)
    all_frames = {}
    checks = {}
    for action, records in frames.items():
        folder = ROOT / 'frames' / action
        folder.mkdir(parents=True, exist_ok=True)
        atlas = Image.new('RGBA', (1024, 512))
        contact = Image.new('RGB', (1024, 576), '#293e36')
        preview_frames, raw_frames, checks[action] = [], [], []
        # A foot nearest to the camera has a different projected height from the
        # far support foot. Aligning every lowest sole made that change bob the
        # complete figure. Measure the head on identically scaled, unwarped frames
        # and remove only whole-frame vertical drift for walking.
        prepared = []
        for record in records:
            frame = record['image']
            scale = normalized_scale / record['cell_height']
            sprite = frame.resize((round(frame.width * scale), round(frame.height * scale)), Image.Resampling.LANCZOS)
            offset = (round(128 - record['head_x'] * scale), round(230 - record['bounds'][3] * scale))
            alpha = np.asarray(sprite)[:, :, 3]
            top = int(np.where(alpha > 128)[0].min())
            head_y = float(np.where(alpha[top:top+50] > 128)[0].mean()) + top
            prepared.append((sprite, scale, offset, head_y))
        target_head_y = float(np.median([offset[1] + hy for _, _, offset, hy in prepared]))
        for i, (record, prepared_frame) in enumerate(zip(records, prepared)):
            sprite, scale, offset, head_y = prepared_frame
            original_y = offset[1]
            if action == 'walk':
                offset = (offset[0], round(target_head_y - head_y))
            out = Image.new('RGBA', (256, 256))
            out.alpha_composite(sprite, offset)
            a = np.asarray(out)[:, :, 3]
            assert a[0].max() == 0 and a[-1].max() == 0 and a[:, 0].max() == 0 and a[:, -1].max() == 0, 'Clipped runtime frame'
            path = folder / f'{i+1:02d}.png'
            out.save(path)
            atlas.alpha_composite(out, (i % 4 * 256, i // 4 * 256))
            bg = Image.new('RGBA', (256, 256), '#293e36')
            d = ImageDraw.Draw(bg)
            d.line((28, 230, 228, 230), fill='#52715e', width=1)
            bg.alpha_composite(out)
            preview_frames.append(bg.convert('RGB'))
            raw_frames.append(out)
            contact.paste(bg.convert('RGB'), (i % 4 * 256, i // 4 * 288))
            ImageDraw.Draw(contact).text((i % 4 * 256 + 18, i // 4 * 288 + 258), f'{"行走" if action == "walk" else "待机"} · {i+1:02d}', font=FONT, fill='#eee7d6')
            checks[action].append({'frame': i+1, 'sourceBox': record['box'], 'sourceBounds': record['bounds'],
                                   'sourceEdgePixelsAbove32': record['source_edge_pixels'], 'scale': scale, 'translation': offset,
                                   'verticalCorrectionPx': offset[1] - original_y,
                                   'headCenterYBefore': head_y + original_y, 'headCenterYAfter': head_y + offset[1],
                                   'bounds': out.getbbox(), 'transparentPixels': int((a == 0).sum()), 'sha256': digest(path)})
        atlas.save(ROOT / 'cloud-upload' / f'{action}-sw.png')
        for i, out in enumerate(raw_frames):
            cell = atlas.crop((i % 4*256, i//4*256, (i%4+1)*256, (i//4+1)*256))
            assert np.array_equal(np.asarray(cell), np.asarray(out))
        contact.save(ROOT / f'{action}-contact.jpg', quality=94)
        preview_frames[0].save(ROOT / f'{action}.gif', save_all=True, append_images=preview_frames[1:], duration=DURATIONS[action], loop=0, disposal=2)
        manifest['actions'][action] = {'path': f'cloud-upload/{action}-sw.png', 'durationMs': DURATIONS[action],
                                      'cycleMs': DURATIONS[action]*8, 'source': str(SOURCES[action].relative_to(ROOT)), 'sourceSha256': digest(SOURCES[action])}
        all_frames[action] = raw_frames
    # Actual supplied garden, with a transparent sprite at a ground anchor.
    garden_path = ROOT / 'reference/garden.png'
    if not garden_path.exists():
        garden_path = Path('docs/design/pet-memorial/source/garden-background-reference.png')
    garden = Image.open(garden_path).convert('RGB')
    manifest['gardenSourceSha256'] = digest(garden_path)
    garden.resize((1600, 900), Image.Resampling.LANCZOS).save(ROOT / 'garden.jpg', quality=92)
    scene = garden.resize((1200, 675), Image.Resampling.LANCZOS).convert('RGBA')
    character = all_frames['idle'][0].resize((150, 150), Image.Resampling.LANCZOS)
    scene.alpha_composite(character, (660 - 75, 465 - round(230*150/256)))
    scene.convert('RGB').save(ROOT / 'garden-preview.jpg', quality=95)
    # Side-by-side loops show the real eight frames, without interpolated body poses.
    comparison = []
    for tick in range(64):
        bg = Image.new('RGBA', (640, 360), '#23372f')
        draw = ImageDraw.Draw(bg)
        draw.text((40, 22), '行走 · 左右脚交替', font=FONT, fill='#e8dcc3')
        draw.text((360, 22), '待机 · 呼吸与披风', font=FONT, fill='#e8dcc3')
        bg.alpha_composite(all_frames['walk'][(tick*80//140) % 8], (32, 65))
        bg.alpha_composite(all_frames['idle'][(tick*80//320) % 8], (352, 65))
        comparison.append(bg.convert('RGB'))
    comparison[0].save(ROOT / 'actions-preview.gif', save_all=True, append_images=comparison[1:], duration=80, loop=0, disposal=2)
    before_path = ROOT / 'comparison/walk-before.png'
    if before_path.exists():
        before = Image.open(before_path).convert('RGBA')
        comparison = []
        for i in range(8):
            bg = Image.new('RGBA', (640, 350), '#23372f')
            draw = ImageDraw.Draw(bg)
            draw.text((40, 20), '修正前 · 按最低鞋底对齐', font=FONT, fill='#e8dcc3')
            draw.text((350, 20), '修正后 · 稳定躯干高度', font=FONT, fill='#e8dcc3')
            old = before.crop((i % 4*256, i//4*256, (i%4+1)*256, (i//4+1)*256))
            bg.alpha_composite(old, (32, 65))
            bg.alpha_composite(all_frames['walk'][i], (352, 65))
            comparison.append(bg.convert('RGB'))
        comparison[0].save(ROOT / 'walk-stability-comparison.gif', save_all=True, append_images=comparison[1:], duration=140, loop=0, disposal=2)
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (ROOT / 'verification.json').write_text(json.dumps({'transparentBorders': True, 'atlasMatchesFrames': True, 'noSyntheticFrames': True, 'frames': checks}, ensure_ascii=False, indent=2), encoding='utf-8')
    shutil.copy2(DOCS / 'preview.html', ROOT / 'preview.html')
    shutil.copytree(DOCS / 'prompts', ROOT / 'prompts', dirs_exist_ok=True)
    if (DOCS / 'README.md').exists():
        shutil.copy2(DOCS / 'README.md', ROOT / 'README.md')
    with zipfile.ZipFile(ROOT / 'boy-sw-actions-v10.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(ROOT.rglob('*')):
            if file.is_file() and file.suffix != '.zip' and 'raw' not in file.relative_to(ROOT).parts:
                archive.write(file, file.relative_to(ROOT))
    print(json.dumps({'output': str(ROOT), 'frameCountPerAction': 8, 'sharedNormalizedScale': normalized_scale,
                      'sourceEdgePixels': {a: [r['source_edge_pixels'] for r in records] for a, records in frames.items()}}, indent=2))


if __name__ == '__main__':
    main()
