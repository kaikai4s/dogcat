from PIL import Image,ImageDraw,ImageFilter,ImageChops,ImageFont
from pathlib import Path
import numpy as np,json,math
p=Path('output/imagegen/pet-memorial-sunburst-v6');(p/'hand-sources').mkdir(exist_ok=True)
idle=Image.open('output/imagegen/pet-memorial-sunburst-v5/idle-sw.png').convert('RGBA')
walk=Image.open('output/imagegen/pet-memorial-sunburst-v4/raw/boy-walk-sw-v2.png').convert('RGBA')
# Trace the two user-approved idle hands, including their gold cuffs. No invented hand geometry.
polygons={
 'near':[(180,193),(196,191),(199,202),(198,205),(201,211),(201,219),(198,225),(194,228),(190,232),(186,233),(184,231),(186,227),(187,219),(185,214),(184,219),(182,224),(179,224),(178,222),(178,215),(179,209),(181,205)],
 'far':[(104,193),(117,197),(116,204),(114,208),(114,216),(118,220),(117,225),(113,228),(110,229),(107,227),(105,225),(102,222),(100,218),(100,213),(101,208),(104,202)]}
pivots={'near':(189,201),'far':(110,201)}
hands={}
for side,poly in polygons.items():
 mask=Image.new('L',idle.size);d=ImageDraw.Draw(mask);d.polygon(poly,fill=255);mask=mask.filter(ImageFilter.GaussianBlur(.45));mask=ImageChops.multiply(mask,idle.getchannel('A'))
 layer=idle.copy();layer.putalpha(mask);cx,cy=pivots[side];crop=layer.crop((cx-32,cy-16,cx+32,cy+48));crop.save(p/'hand-sources'/f'{side}.png');hands[side]=crop
# Center of exposed wrist and rotation about the cuff, measured in accepted v4 frames.
near=[(199,218,-13),(188,220,-5),(180,222,0),(168,220,12),(148,218,23),(157,220,15),(180,221,3),(197,218,-10)]
far=[(92,207,13),(103,208,7),(115,210,1),(123,205,-5),(128,208,-12),(115,207,-7),(117,210,2),(104,206,9)]
out=Image.new('RGBA',walk.size);changes=Image.new('L',walk.size);report=[]
for i in range(8):
 box=(i%4*312,i//4*416,(i%4+1)*312,(i//4+1)*416);frame=walk.crop(box);maskframe=Image.new('L',(312,416))
 for side,track in [('far',far),('near',near)]:
  x,y,angle=track[i];source=hands[side];scale=1.12 if side=='near' else 1.08
  # Affine transform is rigid rotation plus fixed scale of the complete hand, not limb deformation.
  radians=math.radians(angle);c=math.cos(radians);s=math.sin(radians)
  # Pillow inverse transform: source pivot (32,16) maps exactly to the current wrist.
  affine=(c/scale,-s/scale,32-c*x/scale+s*y/scale,s/scale,c/scale,16-s*x/scale-c*y/scale)
  layer=source.transform((312,416),Image.Transform.AFFINE,affine,Image.Resampling.BICUBIC)
  frame.alpha_composite(layer);maskframe=ImageChops.lighter(maskframe,layer.getchannel('A'))
 out.paste(frame,(box[0],box[1]));changes.paste(maskframe,(box[0],box[1]));report.append({'frame':i+1,'nearWristAngle':near[i],'farWristAngle':far[i]})
out.save(p/'walk-sw.png');changes.save(p/'hands-overlay-mask.png');(p/'hand-placement.json').write_text(json.dumps(report,indent=2)+'\n')
# Three-way visual comparison at actual hand pixel sizes and enlarged.
old=Image.open('output/imagegen/pet-memorial-sunburst-v5/walk-sw.png').convert('RGBA');contact=Image.new('RGB',(8*224,2*180),'#294139');d=ImageDraw.Draw(contact);font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',15)
for i in range(8):
 for row,sheet in enumerate([old,out]):
  cell=sheet.crop((i%4*312,i//4*416,(i%4+1)*312,(i//4+1)*416));crop=cell.crop((60,180,224,270)).resize((224,123),Image.Resampling.LANCZOS);contact.paste(crop,(i*224,row*180+40),crop);d.text((i*224+8,row*180+10),f'{i+1} '+('上一版' if row==0 else '采用待机双手'),font=font,fill='white')
contact.save(p/'hands-before-after.jpg',quality=96)
a=np.array(walk);b=np.array(out);m=np.array(changes);assert np.array_equal(a[m==0],b[m==0]);print('Only hand-overlay pixels changed; original accepted walk remains identical elsewhere.')
