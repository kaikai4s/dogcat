"""Bake separate projective terrain and waterfall textures from the approved painting."""
import argparse
import re
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


W = 1344
F = .775


def envelope(name, xs):
    defs = Path(__file__).with_name('ridges.mjs').read_text()
    field = re.search(rf"const {name} = '([^']+)';", defs).group(1)
    pts = np.array([[int(k) for k in p.split(':')] for p in field.split()])
    return np.interp(xs, pts[:, 0], pts[:, 1])


def foothills(src, scale):
    # These source windows contain only woodland, pasture and rocky hillside.
    windows = [(5,107,78,141),(18,126,137,158),(226,122,308,154),
               (263,137,340,160),(18,144,102,164),(856,186,937,210),
               (884,162,948,186),(1116,127,1187,158),(1164,119,1242,153),
               (1228,113,1310,147),(1257,145,1338,172)]
    rng = np.random.default_rng(83107)
    sw,sh=2048,430
    total=np.zeros((sh,sw,3),np.float32); weights=np.zeros((sh,sw),np.float32)
    for row,cy0 in enumerate(range(-58,sh+90,65)):
        for col,cx0 in enumerate(range(-150,sw+170,138)):
            cx=cx0+(row%2)*67+rng.uniform(-21,21);cy=cy0+rng.uniform(-18,18)
            rw,rh=rng.uniform(111,157),rng.uniform(57,87)
            bx,by,ex,ey=max(0,int(cx-rw)),max(0,int(cy-rh)),min(sw,int(cx+rw+1)),min(sh,int(cy+rh+1))
            if bx>=ex or by>=ey:continue
            yy,xx=np.mgrid[by:ey,bx:ex];ux=(xx-cx)/rw;uy=(yy-cy)/rh
            sx,sy,x1,y1=windows[rng.integers(len(windows))];slope=rng.uniform(-.12,.12)
            uv=np.clip(.5+ux*(.43 if rng.random()<.5 else -.43)+.024*np.sin(5*uy+col),.01,.99)
            vv=np.clip(.5+uy*.40+ux*slope+.033*np.sin(4*ux+row),.01,.99)
            mx=(sx+(x1-sx)*uv)*scale;my=(sy+(y1-sy)*vv)*scale
            patch=cv2.remap(src,mx.astype('float32'),my.astype('float32'),cv2.INTER_LINEAR).astype(np.float32)
            # Blend the margins only, so the original individual tree crowns remain legible.
            w=np.minimum(np.clip((1-abs(ux))/.29,0,1),np.clip((1-abs(uy))/.36,0,1))
            w=w*w*(3-2*w);w=w.astype(np.float32)
            total[by:ey,bx:ex]+=patch*w[...,None];weights[by:ey,bx:ex]+=w
    output=total/np.maximum(weights[...,None],.001)
    yy,xx=np.mgrid[0:sh,0:sw];direction=yy+21*np.sin(xx*.006)+15*np.sin(xx*.016+2.)
    organic=.98+.043*np.sin(direction*.069+xx*.009)+.031*np.sin(direction*.087-xx*.013)
    output*=organic[...,None]
    return np.uint8(np.clip(output,0,255))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    src = np.asarray(Image.open(args.input).convert('RGB'))
    height, width = src.shape[:2]
    if abs(width / height - 16 / 9) > .005:
        raise ValueError('Image aspect ratio does not match the original composition')
    scale = width / W
    xx = np.arange(width) / scale
    top0 = envelope('CREST', xx) * scale
    low = envelope('CUT', xx) * scale

    # Follow continuous dark/green ridge edges within a narrow band around the
    # traced line. This prevents cloud pixels from making a blue or white rim.
    blurred = cv2.GaussianBlur(src.astype('float32'), (0, 0), 1.1)
    offsets = np.arange(-round(5.6 * scale), round(5.6 * scale)+1)
    y0 = np.round(top0[None, :] + offsets[:, None]).astype('int32')
    xi = np.arange(width)[None, :]
    above, below = blurred[y0-2, xi], blurred[y0+2, xi]
    delta = above-below
    edge = np.clip(delta.mean(axis=2), -12, 83) + np.clip(delta[..., 2]-delta[..., 1], -9, 46)*.5
    score = edge - np.abs(offsets[:, None]) * 1.25
    path = np.zeros(score.shape, dtype='int32')
    prev = score[:, 0]
    ids = np.arange(len(offsets))
    penalty = np.abs(ids[:, None]-ids[None, :]) * 4.5
    for x in range(1, width):
        candidates = prev[:, None] - penalty
        path[:, x] = np.argmax(candidates, axis=0)
        prev = candidates[path[:, x], ids] + score[:, x]
    idx = int(np.argmax(prev))
    curve = []
    for x in range(width-1, -1, -1):
        curve.append(idx)
        idx = path[idx, x]
    top = top0 + offsets[np.array(curve[::-1])] + 2.0 * scale

    # Only the visible moving water is transferred to the second mesh. Restore
    # the enclosed cliff surface beneath it so orbiting never reveals a double fall.
    polygon = [(1039,156.7),(1044.5,155.7),(1044.5,159.8),(1035.5,161.8),
               (1028,164.8),(1025.5,169),(1023.5,178),(1021.7,192),(1019.5,200),
               (1014.4,207.6),(1011.1,214.5),(1009.2,218),(1005,216.7),
               (1000.4,219.6),(997,220.7),(993,219.7),(988.4,220.4),
               (987.4,217.8),(989.5,212.4),(991.4,207),(992.4,198),
               (994.7,188),(997.3,178),(999.7,171),(1002,166.4),
               (1006.3,163.4),(1011,161.8),(1022,160.9),(1033.4,159.6)]
    mask = np.zeros(src.shape[:2], dtype='uint8')
    cv2.fillPoly(mask,[np.rint(np.array(polygon)*scale*8).astype('int32')],255,lineType=cv2.LINE_AA,shift=3)
    alpha = cv2.GaussianBlur(mask, (0, 0), scale*.62)

    sx = np.linspace(980*scale,1050*scale,192,dtype='float32')
    sy = np.linspace(154*scale,224*scale,208,dtype='float32')
    mx,my = np.meshgrid(sx,sy)
    def sample(a,x,y):
        return cv2.remap(a,x.astype('float32'),y.astype('float32'),cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
    rgba = np.dstack((sample(src,mx,my),sample(alpha,mx,my)))
    Image.fromarray(rgba).save(args.output/'ridge-waterfall.png',optimize=True)
    remove = cv2.dilate(mask,np.ones((7,7),'uint8'))
    cliff=src.copy()
    xa,xb=int(971*scale),int(1056*scale)
    ya,yb=int(147*scale),int(231*scale)
    region=src[ya:yb,xa:xb]
    color=cv2.inpaint(region,remove[ya:yb,xa:xb],round(scale*5),cv2.INPAINT_TELEA)
    # Borrow only high-frequency rock grain from an adjoining natural cliff.
    donor=src[ya:yb,xa-round(45*scale):xb-round(45*scale)].astype(float)
    grain=donor-cv2.GaussianBlur(donor,(0,0),scale*2)
    aa=(remove[ya:yb,xa:xb]/255)[...,None]
    cliff[ya:yb,xa:xb]=np.uint8(np.clip(color+grain*.51*aa,0,255))

    wtex,htex=2048,672
    xrow=np.linspace(0,width-1,wtex)
    crest=np.interp(xrow,np.arange(width),top)
    bottom=np.interp(xrow,np.arange(width),low)
    xvec,actual=np.meshgrid(xrow,np.linspace(0,438,htex))
    y=np.clip(actual*scale,crest[None,:],bottom[None,:])
    quilt=foothills(cliff,scale)
    route=(actual-131)*1.67+25+13*np.sin(xvec*.0042+actual*.011)
    route=np.clip(route,1,quilt.shape[0]-2)
    layer=sample(quilt,xvec/width*(quilt.shape[1]-1),route).astype(np.float32)
    lower=np.clip((actual-220)/145,0,1)[...,None]
    layer=layer*(1-lower*.25)+np.array([149.,170.,97.],np.float32)*lower*.25
    color=sample(cliff,xvec,y).astype('float32')
    overlap=7.8+2.1*np.sin(xvec*.014)+2.4*np.sin(xvec*.023)
    # Preserve the spray where the actual waterfall hits its plunge shelf.
    overlap-=6.9*np.exp(-((xvec/scale-1005)/27.)**2)
    a=np.clip((actual-bottom/scale+overlap)/(overlap+9),0,1);a=(a*a*(3-2*a))[...,None]
    out=np.uint8(np.clip(color*(1-a)+layer*a,0,255))
    Image.fromarray(out).save(args.output/'ridge-slopes.jpg',quality=94,subsampling=0,optimize=True)


if __name__ == '__main__':
    main()
