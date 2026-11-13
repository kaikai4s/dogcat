"""Bundle only the expanded chunks and seasonal atlas, with verified upload paths."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/memorial-environment-upload'
OUT.mkdir(parents=True, exist_ok=True)
records = json.loads(subprocess.check_output(['node', '-e', """
const assets = require('./miniprogram/packageMemorial/scene/cloud-assets');
const { CHUNK_DIRECTORY } = require('./miniprogram/packageMemorial/scene/world-template');
const { CLOUD_STORAGE_ROOTS } = require('./miniprogram/utils/cloud-assets');
const keys = assets.FILES.filter(k => k.startsWith(CHUNK_DIRECTORY + '/') || k.startsWith('seasons-v1/'));
console.log(JSON.stringify(keys.map(key => ({key, fileIDs: Object.fromEntries(
  Object.keys(CLOUD_STORAGE_ROOTS).map(env => [env, assets.fileID(key, env)]))}))));
"""], cwd=ROOT, encoding='utf-8'))
archive_path = OUT / 'memorial-environment.zip'
with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
    for record in records:
        source = ROOT / 'miniprogram/packageMemorial/assets' / record['key']
        target = OUT / record['key']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        record.update(bytes=source.stat().st_size, sha256=hashlib.sha256(source.read_bytes()).hexdigest())
        archive.write(source, record['key'])
with zipfile.ZipFile(archive_path) as archive:
    assert len(archive.namelist()) == len(records) == 97
    for record in records:
        assert hashlib.sha256(archive.read(record['key'])).hexdigest() == record['sha256']
(OUT / 'manifest.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
(OUT / '上传说明.md').write_text('''# 纪念园扩建与四季素材

解压 memorial-environment.zip，共 97 个文件：world-v3/chunks 下 96 个区域 JSON，seasons-v1 下 1 张 foliage.png。

开发/体验环境：在云存储 memorial-cloud-v1/packageMemorial/v1/ 内上传 world-v3 和 seasons-v1 两个文件夹。
正式环境：同样在云存储 memorial-cloud-v1/packageMemorial/v1/ 内上传这两个文件夹。

请保留文件夹层级，勿上传 ZIP、manifest.json、此说明或外层 memorial-environment-upload 文件夹。
可对照 manifest.json 的 fileIDs 核对每个环境的目标路径。该清单来自配置，不代表云端已经上传。

更新顺序：先上传资源，再部署 api 云函数，最后重新编译/发布小程序。
不要移动或删除旧 world-v2、人物、声音、monuments-v1 等资源。旧版客户端仍需要旧区域文件。
这次没有新增集合和查询索引。原园区、小筑和格子编号无需迁移；扩建区域仍使用原 garden-ortho-v2 标识。
上线前请在微信真机验证新区行走、小筑申请、昼夜显示，以及两台设备在同园的天气一致性。
''', encoding='utf-8')
print(f'Verified {len(records)} files, {sum(r["bytes"] for r in records):,} bytes: {archive_path}')
