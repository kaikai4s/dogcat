"""Package the legacy v1 resource set; use package-memorial-world-cloud.py for v2 additions."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/memorial-cloud-upload-v1'


def main():
    config = json.loads(subprocess.check_output(['node', '-e', """
const a=require('./miniprogram/packageMemorial/scene/cloud-assets');
const {CLOUD_STORAGE_ROOTS}=require('./miniprogram/utils/cloud-assets');
console.log(JSON.stringify({directory:a.DIRECTORY,environmentDirectories:a.ENV_DIRECTORIES,files:a.FILES.filter(key=>/^(garden\.jpg$|boy\/|girl\/|audio\/)/.test(key)),
  environments:Object.fromEntries(Object.keys(CLOUD_STORAGE_ROOTS).map(env=>[env,Object.fromEntries(a.FILES.filter(key=>/^(garden\.jpg$|boy\/|girl\/|audio\/)/.test(key)).map(key=>[key,a.fileID(key,env)]))]))}));
"""], cwd=ROOT, text=True, encoding='utf-8'))
    OUT.mkdir(parents=True, exist_ok=True)
    records = []
    archive = OUT / 'memorial-cloud-v1.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for key in config['files']:
            source = ROOT / 'miniprogram/packageMemorial/assets' / key
            relative = config['directory'] + '/' + key
            target = OUT / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            assert digest == hashlib.sha256(source.read_bytes()).hexdigest()
            records.append({'key': key, 'cloudPath': relative, 'bytes': target.stat().st_size, 'sha256': digest})
            bundle.write(target, relative)
    manifest = {**config, 'records': records, 'totalBytes': sum(item['bytes'] for item in records)}
    (OUT / 'upload-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    instructions = '''# 纪念园云存储上传包

共 20 个文件：园区背景 1 张，男女四方向行走/待机图集 16 张，音乐和音效 3 个。

1. 解压 memorial-cloud-v1.zip。里面已有 packageMemorial/v1/ 层级。
2. 微信开发者工具 → 云开发 → 存储，选择开发/体验环境 cloud1-5gnhqn4t0554c1d9。
3. 开发/体验环境已按用户实际上传目录配置为 memorial-cloud-v1/packageMemorial/v1/。现有上传不用移动或重传。
   之后替换素材时，在云存储 memorial-cloud-v1 目录内上传解压后的 packageMemorial 文件夹，保留 v1、boy、girl、audio 子目录。
4. 开发/体验环境背景的实际云路径为 memorial-cloud-v1/packageMemorial/v1/garden.jpg，不要再增加外层目录。
5. 资源需允许小程序的访问用户读取；不要开放公共写入。重新编译小程序并进入纪念园验证。
6. 正式版使用 production-d2g5jx277f41a81a6 环境，目录同样为 memorial-cloud-v1/packageMemorial/v1/。两个环境保持相同文件夹和文件名，仅云环境与存储桶标识不同。

ZIP、此说明和 upload-manifest.json 不需要上传。只上传 packageMemorial/v1/ 下的图片和 WAV。
人物图集为 512×256，4 列×2 行，每格128×128，8帧，锚点(64,115)；上传时不要转换、压缩或裁切。
代码通过 wx.cloud.downloadFile 获取临时本地文件后交给 Canvas2D 和音频播放器，不使用过期签名 URL，也不回退到包内素材。
开发/体验环境的 garden.jpg FileID 已由用户提供并核对，人物与声音按同目录拼接。清单内其余ID是配置推导，不代表已逐一验证云端内容或权限。
'''
    (OUT / '上传说明.md').write_text(instructions, encoding='utf-8')
    with zipfile.ZipFile(archive) as bundle:
        assert len(bundle.namelist()) == 20
        for record in records:
            assert hashlib.sha256(bundle.read(record['cloudPath'])).hexdigest() == record['sha256']
    print(f"Verified {len(records)} assets, {manifest['totalBytes']:,} bytes; zip: {archive}")


if __name__ == '__main__':
    main()
