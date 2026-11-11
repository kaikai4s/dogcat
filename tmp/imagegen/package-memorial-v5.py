from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import numpy as np,json,hashlib,shutil
p=Path('output/imagegen/pet-memorial-sunburst-v5');idle=Image.open(p/'raw/boy-idle-sw.png').convert('RGBA');ref=idle.crop((0,0,312,416));atlas=Image.new('RGBA',idle.size)
# Keep generated torso/hair/cape animation; stabilize only planted boots, no limb warping.
mask=Image.new('L',(312,416));dr=ImageDraw.Draw(mask)
for y in range(416):dr.line((0,y,312,y),fill=round(255*max(0,min(1,(y-272)/12))))
for i in range(8):
 f=idle.crop((i%4*312,i//4*416,(i%4+1)*312,(i//4+1)*416));f=Image.composite(ref,f,mask);atlas.paste(f,(i%4*312,i//4*416))
atlas.save(p/'idle-sw.png')
font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',16)
report={'modelRequested':'gpt-image-2.6-sunburst','basis':'User accepted v4 walk on 2026-11-11; preserve gait and refine hands, add idle','scope':'boy/sw only','status':'hand-repair-and-idle-ready-for-user-review','productionIntegrated':False,'cellSize':[312,416],'columns':4,'rows':2,'frameCount':8,'animations':{},'processing':{'walk':'Generated enlarged wrist/hand details, mapped back and composited through local feathered masks; exact pixel equality outside masks','idle':'Generated eight idle poses; boots below y=284 locked to first generated frame, blended y=272..284; no limb deformation or synthesized inbetween frames'}}
previews={}
for action in ['walk','idle']:
 sheet=Image.open(p/f'{action}-sw.png').convert('RGBA');frames=[];records=[];folder=p/'frames'/action;folder.mkdir(parents=True,exist_ok=True);contact=Image.new('RGB',(1248,912),'#294139');cd=ImageDraw.Draw(contact)
 for i in range(8):
  f=sheet.crop((i%4*312,i//4*416,(i%4+1)*312,(i//4+1)*416));f.save(folder/f'{i+1:02}.png');a=np.array(f)[:,:,3];b=f.getchannel('A').point(lambda v:255 if v>32 else 0).getbbox();records.append({'frame':i+1,'bboxAlphaAbove32':b,'alphaRange':[int(a.min()),int(a.max())],'sha256':hashlib.sha256(f.tobytes()).hexdigest()})
  x=i%4*312;y=i//4*456;contact.paste(f,(x,y+40),f);cd.text((x+12,y+10),f'{"行走" if action=="walk" else "待机"} · {i+1}',font=font,fill='white')
  bg=Image.new('RGB',(312,416),'#456345');bg.paste(f,(0,0),f);frames.append(bg)
 contact.save(p/f'{action}-contact.jpg',quality=94)
 frames[0].save(p/f'{action}.gif',save_all=True,append_images=frames[1:],duration=125 if action=='walk' else 300,loop=0,disposal=2)
 report['animations'][action]={'atlas':f'{action}-sw.png','frameDurationMs':125 if action=='walk' else 300,'cycleDurationMs':1000 if action=='walk' else 2400,'frames':records,'uniqueFrames':len({r['sha256'] for r in records}),'noClippingAlphaAbove32':all(r['bboxAlphaAbove32'][0]>0 and r['bboxAlphaAbove32'][1]>0 and r['bboxAlphaAbove32'][2]<312 and r['bboxAlphaAbove32'][3]<416 for r in records)}
 previews[action]=frames
old=np.array(Image.open('output/imagegen/pet-memorial-sunburst-v4/raw/boy-walk-sw-v2.png').convert('RGBA'));new=np.array(Image.open(p/'walk-sw.png'));m=np.array(Image.open(p/'walk-hands-patch-mask.png'));report['walkOutsideHandMaskIdentical']=bool(np.array_equal(old[m==0],new[m==0]));assert report['walkOutsideHandMaskIdentical']
idlefs=[np.array(Image.open(p/'frames'/'idle'/f'{i+1:02}.png')) for i in range(8)];report['idleBootPixelsIdentical']=all(np.array_equal(idlefs[0][284:],f[284:]) for f in idlefs);assert report['idleBootPixelsIdentical']
(p/'manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'walkOutsideHandMaskIdentical':report['walkOutsideHandMaskIdentical'],'idleBootPixelsIdentical':report['idleBootPixelsIdentical'],'animations':{k:{key:v[key] for key in ['uniqueFrames','noClippingAlphaAbove32','cycleDurationMs']} for k,v in report['animations'].items()}},ensure_ascii=False))
