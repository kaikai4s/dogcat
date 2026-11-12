"""Normalize the generated three-style artwork and package an incremental upload."""
from pathlib import Path
from PIL import Image
import json, hashlib, zipfile, subprocess
ROOT = Path(__file__).resolve().parents[2]
source = ROOT / 'output/imagegen/memorial-monuments-v1/source.png'
out = ROOT / 'miniprogram/packageMemorial/assets/monuments-v1'
out.mkdir(parents=True, exist_ok=True)
im = Image.open(source).convert('RGBA')
atlas = Image.new('RGBA', (768, 352))
for i, style in enumerate(['arch', 'cottage', 'moon']):
    part = im.crop((i*im.width//3, 0, (i+1)*im.width//3, im.height))
    box = part.getchannel('A').point(lambda a: 255 if a > 12 else 0).getbbox()
    part = part.crop(box)
    part.thumbnail((248, 336), Image.LANCZOS)
    tile = Image.new('RGBA', (256, 352))
    tile.alpha_composite(part, ((256-part.width)//2, 344-part.height))
    tile.save(out / (style + '.png'), optimize=True)
    atlas.alpha_composite(tile, (i*256, 0))
atlas.save(out / 'atlas.png', optimize=True)
package = ROOT / 'output/memorial-monuments-upload'
package.mkdir(parents=True, exist_ok=True)
records = []
with zipfile.ZipFile(package / 'memorial-monuments-v1.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for path in sorted(out.glob('*.png')):
        key = 'monuments-v1/' + path.name
        z.write(path, key)
        records.append({'key': key, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size})
(package / 'manifest.json').write_text(json.dumps(records, indent=2))
(package / '上传说明.md').write_text('''# 时光小筑新素材
解压 memorial-monuments-v1.zip，将 monuments-v1 文件夹上传到云存储 memorial-cloud-v1/packageMemorial/v1/ 下。
共 4 张 PNG：atlas.png、arch.png、cottage.png、moon.png。正式环境目录为 packageMemorial/v1/monuments-v1/。
保留现有场景、人物和音频文件。新图需上传后重新编译；缺少 atlas.png 时园区加载会提示失败，可上传后重试。
这次有新的回忆接口和权限，需要部署 api 云函数、发布小程序，并按 docs/design/pet-memorial/memory-release.md 合并私有媒体存储规则。
''', encoding='utf-8')
print('Packed', len(records), 'files:', package)
