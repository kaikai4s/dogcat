from pathlib import Path
import shutil,json,zipfile,re
p=Path('output/imagegen/pet-memorial-sunburst-v7')
shutil.copy2('output/imagegen/pet-memorial-sunburst-v5/idle-contact.jpg',p/'idle-contact.jpg')
(p/'README.md').write_text('''# 第七轮：完整重新生成行走图

用户否决了第六轮移植双手，因为手腕与手不对齐。本轮重新使用 `gpt-image-2.6-sunburst`，通过 imagegen 技能自带 CLI 图片编辑生成完整人物帧。没有提取待机手掌再贴到行走上，没有重定位手腕、程序形变或补帧。

使用已认可的待机图作为人物、手掌及手腕的参考，并以第四轮行走图约束动作。模型原始输出保存于 `raw/`；完整提示词保存于 `prompts/`。最终采用哪一次输出及检查情况见 `manifest.json`。

`walk-sw.png` 是选中模型输出原图的逐字节副本，后处理只有等分提取 8 帧和生成预览。4 列×2 行，帧尺寸见 manifest。行走每帧 125ms；待机继续使用用户认可的第五轮版本，每帧 300ms，不重新生成。

`preview.html` 默认显示重绘行走，可暂停、逐帧、半速、切换底色和放大检查手腕。`hands-contact.jpg` 提供八帧手臂细节，`walk-contact.jpg` 提供全身逐帧图。

当前仅男角色左前方，尚未接入正式园区。新生成的行走需用户审阅，不能把文件检查通过等同于动作已获认可。
''')
(p/'processing').mkdir(exist_ok=True);shutil.copy2('tmp/imagegen/package-v7.py',p/'processing/package-v7.py')
with zipfile.ZipFile(p/'pet-memorial-boy-sw-v7.zip','w',zipfile.ZIP_DEFLATED) as z:
 for name in ['walk-sw.png','idle-sw.png','walk.gif','idle.gif','walk-contact.jpg','idle-contact.jpg','hands-contact.jpg','README.md','manifest.json','preview.html']:
  z.write(p/name,name)
 for folder in ['frames','prompts','raw']:
  for f in (p/folder).rglob('*'):
   if f.is_file():z.write(f,f.relative_to(p))
html=(p/'preview.html').read_text()
for ref in re.findall(r'(?:src|href)="([^\"]+)"',html):
 if not ref.startswith('data:'):assert (p/ref).exists(),ref
Path('tmp/imagegen/preview-v7-check.js').write_text(re.search('<script>([\\s\\S]*?)</script>',html).group(1))
prev=Path('output/imagegen/pet-memorial-sunburst-v6');backup=prev/'preview-before-v7.html'
if not backup.exists():shutil.copy2(prev/'preview.html',backup)
(prev/'preview.html').write_text(html.replace('<meta charset="utf-8">','<meta charset="utf-8"><base href="../pet-memorial-sunburst-v7/">',1))
d=Path('docs/design/pet-memorial/characters-v7');shutil.copytree(p,d,dirs_exist_ok=True,ignore=shutil.ignore_patterns('*.zip'));f=d/'preview.html';s=f.read_text().replace('href="pet-memorial-boy-sw-v7.zip"','href="../../../../output/imagegen/pet-memorial-sunburst-v7/pet-memorial-boy-sw-v7.zip"');f.write_text(s)
doc=Path('docs/design/pet-memorial/character-assets.md');s=doc.read_text();a=s.index('状态：');b=s.index('\n\n',a);s=s[:a]+'状态：用户认可第四轮步态及第五轮待机，但否决了第五、六轮行走手部处理。第七轮按用户要求重新用 `gpt-image-2.6-sunburst` 生成完整行走帧，取消手部移植。产物和检查记录见 `characters-v7/` 与 `output/imagegen/pet-memorial-sunburst-v7/`，待用户审阅。当前仅男角色左前方，尚未接入正式园区。'+s[b:];doc.write_text(s)
print('Packaged full-frame generation, unchanged approved idle, prompts, frame metadata and preview.')
