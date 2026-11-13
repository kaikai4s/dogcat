"""Produce an incremental world-v2 upload. Existing avatars/audio are not duplicated."""
from pathlib import Path
import json
import hashlib
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/memorial-world-v2-upload'
OUT.mkdir(parents=True, exist_ok=True)
config = json.loads(subprocess.check_output(['node', '-e', """
const a=require('./miniprogram/packageMemorial/scene/cloud-assets');
const files=['world-v2/props.png','world-v2/grass.jpg'];
for(let y=0;y<6;y++)for(let x=0;x<8;x++)files.push('world-v2/chunks/'+x+'-'+y+'.json');
const {memorialAssetID}=require('./miniprogram/packageMemorial/scene/memorial-asset-path');
console.log(JSON.stringify(files.map(key=>({key,fileID:memorialAssetID(key,'cloud1-5gnhqn4t0554c1d9')}))));
"""], cwd=ROOT, encoding='utf-8'))
with zipfile.ZipFile(OUT / 'memorial-world-v2.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for record in config:
        source = ROOT / 'miniprogram/packageMemorial/assets' / record['key']
        target = OUT / record['key']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        archive.write(target, record['key'])
        record['sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
        record['bytes'] = source.stat().st_size
with zipfile.ZipFile(OUT / 'memorial-world-v2.zip') as archive:
    assert len(archive.namelist()) == 50
    for record in config:
        assert hashlib.sha256(archive.read(record['key'])).hexdigest() == record['sha256']
(OUT / 'manifest.json').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
(OUT / '上传说明.md').write_text('''# 统一比例园区补充资源

解压 memorial-world-v2.zip，只上传里面的 world-v2 文件夹。

在你之前截图里的云存储目录：
`memorial-cloud-v1/packageMemorial/v1/`
点击“上传文件夹”，选择 world-v2。

正确结果：
- memorial-cloud-v1/packageMemorial/v1/world-v2/props.png
- memorial-cloud-v1/packageMemorial/v1/world-v2/grass.jpg
- memorial-cloud-v1/packageMemorial/v1/world-v2/chunks/0-0.json
- 其余 47 个区域 JSON 同级。

共 50 个文件：2 张纹理图、48 个场景区域数据。不要上传 ZIP、manifest 或此说明，也不要把外层 memorial-world-v2-upload 传进去。
原先 boy、girl、audio 和 garden.jpg 都不用移动、删除或重新上传。新版行走场景不再使用 garden.jpg，但保留文件不影响运行。

上传后在微信开发者工具清缓存并重新编译。普通视图全园采用固定比例，走路时下载附近区域；“园区导览”是地图示意图。后续墓碑使用统一规格，现阶段尚未开放建碑。
正式环境仍使用 packageMemorial/v1/world-v2/ 路径（没有 memorial-cloud-v1 外层）。上线前还需上传正式环境并完成真机验证。
''', encoding='utf-8')
print(f"Verified {len(config)} files; {sum(r['bytes'] for r in config):,} bytes; {OUT / 'memorial-world-v2.zip'}")
