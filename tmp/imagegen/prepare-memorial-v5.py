from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter,ImageFont
import numpy as np,json
p=Path('output/imagegen/pet-memorial-sunburst-v5')
old=Image.open('output/imagegen/pet-memorial-sunburst-v4/raw/boy-walk-sw-v2.png').convert('RGBA')
detail=Image.open(p/'raw/walk-hand-details.png').convert('RGBA').resize((1536,1024),Image.Resampling.LANCZOS)
centers=[[(202,233),(87,218)],[(191,234),(100,220)],[(175,235),(111,220)],[(156,232),(120,217)],[(140,232),(123,215)],[(150,233),(106,222)],[(175,233),(113,223)],[(199,231),(97,220)]]
atlas=Image.new('RGBA',old.size);masks=Image.new('L',old.size);compare=Image.new('RGB',(8*224,2*180),'#294139');font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',15);d=ImageDraw.Draw(compare)
for i in range(8):
 box=(i%4*312,i//4*416,(i%4+1)*312,(i//4+1)*416);orig=old.crop(box)
 patch=detail.crop((i%4*384+24,i//4*512+136,i%4*384+360,i//4*512+376)).resize((224,160),Image.Resampling.LANCZOS)
 candidate=orig.copy();candidate.paste(patch,(48,110))
 mask=Image.new('L',orig.size);dr=ImageDraw.Draw(mask)
 for j,(x,y) in enumerate(centers[i]):
  rx=17 if j==0 else 13;dr.ellipse((x-rx,y-23,x+rx,y+21),fill=255)
 mask=mask.filter(ImageFilter.GaussianBlur(1.2))
 # Confine pixel changes strictly to local wrist/palm masks, preserving accepted gait elsewhere.
 merged=Image.composite(candidate,orig,mask);atlas.paste(merged,(box[0],box[1]));masks.paste(mask,(box[0],box[1]))
 for row,f in enumerate([orig,merged]):
  crop=f.crop((60,180,224,262)).resize((224,112),Image.Resampling.LANCZOS);compare.paste(crop,(i*224,row*180+40),crop);d.text((i*224+10,row*180+10),f'{i+1} '+('原图' if row==0 else '手部修补'),font=font,fill='white')
atlas.save(p/'walk-sw.png');masks.save(p/'walk-hands-patch-mask.png');compare.save(p/'hands-before-after.jpg',quality=96)
a=np.array(old);b=np.array(atlas);m=np.array(masks);assert np.array_equal(a[m==0],b[m==0]);print('Walk body and legs unchanged outside local wrist/hand masks; changed pixels',int(np.any(a!=b,axis=2).sum()))
# Determine idle frame drift before any registration.
idle=Image.open(p/'raw/boy-idle-sw.png').convert('RGBA');records=[]
for i in range(8):
 f=idle.crop((i%4*312,i//4*416,(i%4+1)*312,(i//4+1)*416));aa=np.array(f)[:,:,3];lower=aa.copy();lower[:280]=0;coords=np.argwhere(lower>100);records.append({'frame':i+1,'feetBBox':[int(coords[:,1].min()),int(coords[:,0].min()),int(coords[:,1].max()+1),int(coords[:,0].max()+1)]})
print('Idle raw',idle.size,'feet',records)
