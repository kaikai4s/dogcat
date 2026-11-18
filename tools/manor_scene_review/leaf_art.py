"""Build a single portable leaf atlas with oak, orchard, cherry and birch branches."""
import argparse
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw


FILTER = getattr(Image, 'Resampling', Image)
SIZE = 256
REGIONS = [(1029, 370, 1080, 413), (27, 311, 76, 348),
           (14, 381, 55, 428), (24, 568, 74, 612)]


def leaf(kind, source, rng, bright):
    h,w=85,55
    row,col=np.mgrid[0:h,0:w]
    t=(row+0.5)/h
    shift=0.07*np.sin(t*5+rng.uniform(0,2))
    x=(col+.5)/w*2-1-shift
    if kind==0:
        outline=np.sin(np.pi*t)**.72*(.65+.16*np.cos(t*7.3*np.pi)+.086*np.cos(t*13*np.pi))
    elif kind==3:
        outline=np.minimum((t+.01)*2.60,(1-t)*1.64)**.83*(.87+.07*np.cos(42*np.pi*t))
    else:
        outline=np.sin(np.pi*t)**.81*(.81+.045*np.sin(36*np.pi*t))
    alpha=np.clip((outline-abs(x))*w*.76+.5,0,1)
    cut=source.resize((w,h),FILTER.BICUBIC)
    detail=np.asarray(cut,dtype='float32').mean(2);detail-=np.median(detail)
    sample=[np.array([104,148,68]),np.array([122,151,63]),np.array([100,133,67]),np.array([155,177,88])][kind]
    # Fine ribs on the sunny half; a cooler adjacent half makes individual leaves read in groups.
    ribs=np.cos(2*np.pi*(t*6.8-np.abs(x)*1.12))**14
    value=np.clip(.89-.10*t+.09*(-x)+np.where(x<0,.07,-.08)+detail*.00115+ribs*.033,.59,1.19)
    value+=np.exp(-abs(x)*43)*.12
    color=np.clip(sample[None,None,:]*value[:,:,None]*bright+rng.uniform(-4,4,3),0,255)
    return Image.fromarray(np.dstack((color.astype('uint8'),(alpha*255).astype('uint8'))))


def blossom(src,rng):
    s=85
    yy,xx=np.mgrid[:s,:s];x=(xx-s/2)/(s*.49);y=(yy-s/2)/(s*.49)
    phase=rng.uniform(0,2*np.pi);r=np.hypot(x,y);ang=np.arctan2(y,x)
    folded=(((ang-phase+np.pi/5)%(2*np.pi/5))-np.pi/5)
    shape=(.56+.36*np.cos(2.5*folded)**1.75)-.08*np.exp(-(folded/.06)**2)
    alpha=np.clip((shape-r)*49+.5,0,1)
    source=np.asarray(src.resize((s,s),FILTER.BICUBIC),dtype='float32')
    grain=(source.mean(2)-145)*.095
    t=np.clip(r*1.31,0,1)
    petal=np.array([198,117,147])+t[:,:,None]*np.array([53,98,74])
    petal+=grain[:,:,None]+np.cos(folded*7)[:,:,None]*3
    centers=(r<.15);petal[centers]=np.array([227,171,86])+np.minimum(1,r[centers,None]/.14)*np.array([18,28,22])
    return Image.fromarray(np.dstack((np.clip(petal,0,255).astype('uint8'),(alpha*255).astype('uint8'))))


def stamp(im,piece,at,length,width,angle):
    elem=piece.resize((max(2,round(width)),max(2,round(length))),FILTER.LANCZOS)
    elem=elem.rotate(angle,FILTER.BICUBIC,expand=True)
    im.alpha_composite(elem,(round(at[0]-elem.width/2),round(at[1]-elem.height/2)))


def branch_tile(kind,src,index):
    rng=np.random.default_rng(6163+kind*41+index)
    im=Image.new('RGBA',(SIZE,SIZE));stem=ImageDraw.Draw(im)
    leaves=[leaf(kind,src,rng,x) for x in [.77,.88,.98,1.07,1.19]]
    flowers=[blossom(src,rng) for _ in range(6)] if kind==2 else []
    draw=[]
    root=np.array([rng.uniform(111,143),234.])
    for j in range(4):
        tip=np.array([np.clip((j+.50+rng.uniform(-.28,.28))*54+17,29,224),rng.uniform(30,82)+abs(j-1.5)*15])
        curve=(tip+root)*.5+np.array([rng.uniform(-30,30),rng.uniform(14,32)])
        coords=[]
        for q in np.linspace(0,1,21):
            coords.append(tuple((1-q)**2*root+2*(1-q)*q*curve+q*q*tip))
        stem.line(coords,fill=(97,96,61,255),width=3)
        stem.line(coords[7:],fill=(119,119,73,255),width=2)
        for i in range(10 if kind!=3 else 13):
            q=.19+.076*i if kind!=3 else .14+.064*i
            base=(1-q)**2*root+2*(1-q)*q*curve+q*q*tip
            direction=(1-q)*(curve-root)+q*(tip-curve)
            direction/=np.linalg.norm(direction)
            ortho=np.array([-direction[1],direction[0]])*(1 if (j+i)%2 else -1)
            axis=direction*rng.uniform(.35,.83)+ortho*rng.uniform(.70,1.01);axis/=np.linalg.norm(axis)
            length=rng.uniform(32,55)*(1-.20*q)*(.80 if kind==3 else 1)
            center=base+axis*length*.46
            a=np.degrees(np.arctan2(-axis[0],-axis[1]))
            shade=int(np.clip(np.floor(q*2.25+rng.uniform(0,2.8)),0,4))
            if kind==2 and rng.random()<.79:
                for n in range(2 if i%2 else 3):
                    pt=center+np.array([rng.uniform(-9,9),rng.uniform(-8,9)])
                    size=rng.uniform(16,28)*(1-.13*q)
                    draw.append((shade,flowers[(i+n+j)%len(flowers)],pt,size,size*rng.uniform(.79,1.03),a+n*32))
                if i%3:continue
            draw.append((shade,leaves[shade],center,length,length*rng.uniform(.48,.70),a))
    for _,piece,at,h,w,a in sorted(draw,key=lambda d:d[0]):
        stamp(im,piece,at,h,w,a)
    # Do not leave black RGB behind transparent edges: averaging into the
    # smaller mip levels would otherwise surround distant crowns with dark specks.
    a=np.asarray(im).copy();alpha=a[:,:,3];rgb=a[:,:,:3].copy()
    for _ in range(4):
        wgt=cv2.blur((alpha>0).astype(np.float32),(3,3))
        mask=(alpha==0)&(wgt>0)
        if not mask.any():break
        out=cv2.blur(rgb.astype('float32')*(alpha>0)[:,:,None],(3,3))/np.maximum(.001,wgt[:,:,None])
        rgb[mask]=out[mask].clip(0,255).astype('uint8');alpha=np.maximum(alpha,mask.astype('uint8'))
    a[:,:,:3]=rgb
    return Image.fromarray(a)


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('reference',type=Path);ap.add_argument('output',type=Path)
    args=ap.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    atlas=Image.new('RGBA',(4*SIZE,4*SIZE))
    with Image.open(args.reference) as original:
        source=original.convert('RGB');scale=source.width/1100
        for row,box in enumerate(REGIONS):
            crop=source.crop(tuple(round(v*scale) for v in box))
            for col in range(4):
                atlas.paste(branch_tile(row,crop,col),(SIZE*col,SIZE*row))
    atlas.save(args.output/'leaf-sprays.png',optimize=True)


if __name__=='__main__':
    main()
