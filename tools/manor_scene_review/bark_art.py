"""Paint four repeatable, unlit bark albedo maps. Usage: bark_art.py ART_DIRECTORY."""
import argparse
import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


SIZE = 512
RESAMPLE = getattr(Image, 'Resampling', Image)
SPECIES = {
    'cherry': ((82, 66, 61), (174, 148, 134), 1571),
    'oak': ((55, 53, 49), (156, 143, 122), 2803),
    'apple': ((67, 61, 49), (172, 150, 119), 3811),
    'birch': ((157, 150, 137), (242, 238, 224), 4079),
}


def field(rng, cols, rows):
    border = 3
    values = [[rng.randrange(16, 240) for _ in range(cols)] for _ in range(rows)]
    img = Image.new('L', (cols+border*2, rows+border*2))
    img.putdata([values[(y-border) % rows][(x-border) % cols]
                 for y in range(img.height) for x in range(img.width)])
    return img.resize((SIZE, SIZE), RESAMPLE.BICUBIC,
                      box=(border, border, cols+border, rows+border))


def wrap(draw, pts, ink, width=1, polygon=False):
    x0, x1 = min(p[0] for p in pts)-width, max(p[0] for p in pts)+width
    y0, y1 = min(p[1] for p in pts)-width, max(p[1] for p in pts)+width
    xs = [0]+([SIZE] if x0 < 0 else [])+([-SIZE] if x1 >= SIZE else [])
    ys = [0]+([SIZE] if y0 < 0 else [])+([-SIZE] if y1 >= SIZE else [])
    for dx in xs:
        for dy in ys:
            points = [(x+dx, y+dy) for x, y in pts]
            if polygon:
                draw.polygon(points, fill=ink)
            else:
                draw.line(points, fill=ink, width=width)


def glaze(img, mask, rgb, opacity):
    return Image.composite(Image.new('RGB', img.size, rgb), img,
                           mask.point(lambda x: round(x*opacity)))


