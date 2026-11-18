"""Bake eight original meadow blade clusters. Usage: grass_art.py ART_DIRECTORY."""
import argparse
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw


def blade_cluster(index):
    rng = random.Random(74103 + 113 * index)
    n, supersample = 128, 3
    im = Image.new('RGBA', (n*supersample, n*supersample), (143, 165, 82, 0))
    draw = ImageDraw.Draw(im)
    base_palette = [(85,111,53),(103,128,54),(91,126,65),(117,136,60)]
    tip_palette = [(170,187,86),(175,194,105),(151,176,100),(188,184,101)]
    for i in range(37+(index%4)*5):
        bx = rng.uniform(14,114)
        base = rng.uniform(0,17)
        h = rng.uniform(24,74) * (1+.29*math.sin(bx/128*math.pi))
        lean = (bx-64)*.35 + rng.uniform(-23,23) + (index-3.5)*.9
        bend = rng.uniform(-10,10)
        bwidth = rng.uniform(1.8,3.9)
        c0=base_palette[(index+i)%len(base_palette)];c1=tip_palette[(index*2+i)%len(tip_palette)]
        tint=rng.uniform(.91,1.07)
        steps=[]
        for k in range(7):
            t=k/6
            x=bx + lean*t*t + bend*math.sin(t*math.pi)
            y=n-2-base-h*t
            w=bwidth*(1-t)**.75
            steps.append(((x-w,y),(x+w,y),(x+w*.10,y)))
        def poly(points,col):
            draw.polygon([(round(x*supersample),round(y*supersample)) for x,y in points],fill=col)
        for k in range(6):
            t=(k+.65)/6;light=.92+.08*t
            col=tuple(min(255,round((a*(1-t)+b*t)*light*tint)) for a,b in zip(c0,c1));lit=tuple(min(255,round(c*1.105)) for c in col)
            l,r,m=steps[k];ll,rr,mm=steps[k+1];poly([l,ll,mm,m],col+(255,));poly([m,mm,rr,r],lit+(255,))
    # Map row zero to the roots on purpose: the editor and browser wind shader
    # can read UV.y as a root-to-tip weight in every grass draw call.
    return im.resize((n,n),getattr(Image,'Resampling',Image).LANCZOS).transpose(getattr(Image,'Transpose',Image).FLIP_TOP_BOTTOM)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory',type=Path);a=parser.parse_args()
    a.directory.mkdir(parents=True,exist_ok=True)
    atlas=Image.new('RGBA',(1024,128))
    for i in range(8):atlas.paste(blade_cluster(i),(i*128,0))
    atlas.save(a.directory/'grass-blades.png',optimize=True)


if __name__=='__main__':
    main()
