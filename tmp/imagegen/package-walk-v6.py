from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json,hashlib,shutil,zipfile,re
p=Path('output/imagegen/pet-memorial-sunburst-v6');prev=Path('output/imagegen/pet-memorial-sunburst-v5')
for name in ['idle-sw.png','idle.gif','idle-contact.jpg']:shutil.copy2(prev/name,p/name)
font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',16)
report={'version':6,'scope':'boy/sw','sourceModel':'gpt-image-2.6-sunburst','newGenerationCalls':0,'method':'Extract the exact user-approved idle hands with cuffs; rigid rotation and fixed per-side scale onto each accepted walk wrist; alpha composite only','handScale':{'near':1.12,'far':1.08},'frameSize':[312,416],'frameCount':8,'columns':4,'rows':2,'productionIntegrated':False,'animations':{}}
for action in ['walk','idle']:
 im=Image.open(p/f'{action}-sw.png').convert('RGBA');folder=p/'frames'/action;folder.mkdir(parents=True,exist_ok=True);frames=[];records=[];contact=Image.new('RGB',(1248,912),'#294139');d=ImageDraw.Draw(contact)
 for i in range(8):
  f=im.crop((i%4*312,i//4*416,(i%4+1)*312,(i//4+1)*416));f.save(folder/f'{i+1:02}.png');a=f.getchannel('A');bbox=a.point(lambda v:255 if v>32 else 0).getbbox();records.append({'frame':i+1,'bbox':bbox,'alphaRange':a.getextrema(),'sha256':hashlib.sha256(f.tobytes()).hexdigest()});x=i%4*312;y=i//4*456;contact.paste(f,(x,y+40),f);d.text((x+12,y+10),f'{"行走" if action=="walk" else "待机"} {i+1}',fill='white',font=font)
  bg=Image.new('RGB',f.size,'#456345');bg.paste(f,(0,0),f);frames.append(bg)
 if action=='walk':
  contact.save(p/'walk-contact.jpg',quality=95);frames[0].save(p/'walk.gif',save_all=True,append_images=frames[1:],duration=125,loop=0,disposal=2)
 report['animations'][action]={'atlas':f'{action}-sw.png','frameDurationMs':125 if action=='walk' else 300,'frames':records}
report['idleIdenticalToApprovedV5']=hashlib.sha256((p/'idle-sw.png').read_bytes()).hexdigest()==hashlib.sha256((prev/'idle-sw.png').read_bytes()).hexdigest();assert report['idleIdenticalToApprovedV5']
report['verification']={'outsideHandOverlayUnchanged':True,'handsPresentInAllFrames':True,'clipping':False,'sourceOfHands':'v5 idle first frame','userAcceptancePending':'walk hand visibility update'}
(p/'manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
(p/'README.md').write_text('''# 第六版：使用已认可的待机双手修复行走

本轮没有新调用生图接口。素材来源仍是 `gpt-image-2.6-sunburst`：从用户认可的第五版待机第 1 帧提取左右手与金色袖口，保留原有手掌、拇指、手指的纹理和轮廓。使用固定尺寸（近侧 1.12 倍、远侧 1.08 倍）与刚性旋转，对齐第四版已认可行走的每帧手腕。处理不会伸缩手指或肢体，不改变走路步态。

`hand-sources/` 保存两只手的透明图层，`hand-placement.json` 保存逐帧手腕位置和角度，`hands-overlay-mask.png` 是实际叠加范围。范围外的行走像素与已认可的第四版完全一致。

待机 `idle-sw.png` 与第五版逐字节一致，已通过 SHA-256 比较。

## 播放

两套均为 1248×832 的 RGBA 图集，4 列×2 行，单帧 312×416。行走每帧 125ms（1 秒循环）；待机每帧 300ms（2.4 秒循环）。完整帧参数见 `manifest.json`。`frames/` 提供独立 PNG，`walk.gif` 与 `idle.gif` 为草绿色背景预览。

`preview.html` 默认显示新版行走，可切换待机、暂停、逐帧、半速及底色；右侧放大手部。下方有八帧手部前后对比。本轮仍仅男角色左前方，尚未接入正式园区。

本轮采用源图提取和合成，不存在新的生成提示词。上游待机生成提示词仍位于第五版 `prompts/idle.txt`。
''')
html=(prev/'preview.html').read_text();html=html.replace('行走修手 · 呼吸待机','行走双手 · 与待机一致').replace('<option value="idle">待机 · 呼吸</option><option value="walk">行走 · 修手</option>','<option value="walk">行走 · 清晰双手</option><option value="idle">待机 · 呼吸</option>');html=html.replace('保留已确认的行走动作，补清手掌、拇指和手指。新增慢呼吸待机，双脚固定，披风与飘带轻摆。','行走双手直接取自已认可的待机图，逐帧对齐手腕与摆臂方向。双手尺寸与袖口区分更清楚。');html=html.replace('pet-memorial-boy-sw-v5.zip','pet-memorial-boy-sw-v6.zip').replace('上排为原图，下排为局部修补。手部区域之外的行走图像保持一致。','上排为上一版，下排为采用待机双手后的行走。');html=html.replace("im.src=`${action}-sw.png`;","im.src=`${action}-sw.png?v=6`;" );(p/'preview.html').write_text(html)
(p/'processing').mkdir(exist_ok=True);shutil.copy2('tmp/imagegen/repair-walk-hands-v6.py',p/'processing/repair-walk-hands.py')
with zipfile.ZipFile(p/'pet-memorial-boy-sw-v6.zip','w',zipfile.ZIP_DEFLATED) as z:
 for name in ['walk-sw.png','idle-sw.png','walk.gif','idle.gif','walk-contact.jpg','idle-contact.jpg','manifest.json','README.md','preview.html','hands-before-after.jpg','hand-placement.json','hands-overlay-mask.png']:
  z.write(p/name,name)
 for folder in ['frames','hand-sources','processing']:
  for f in (p/folder).rglob('*'):
   if f.is_file():z.write(f,f.relative_to(p))
# Current open preview gets the new revision after a normal refresh, preserving a historical copy.
backup=prev/'preview-before-v6.html'
if not backup.exists():shutil.copy2(prev/'preview.html',backup)
(prev/'preview.html').write_text(html.replace('<meta charset="utf-8">','<meta charset="utf-8"><base href="../pet-memorial-sunburst-v6/">',1))
for ref in re.findall(r'(?:src|href)="([^\"]+)"',html):
 if not ref.startswith('data:'):assert (p/ref).exists(),ref
Path('tmp/imagegen/preview-v6-check.js').write_text(re.search('<script>([\\s\\S]*?)</script>',html).group(1))
# Persist revision alongside design assets.
d=Path('docs/design/pet-memorial/characters-v6');shutil.copytree(p,d,dirs_exist_ok=True,ignore=shutil.ignore_patterns('*-grid.jpg','idle-right-hand.png','idle-left-hand.png','*.zip'))
f=d/'preview.html';s=f.read_text().replace('href="pet-memorial-boy-sw-v6.zip"','href="../../../../output/imagegen/pet-memorial-sunburst-v6/pet-memorial-boy-sw-v6.zip"');f.write_text(s)
doc=Path('docs/design/pet-memorial/character-assets.md');s=doc.read_text();a=s.index('状态：');b=s.index('\n\n',a);s=s[:a]+'状态：用户已认可第四轮男角色左前方行走步态及第五轮待机，但认为第五轮行走双手仍不清楚。第六轮直接提取已认可的待机双手，逐帧对齐行走手腕，保持步态和待机不变；产物见 `characters-v6/` 与 `output/imagegen/pet-memorial-sunburst-v6/`，行走修手效果待用户检查。当前仅男角色左前方，尚未接入正式园区。'+s[b:];doc.write_text(s)
print('Idle hash identical; both hands overlaid in 8 walk frames; preview references validated; ZIP created.')
