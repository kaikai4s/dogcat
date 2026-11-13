from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import shutil,json,hashlib,sys
p=Path('output/imagegen/pet-memorial-sunburst-v7');src=p/'raw'/('walk-redrawn.png' if len(sys.argv)<2 else sys.argv[1]);im=Image.open(src).convert('RGBA');cw,ch=im.width//4,im.height//2
assert im.width%4==0 and im.height%2==0
shutil.copy2(src,p/'walk-sw.png');shutil.copy2('output/imagegen/pet-memorial-sunburst-v5/idle-sw.png',p/'idle-sw.png');shutil.copy2('output/imagegen/pet-memorial-sunburst-v5/idle.gif',p/'idle.gif')
font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',16)
frames=[];records=[];contact=Image.new('RGB',(im.width,im.height+80),'#294139');cd=ImageDraw.Draw(contact);hands=Image.new('RGB',(4*360,2*230),'#294139');hd=ImageDraw.Draw(hands)
(p/'frames/walk').mkdir(parents=True,exist_ok=True)
for i in range(8):
 f=im.crop((i%4*cw,i//4*ch,(i%4+1)*cw,(i//4+1)*ch));f.save(p/'frames/walk'/f'{i+1:02}.png');a=f.getchannel('A');bbox=a.point(lambda v:255 if v>32 else 0).getbbox();records.append({'frame':i+1,'bbox':bbox,'alphaRange':a.getextrema(),'sha256':hashlib.sha256(f.tobytes()).hexdigest()});x=i%4*cw;y=i//4*(ch+40);contact.paste(f,(x,y+40),f);cd.text((x+12,y+10),f'行走 · {i+1}',font=font,fill='white')
 # Upper-body detail shows complete elbow-to-hand connections, not isolated palms.
 crop=f.crop((round(cw*.17),round(ch*.36),round(cw*.78),round(ch*.67)));crop.thumbnail((340,185),Image.Resampling.LANCZOS);hx=i%4*360;hy=i//4*230;hands.paste(crop,(hx+(360-crop.width)//2,hy+40),crop);hd.text((hx+12,hy+10),f'第 {i+1} 帧 · 手臂和手腕',font=font,fill='white')
 bg=Image.new('RGB',(cw,ch),'#456345');bg.paste(f,(0,0),f);frames.append(bg)
contact.save(p/'walk-contact.jpg',quality=96);hands.save(p/'hands-contact.jpg',quality=96);frames[0].save(p/'walk.gif',save_all=True,append_images=frames[1:],duration=125,loop=0,disposal=2)
report={'modelRequested':'gpt-image-2.6-sunburst','scope':'boy/sw','method':'Complete model-generated frames, equal-cell slicing only; no transferred hands, joint warping, or per-frame rescaling','source':str(src.relative_to(p)),'frameSize':[cw,ch],'columns':4,'rows':2,'frameCount':8,'frameDurationMs':125,'idleUnchanged':hashlib.sha256((p/'idle-sw.png').read_bytes()).digest()==hashlib.sha256(Path('output/imagegen/pet-memorial-sunburst-v5/idle-sw.png').read_bytes()).digest(),'frames':records,'visualStatus':'pending-review','productionIntegrated':False}
(p/'manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'size':im.size,'bounds':[r['bbox'] for r in records],'uniqueFrames':len(set(r['sha256'] for r in records))}))