def oak_apple(img, rng, name):
    apple = name == 'apple'
    cracks = Image.new('L', img.size); ridge = Image.new('L', img.size)
    dc, dr = ImageDraw.Draw(cracks), ImageDraw.Draw(ridge)
    # Narrow valley splits fork in alternating directions along a shared grain.
    for _ in range(95 if apple else 142):
        x, y = rng.uniform(0,SIZE), rng.uniform(0,SIZE)
        span = rng.uniform(13,72) if apple else rng.uniform(24,102)
        phase = rng.uniform(0,math.tau); drift = rng.uniform(-11,11) if apple else rng.uniform(-8,8)
        waves = rng.uniform(2,4); bend = rng.uniform(1.3,4.7)
        amplitude = rng.uniform(.55,2.65) if apple else rng.uniform(.7,3.1)
        n = max(7, int(span/4)); left=[];right=[];mid=[]
        for k in range(n+1):
            t = k/n; envelope = max(0, math.sin(t*math.pi))**.69
            cx=x+drift*t+bend*math.sin(t*waves+phase)+rng.uniform(-.78,.78)
            cy=y+t*span; w=envelope*amplitude*(.7+.35*rng.random());mid.append((cx,cy))
            left.append((cx-w,cy));right.append((cx+w,cy))
        wrap(dc,left+right[::-1],rng.randrange(90,230),polygon=True)
        start = rng.randrange(1,max(2,n//2));end=rng.randrange(max(start+1,n//2+1),n+1)
        margin=rng.uniform(1.1,2.5);wrap(dr,[(xx-margin,zz) for xx,zz in left[start:end+1]],rng.randrange(60,148),rng.choice([1,1,2]))
        if rng.random() < (.48 if apple else .69):
            j=rng.randint(max(1,n//3),max(2,2*n//3));sx,sy=mid[j];sg=rng.choice([-1,1]);length=span*rng.uniform(.15,.46)
            wrap(dc,[(sx,sy),(sx+sg*2.1,sy-length*.24),(sx+sg*5.3,sy-length*.57),(sx+sg*rng.uniform(4,9),sy-length)],rng.randrange(61,148),1)
    img=glaze(img,cracks,(51,43,40) if apple else (46,44,40),.77)
    return glaze(img,ridge,(186,169,136),.37)


def horizontal(img,rng,birch):
    dark=Image.new('L',img.size);pale=Image.new('L',img.size)
    dd,dp=ImageDraw.Draw(dark),ImageDraw.Draw(pale)
    for i in range(231 if birch else 345):
        group=i<22
        x,y=rng.uniform(0,SIZE),rng.uniform(0,SIZE)
        length=rng.uniform(21,62) if group else rng.uniform(2.5,26)
        thick=rng.uniform(1.1,4.3) if group else rng.uniform(.45,1.65)
        if birch and group and i%3==0: thick*=1.65
        tilt=rng.uniform(-.045,.045);pts=[];lower=[];m=10 if group else 6
        for j in range(m+1):
            t=j/m;xx=x+t*length
            env=max(0,math.sin(t*math.pi))**.65
            center=y+t*length*tilt-1.0*math.sin(t*math.pi)+rng.uniform(-.65,.65)
            pts.append((xx,center-env*thick*rng.uniform(.42,.80)));lower.append((xx,center+env*thick*rng.uniform(.43,.84)))
        target=dd if birch or rng.random()<.31 else dp
        wrap(target,pts+lower[::-1],rng.randrange(118,240) if group else rng.randrange(90,195),polygon=True)
        if group:
            wrap(dp,[(xx,yy+1.4) for xx,yy in lower[2:-1]],rng.randrange(73,175),1)
            if birch and i%2==0:
                wrap(dd,[(x+length*.07,y),(x+length*.19,y+thick*2.3),(x+length*.52,y+thick*2.6),(x+length*.72,y+thick*2.2)],103,1)
        if birch and group and i%5==0:
            wrap(dd,[(x+length*.30,y-1),(x+length*.39,y-2.0*thick),(x+length*.46,y-3.1*thick),(x+length*.55,y-thick*.7)],145,1)
    if birch:
        # Uneven patches of mature bark, wide enough to read from the game camera.
        for _ in range(15):
            x,y=rng.uniform(0,SIZE),rng.uniform(0,SIZE)
            w,h=rng.uniform(39,78),rng.uniform(3.6,8.5)
            hull=[(x,y),(x+w*.18,y-h*.45),(x+w*.43,y-h*.37),(x+w*.54,y-h),
                  (x+w*.72,y-h*.56),(x+w,y-h*.45),(x+w*.81,y+h*.29),(x+w*.62,y+h*.48),
                  (x+w*.51,y+h*.21),(x+w*.26,y+h*.56)]
            wrap(dd,hull,rng.randrange(178,236),polygon=True)
            wrap(dp,hull[6:]+[hull[0]],156,1)
    img=glaze(img,dark,(62,61,56) if birch else (74,59,61),.93 if birch else .85)
    return glaze(img,pale,(248,240,213) if birch else (206,173,150),.58)


def knots(img,rng,name):
    scars=Image.new('L',img.size); raised=Image.new('L',img.size)
    ds,dr=ImageDraw.Draw(scars),ImageDraw.Draw(raised)
    for _ in range(4 if name=='oak' else 5):
        x,y=rng.uniform(0,SIZE),rng.uniform(0,SIZE)
        rx=rng.uniform(3,8);ry=rx*(rng.uniform(1.1,1.72) if name in ('oak','apple') else rng.uniform(.37,.70))
        for k in range(3):
            ang=rng.uniform(-.3,.5);end=rng.uniform(3.8,5.65);r=(.56+k*.49)
            pts=[]
            for j in range(18):
                a=ang+j*end/17;pts.append((x+rx*r*(1+.093*math.sin(3*a))*math.cos(a),y+ry*r*math.sin(a)-ry*.10*math.cos(a)))
            wrap(ds,pts,rng.randrange(80,160),1 if k else 2)
            wrap(dr,[(xx-.8,yy+.8) for xx,yy in pts[4:12]],95,1)
    return glaze(glaze(img,scars,(65,57,49),.61),raised,(196,181,151),.38)


def paint(name):
    low,high,seed=SPECIES[name];rng=random.Random(seed)
    coarse=field(rng,8,5);long=field(rng,48 if name in ('oak','apple') else 25,9)
    grain=field(rng,109 if name=='oak' else 69,23 if name in ('oak','apple') else 114)
    fine=field(rng,152 if name=='birch' else 201,176)
    value=Image.blend(Image.blend(coarse,long,.54),Image.blend(grain,fine,.24),.40)
    if name in ('oak','apple'):
        value=Image.blend(value,field(rng,104,11),.20)
    channels=[value.point(lambda v,a=a,b=b:round(a+(b-a)*(v/255))) for a,b in zip(low,high)]
    img=Image.merge('RGB',channels)
    if name in ('cherry','birch'):img=horizontal(img,rng,name=='birch')
    else:img=oak_apple(img,rng,name)
    if name=='apple':
        freckles=field(rng,144,137).point(lambda v:max(0,min(255,(v-158)*4)))
        spots=ImageChops.multiply(freckles,field(rng,16,15).point(lambda v:max(0,min(255,(v-107)*5))))
        img=glaze(img,spots,(143,146,118),.36)
    return knots(img,rng,name)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('output',type=Path);out=p.parse_args().output
    out.mkdir(parents=True,exist_ok=True)
    for name in SPECIES:
        paint(name).save(out/f'bark-{name}.jpg',quality=92,subsampling=0,optimize=True)


if __name__=='__main__':
    main()
