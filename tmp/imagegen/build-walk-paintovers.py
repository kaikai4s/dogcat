from pathlib import Path
from PIL import Image,ImageDraw
import math,runpy
# Reuse drawing primitives only; these coarse guides are never exported as player frames.
ns=runpy.run_path('tmp/imagegen/build-pose-paintovers.py');limb=ns['limb'];base=ns['base'];out=ns['out']
body=base.copy();mask=body.getchannel('A');d=ImageDraw.Draw(mask);d.rectangle((0,293,512,512),fill=0);d.polygon([(194,196),(224,194),(237,245),(225,308),(192,311)],fill=0);d.polygon([(281,192),(313,203),(322,304),(283,307),(277,242)],fill=0);body.putalpha(mask)
def knee(h,a,L1=73,L2=72):
 dx=a[0]-h[0];dy=a[1]-h[1];l=math.hypot(dx,dy);along=(L1*L1-L2*L2+l*l)/(2*l);off=math.sqrt(max(0,L1*L1-along*along));return(h[0]+dx/l*along-dy/l*off,h[1]+dy/l*along+dx/l*off)
def foot(phase,near):
 # First half: ground contact moving backwards. Second half: lifted recovery.
 offsets=[32,16,0,-16,-32,-16,0,16];lifts=[0,0,0,0,2,9,14,9];s=offsets[phase];return((274 if near else 240)-s,(430 if near else 424)+.1*s-lifts[phase])
def arm(phase,near,bob):
 s=[40,20,0,-20,-40,-20,0,20][phase];sx=284 if near else 223;sy=193+bob;shift=s*.95
 return [(sx,sy),(sx+shift*.45,sy+44),(sx+shift,sy+85-abs(shift)*.13)]
def render_leg(im,phase,near,bob):
 h=(278 if near else 239,296+bob-(0 if near else 3));a=foot(phase,near);k=knee(h,a,67 if near else 65.5,67 if near else 65.5);d=ImageDraw.Draw(im);limb(d,[h,k],[18,14],'#f4ddb0' if near else '#cdb27e');limb(d,[k,a],[12,9],'#dfb35a' if near else '#b58a42');x,y=a
 # Contact heel strike has toes raised; rear contact lifts heel.
 roll=0
 if phase==0:roll=6
 if phase==4:roll=-9
 shape=[(8,-8),(12,6),(7,12),(-26,18),(-33,13),(-29,6),(-12,1),(-9,-9)]
 points=[(x+px,y+py+(px+10)*roll/40) for px,py in shape];d.polygon(points,fill='#e5bd69' if near else '#bd964d',outline='#ba8537',width=2)
sheet=Image.new('RGBA',(1536,1024))
for i in range(8):
 im=Image.new('RGBA',(512,512));d=ImageDraw.Draw(im);bob=0
 for near,phase in [(True,i),(False,(i+4)%8)]:
  if phase<=4:
   ax,ay=foot(phase,near);hx=278 if near else 239;hy=296 if near else 293;length=132.5 if near else 129.5
   bob=max(bob,ay-hy-math.sqrt(max(0,length*length-(ax-hx)**2)))
 bob=round(bob)
 d.polygon([(224,163+bob),(284,163+bob),(365,282+bob),(332,309+bob),(286,287+bob),(246,292+bob),(195,308+bob),(151,283+bob)],fill='#d6b772',outline='#fbe4a1',width=2)
 fararm=arm((i+4)%8,False,bob);limb(d,fararm,[11,10,6],'#cdbd9a');render_leg(im,(i+4)%8,False,bob)
 im.alpha_composite(body,(0,bob));render_leg(im,i,True,bob);d=ImageDraw.Draw(im);a=arm(i,True,bob);limb(d,a,[13,11,6],'#f6e8ce');hx,hy=a[-1];d.ellipse((hx-6,hy-4,hx+6,hy+12),fill='#fff0c7',outline='#d7b270',width=1)
 cell=im.crop((64,0,448,512));cell.save(out/f'pose-{i:02}.png');sheet.alpha_composite(cell,((i%4)*384,(i//4)*512))
sheet.save(out/'walk-paintover-guide-v2.png')
(out/'prompts/walk-paintover-cleanup.txt').write_text('''Finish this supplied rough animation paintover into a polished game sprite sheet. Keep exactly its 8 figures in exactly its 4 columns and 2 rows, preserving each figure's DIFFERENT pose and position. The finished gold-white heads and upper torsos show the desired identity and beautiful luminous volumetric illustration quality. Repaint the crude flat gold arm and leg shapes to match that exact finish, but KEEP ALL LIMB POSITIONS AND DEPTH ORDER from the supplied drawing. Do not invent a new walk cycle. Do not duplicate the same step in all frames.
The nearer arm is attached to the right shoulder of the picture and swings from right/back in frame 1 to left/front in frame 5. The nearer leg moves in the opposite direction: forward/left in frame 1, back/right in frame 5. Frame 3: nearer leg supports, farther knee passes forward. Frame 7: farther leg supports, nearer knee passes forward. Keep these swaps and the visibly lifted swing feet. Both arms swing from their shoulders; hands relaxed and separate, NEVER clasped together. The far arm may be partly occluded by torso/cape. Boots follow the exact lower-left pointing silhouettes, natural heel-toe roll, consistent shoe volume. Render coherent knees and ankles under fitted gold-white trousers and tall gold boots. Each cape is intact continuous cloth with no holes or rectangular cutouts. The white blouse ends at the gold belt, with trousers below; no tunic, skirt, extra cuffs or armor redesign.
Preserve each frame's same scale, same camera facing lower-left, same head and body proportions, same short hair, blank luminous face and lighting. Small head bob only as already in the target. Do not zoom or enlarge the figures. Keep generous clear space above every head and below every boot inside each cell. Clean transparent background with real alpha; no checkerboard, numbers, text, borders, floor or extra sprites. This is an exact pose-preserving cleanup of the supplied animation target.''')
