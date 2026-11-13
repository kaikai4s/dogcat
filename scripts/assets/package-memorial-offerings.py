#!/usr/bin/env python3
"""Extract API-generated offering art; keep eight independently drawn poses."""
import hashlib
import json
import shutil
from zipfile import ZipFile, ZIP_DEFLATED
from pathlib import Path
from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'output/imagegen/memorial-offerings-v1/raw'
DEST = ROOT / 'miniprogram/packageMemorial/assets/offerings-v1'
BUNDLE = ROOT / 'output/imagegen/memorial-offerings-v1/upload/packageMemorial/v1/offerings-v1'

def extract(image):
    rgb = np.array(image.convert('RGB'), dtype=np.float32)
    excess = np.minimum(rgb[:, :, 0], rgb[:, :, 2]) - rgb[:, :, 1]
    alpha = np.clip((65 - excess) / 40, 0, 1)
    # Unmatte the antialiased boundary against the requested magenta backdrop.
    color = np.clip((rgb - (1 - alpha[:, :, None]) * [255, 0, 255]) / np.maximum(alpha[:, :, None], .001), 0, 255)
    rgba = np.concatenate([color, alpha[:, :, None] * 255], axis=2).astype('uint8')
    rgba[rgba[:, :, 3] < 12] = 0
    return Image.fromarray(rgba)

def bounds(image):
    return image.getchannel('A').point(lambda n: 255 if n > 80 else 0).getbbox()

def write(name, image):
    for folder in (DEST, BUNDLE):
        folder.mkdir(parents=True, exist_ok=True)
        image.save(folder / name, optimize=True)

def main():
    manifest = {'model': 'gpt-image-2', 'characterGrid': {'columns': 4, 'rows': 2, 'frame': [128, 128], 'anchor': [64, 115]}, 'sources': {}, 'files': []}
    for gender in ('boy', 'girl'):
        for kind in ('flower', 'snack'):
            name = f'{gender}-{kind}.png'
            source = Image.open(RAW / name)
            manifest['sources'][name] = hashlib.sha256((RAW / name).read_bytes()).hexdigest()
            if source.size != (1024, 1024):
                raise ValueError(f'Unexpected source grid: {name} {source.size}')
            clean = extract(source)
            cells = [clean.crop((i % 4 * 256, i // 4 * 512, i % 4 * 256 + 256, i // 4 * 512 + 512)) for i in range(8)]
            first = bounds(cells[0])
            scale = 98 / (first[3] - first[1])
            sheet = Image.new('RGBA', (512, 256))
            for i, cell in enumerate(cells):
                box = bounds(cell)
                crop = cell.crop(box)
                crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.LANCZOS)
                # Register the boots against the same ground anchor in every pose.
                arr = np.array(cell)
                yy, xx = np.where(arr[max(box[1], box[3] - 12):box[3], :, 3] > 80)
                sole = (int(xx.min()) + int(xx.max())) / 2
                x = round(64 + (box[0] - sole) * scale)
                y = 115 - crop.height
                if x < 0 or x + crop.width > 128 or y < 0:
                    raise ValueError(f'Pose clipped: {name} frame {i + 1}')
                sheet.alpha_composite(crop, (i % 4 * 128 + x, i // 4 * 128 + y))
            write(name, sheet)
    source = Image.open(RAW / 'props.png')
    manifest['sources']['props.png'] = hashlib.sha256((RAW / 'props.png').read_bytes()).hexdigest()
    for name, box in [('flower.png', (0, 0, 830, 1024)), ('snack.png', (830, 0, 1536, 1024))]:
        clean = extract(source.crop(box))
        clean = clean.crop(bounds(clean))
        clean.thumbnail((120, 120), Image.LANCZOS)
        out = Image.new('RGBA', (128, 128))
        out.alpha_composite(clean, ((128 - clean.width) // 2, 124 - clean.height))
        write(name, out)
    for path in sorted(DEST.glob('*.png')):
        manifest['files'].append({'path': 'offerings-v1/' + path.name, 'size': Image.open(path).size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    (ROOT / 'docs/design/pet-memorial/offerings-v1/manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    output = RAW.parent
    preview = output / 'preview-assets'
    preview.mkdir(exist_ok=True)
    for path in DEST.glob('*.png'):
        shutil.copy2(path, preview / path.name)
    shutil.copy2(DEST.parent / 'monuments-v1/arch.png', preview / 'arch.png')
    shutil.copy2(ROOT / 'docs/design/pet-memorial/offerings-v1/asset-preview.html', output / 'preview.html')
    readme = ('纪念园献花与零食素材：6 张透明 PNG。人物图集 512×256，4列×2行、8帧，脚底锚点(64,115)。\n\n'
              '开发云存储：将 packageMemorial/ 上传到 memorial-cloud-v1/ 下。\n'
              '正式云存储：同样将 packageMemorial/ 上传到 memorial-cloud-v1/ 下。\n'
              '两个环境的文件最终前缀相同：memorial-cloud-v1/packageMemorial/v1/offerings-v1/。\n\n'
              '同时发布 api 云函数和小程序。后台入口：纪念园审核 → 鲜花与零食·场景显示。\n'
              '默认各 1440 分钟，支持 1～10080 分钟，设置用于新献上的心意；累计数量永久保留。\n')
    (output / 'upload/上传说明.txt').write_text(readme)
    with ZipFile(output / 'memorial-offerings-upload.zip', 'w', ZIP_DEFLATED) as archive:
        for path in sorted((output / 'upload').rglob('*')):
            if path.is_file():
                archive.write(path, path.relative_to(output / 'upload'))

if __name__ == '__main__':
    main()
