from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json,hashlib
p=Path('output/imagegen/pet-memorial-sunburst-v4')
source=p/'raw/boy-walk-sw-v2.png';im=Image.open(source).convert('RGBA');cw,ch=im.width//4,im.height//2
(p/'frames').mkdir(exist_ok=True)
frames=[];records=[]
font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',18)
contact=Image.new('RGB',(cw*4,(ch+36)*2),'#294139');draw=ImageDraw.Draw(contact)
for i in range(8):
 f=im.crop((i%4*cw,i//4*ch,(i%4+1)*cw,(i//4+1)*ch));f.save(p/'frames'/f'{i+1:02}.png')
 a=f.getchannel('A');bbox=a.point(lambda v:255 if v>32 else 0).getbbox();records.append({'frame':i+1,'bboxAlphaAbove32':bbox,'sha256':hashlib.sha256(f.tobytes()).hexdigest(),'alphaExtrema':a.getextrema()})
 x=i%4*cw;y=i//4*(ch+36);contact.paste(f,(x,y+36),f);draw.text((x+14,y+6),f'第 {i+1} 帧',font=font,fill='#fff1cc')
 bg=Image.new('RGB',(cw,ch),'#456345');bg.paste(f,(0,0),f);frames.append(bg)
contact.save(p/'contact-sheet.jpg',quality=94)
frames[0].save(p/'walk-review.gif',save_all=True,append_images=frames[1:],duration=125,loop=0,disposal=2)
report={'requestedModel':'gpt-image-2.6-sunburst','rawSize':list(im.size),'frameSize':[cw,ch],'frameCount':8,'frames':records,'postprocessing':'Equal-cell slicing only; no per-frame scaling, warping or synthesized inbetweens','visualStatus':'pending-review','productionReady':False}
(p/'review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'rawSize':list(im.size),'frameSize':[cw,ch],'uniqueFrames':len({r['sha256'] for r in records}),'bounds':[r['bboxAlphaAbove32'] for r in records]}))
