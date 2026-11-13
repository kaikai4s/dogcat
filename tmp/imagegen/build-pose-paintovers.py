from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import math
out=Path('output/imagegen/pet-memorial-sunburst-v4')
base=Image.open('output/imagegen/pet-memorial/bases/boy/sw.png').convert('RGBA')
def limb(d,pts,widths,fill):
 left=[];right=[]
 for i,(x,y) in enumerate(pts):
  before=pts[max(0,i-1)];after=pts[min(len(pts)-1,i+1)];dx=after[0]-before[0];dy=after[1]-before[1];l=math.hypot(dx,dy);nx=-dy/l;ny=dx/l
  left.append((x+nx*widths[i],y+ny*widths[i]));right.append((x-nx*widths[i],y-ny*widths[i]))
 d.polygon(left+right[::-1],fill=fill,outline='#c38a38',width=2)
 d.line([(x-4,y) for x,y in pts],fill='#fff6cd',width=4)
def leg(layer,hip,knee,ankle,near):
 d=ImageDraw.Draw(layer);limb(d,[hip,knee],[19,14],'#f4ddb0' if near else '#cdb27e');limb(d,[knee,ankle],[12,9],'#dfb35a' if near else '#b58a42');x,y=ankle
 d.polygon([(x-10,y-10),(x+9,y-7),(x+13,y+9),(x+8,y+14),(x-27,y+20),(x-34,y+15),(x-30,y+8),(x-13,y+3)],fill='#e5bd69' if near else '#bd964d',outline='#ba8537',width=2)
 d.line([(x-29,y+15),(x+8,y+11)],fill='#fff4c7',width=3)
for phase in ['a','b']:
 im=Image.new('RGBA',(512,512));d=ImageDraw.Draw(im)
 d.polygon([(224,163),(284,163),(369,282),(332,312),(286,288),(246,292),(195,312),(147,283)],fill='#d6b772',outline='#fbe4a1',width=2)
 if phase=='b':
  far=[(239,294),(214,360),(188,423)];near=[(278,296),(308,356),(332,410)];neararm=[(284,193),(258,240),(215,269)];fararm=[(223,195),(234,240),(265,277)]
 else:
  far=[(239,294),(270,353),(294,414)];near=[(278,296),(249,362),(222,433)];neararm=[(284,193),(312,237),(334,273)];fararm=[(223,195),(201,236),(178,271)]
 limb(d,fararm,[12,11,6],'#cdbd9a');leg(im,*far,False)
 body=base.copy();mask=body.getchannel('A');md=ImageDraw.Draw(mask);md.rectangle((0,293,512,512),fill=0);md.polygon([(196,207),(223,202),(237,245),(225,308),(192,311)],fill=0);md.polygon([(284,198),(313,209),(322,304),(285,307),(280,248)],fill=0);body.putalpha(mask)
 im.alpha_composite(body);leg(im,*near,True);d=ImageDraw.Draw(im);limb(d,neararm,[13,12,7],'#f6e8ce');hx,hy=neararm[-1];d.ellipse((hx-7,hy-5,hx+7,hy+13),fill='#fff0c7',outline='#d7b270',width=1)
 # Technical pose reference only. The model must repaint joints and materials.
 im.resize((1024,1024),Image.Resampling.LANCZOS).save(out/f'pose-paintover-{phase}.png')
(out/'prompts/contact-b.txt').write_text('''This is an unfinished paintover of a game character. Finish and unify this exact drawing into one beautiful golden luminous boy, keeping the silhouette and ALL LIMB POSITIONS exactly as supplied. The flat crude gold shapes are already in their intended final locations; repaint them into anatomically natural clothed limbs without changing their pose. Do not reset the pose. Keep the head, hair, blank face, torso, cape, proportions and camera from this image.
In the supplied drawing the FOREGROUND leg starts at the right hip and extends to the RIGHT behind the body; the BACKGROUND leg extends LEFT in front of the body. Preserve this depth order. The FOREGROUND arm crosses diagonally in front of the torso towards the LEFT and ends in a relaxed hand left of the waist. Preserve this silhouette exactly. Smooth the elbows, knees, shoulders and trouser seams; render flowing white satin trousers, white puffed sleeves, golden bracers and gold knee-high boots matching the existing torso and hair. Both boots point down-left. Keep the large open stride and the opposing arm swing. Preserve thin golden outlines, warm golden edge glow and luminous soft dimensional shading. Do not add a skirt, facial features, or change the left/right legs. The cape is ONE continuous intact cloth behind the body, with no vertical slits, rectangular gaps or disconnected pieces. The white blouse ends at the GOLD BELT; below it are trousers, not a tunic or skirt. Return ONE complete character with 80 pixels of blank padding on all sides on actual transparent background, 1024x1024, no ground shadow, no text. This is a pose-preserving cleanup, not a pose redesign.''')
