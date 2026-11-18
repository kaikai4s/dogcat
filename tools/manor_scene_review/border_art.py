"""Pick painted flowers and leaves from the foreground and build a transparent plant atlas."""
import argparse
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw


RES=getattr(Image,'Resampling',Image)
REGIONS=[
 (16,534,51,572),(314,464,366,494),(498,489,550,520),(103,499,122,520),
 (85,556,125,597),(38,486,84,510),(108,577,149,610),(139,573,165,600),
 (19,568,57,610),(61,540,101,582),(431,465,466,490),(110,560,146,591),
]


def cut(src,b):
    return src.crop(tuple(round(i*src.width/1100) for i in b))


def blossoms(src,kind):
    out=[]
    for box in REGIONS:
        a=np.asarray(cut(src,box)).astype('float32')
        r,g,b=a.transpose(2,0,1)
        if kind=='cream':
            mask=(np.minimum(np.minimum(r,g),b)>170)&(np.abs(g-b)<46)&(r>b-6)
        elif kind=='gold':
            mask=(r>174)&(g>134)&(r-g>-3)&(g-b>38)&(r-b>42)
        else:
            mask=(r>134)&(b>108)&(np.maximum(r,b)>g+14)&(b>g*.96)
        labels,ids,stats,_=cv2.connectedComponentsWithStats(mask.astype('uint8'),8)
        for ix in range(1,labels):
            x,y,w,h,area=stats[ix]
            if area<12 or min(w,h)<3 or w/h<.32 or w/h>2.9:continue
            if x<1 or y<1 or x+w>=a.shape[1]-1 or y+h>=a.shape[0]-1:continue
            xa,ya=max(0,x-2),max(0,y-2)
            sample=a[ya:y+h+2,xa:x+w+2].astype('uint8')
            alpha=((ids[ya:y+h+2,xa:x+w+2]==ix)*255).astype('uint8')
            alpha=cv2.GaussianBlur(cv2.dilate(alpha,np.ones((2,2),'uint8')),(3,3),.45)
            out.append((area,Image.fromarray(np.dstack((sample,alpha)))))
    out.sort(key=lambda tup:tup[0],reverse=True)
    return [im for _,im in out[:27]]


def leaf_swatch(src,style,seed):
    rng=np.random.default_rng(seed)
    candidates=[(21,568,40,593),(1050,375,1068,395),(36,582,60,606),(755,389,772,407),(59,574,78,590)]
    im=cut(src,candidates[seed%len(candidates)]).resize((75,98),RES.BICUBIC)
    u,v=np.meshgrid(np.linspace(-1,1,75),np.linspace(0,1,98))
    axis=.12*np.sin(v*4.7+seed)
    w=(np.sin(np.pi*v)**(.60 if style==0 else .92))*(.94 if style==0 else .57)
    if style==2:w*=.76+.24*np.sin(v*22+seed)
    alpha=(np.clip((w-abs(u-axis))*26,0,1)*255).astype('uint8')
    a=np.asarray(im).astype('float32')
    lum=a@np.array([.25,.62,.13]); tone=np.array([.77,1.03,.57]) if seed%4 else np.array([.96,1.02,.57])
    a=np.clip(.35*a+.65*lum[...,None]*tone[None,None,:]+rng.uniform(1,9),0,255)
    return Image.fromarray(np.dstack((a.astype('uint8'),alpha)))


def stamp(canvas,sprite,cx,cy,w,h,angle):
    elem=sprite.resize((max(3,int(w)),max(3,int(h))),RES.LANCZOS)
    if angle:elem=elem.rotate(float(angle),RES.BICUBIC,expand=True)
    canvas.alpha_composite(elem,(round(cx-elem.width*.5),round(cy-elem.height*.5)))


def plant(src,parts,style):
    rng=np.random.default_rng(581+style);rand=rng.uniform
    im=Image.new('RGBA',(256,256));d=ImageDraw.Draw(im)
    roots=[(rand(89,162),rand(231,241)) for _ in range(18)]
    palette=['cream','gold','pink','pink','cream','gold','pink','cream',None,None,'gold',None]
    rep=[9,13,11,15,16,10,12,13,0,0,14,0][style]
    leaf_kind=style%3
    leaves=[leaf_swatch(src,leaf_kind,style*11+j) for j in range(5)]
    for i in range(18):
        rx,ry=roots[i];angle=(i-8.5)/9*1.15+rand(-.12,.12)
        l=rand(96,184);ex=rx+np.sin(angle)*l*.66;ey=ry-np.cos(angle)*l
        curve=[(rx,ry),(rx+(ex-rx)*.36,ry+(ey-ry)*.47),(ex,ey)]
        d.line(curve,fill=(82+int(rand(0,17)),111+int(rand(0,19)),54,255),width=int(rand(3,6)))
        for j in range(3):
            s=.26+j*.25;direction=(-1)**(i+j);x=rx+(ex-rx)*s+direction*rand(6,16);y=ry+(ey-ry)*s
            stamp(im,leaves[(i+j)%5],x,y,rand(19,44),rand(35,67),direction*rand(29,69))
        if i>=rep:continue
        tall=style in (3,6,10); count=int(rand(3,7) if tall else rand(2,4))
        for k in range(count):
            cx=ex+rand(-12,12);cy=ey-(k*5 if tall else rand(-6,5))
            col=palette[style]
            sprite=parts[col][rng.integers(len(parts[col]))]
            s=rand(8,17) if tall else rand(13,26)
            if style in (3,6):
                a=np.asarray(sprite).copy();a[:,:,0]=(a[:,:,0].astype(float)*.86).astype('uint8'); a[:,:,2]=np.minimum(255,a[:,:,2].astype(float)*1.10).astype('uint8');sprite=Image.fromarray(a)
            stamp(im,sprite,cx,cy,s*rand(.85,1.3),s,rand(-45,45))
    # Keep a transparent guard for anisotropic filtering and the smaller mip levels.
    box=im.getbbox()
    if box:
        cleaned=im.crop(box);cleaned.thumbnail((242,241),RES.LANCZOS)
        im=Image.new('RGBA',(256,256));im.alpha_composite(cleaned,((256-cleaned.width)//2,248-cleaned.height))
    return im


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('reference',type=Path);ap.add_argument('output',type=Path)
    args=ap.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    with Image.open(args.reference) as image:
        src=image.convert('RGB')
    parts={kind:blossoms(src,kind) for kind in ('cream','gold','pink')}
    if any(not p for p in parts.values()):raise ValueError('No usable foreground blossom samples')
    atlas=Image.new('RGBA',(1024,768))
    for i in range(12):atlas.paste(plant(src,parts,i),(i%4*256,i//4*256))
    atlas.save(args.output/'border-atlas.png',optimize=True)
    print('Source blossoms:',{k: len(v) for k,v in parts.items()})


if __name__=='__main__':main()
