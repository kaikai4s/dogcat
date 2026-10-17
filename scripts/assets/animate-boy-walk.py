"""Make an alternating cutout walk cycle from the supplied neutral raster pose."""
from pathlib import Path
import math
import json
import zipfile
import numpy as np
from PIL import Image, ImageDraw, ImageChops

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/boy-walk-sw-v6'
SOURCE = ROOT / 'output/character-idle-sw/boy-idle-sw-512.png'


def masked(im, points):
    m = Image.new('L', im.size)
    ImageDraw.Draw(m).polygon(points, fill=255)
    out = im.copy()
    out.putalpha(ImageChops.multiply(im.getchannel('A'), m))
    return out


def move(layer, start, end, rotation=0, stretch=1):
    angle = math.radians(rotation)
    c, s = math.cos(angle), math.sin(angle)
    # Inverse affine about a source pivot, with the destination pivot translated.
    a,b,d,e = c/stretch,s/stretch,-s/stretch,c/stretch
    sx,sy=start
    tx,ty=end
    return layer.transform(layer.size, Image.Transform.AFFINE,
        (a,b,sx-a*tx-b*ty,d,e,sy-d*tx-e*ty),Image.Resampling.BICUBIC)


def segment(layer, start, finish, new_start, new_finish):
    vx,vy=finish[0]-start[0],finish[1]-start[1]
    nx,ny=new_finish[0]-new_start[0],new_finish[1]-new_start[1]
    degrees=math.degrees(math.atan2(ny,nx)-math.atan2(vy,vx))
    return move(layer,start,new_start,degrees,math.hypot(nx,ny)/math.hypot(vx,vy))


def sway_upper(layer, phase, bob):
    """Continuous inverse warp of the intact torso, sleeves and hands.

    Keep the torso as original opaque pixels; taper the arm displacement from
    shoulder to wrist. No cutout is subtracted from the source silhouette.
    """
    yy,xx=np.indices((512,512),dtype=np.float32)
    sy=yy-bob
    sx=xx.copy()
    def smooth(v):
        v=np.clip(v,0,1)
        return v*v*(3-2*v)
    distal=smooth((sy-210)/100)
    for _ in range(6):
        right=smooth((sx-278)/28)
        left=smooth((215-sx)/22)
        dx=(right*8-left*7)*math.cos(phase)*distal
        sx=xx-dx
    sx=np.clip(sx,0,511)
    sy=np.clip(sy,0,511)
    x0=np.floor(sx).astype(int); y0=np.floor(sy).astype(int)
    x1=np.minimum(x0+1,511); y1=np.minimum(y0+1,511)
    fx=(sx-x0)[...,None]; fy=(sy-y0)[...,None]
    a=np.array(layer).astype(np.float32)/255
    a[:,:,:3]*=a[:,:,3:4]
    sampled=(a[y0,x0]*(1-fx)*(1-fy)+a[y0,x1]*fx*(1-fy)
             +a[y1,x0]*(1-fx)*fy+a[y1,x1]*fx*fy)
    sampled[:,:,:3]/=np.maximum(sampled[:,:,3:4],1e-6)
    return Image.fromarray(np.rint(np.clip(sampled,0,1)*255).astype(np.uint8))


def extend_shin(layer, bounds, cutoff, color):
    """Extend skin under shorts; do not carry a second trouser hem on the shin."""
    a=np.array(layer)
    a[:cutoff,:,3]=0
    clean=Image.fromarray(a)
    patch=Image.new('RGBA',layer.size)
    d=ImageDraw.Draw(patch)
    x1,y1,x2,y2=bounds
    d.rectangle(bounds,fill=tuple(color))
    d.line([(x1,y1),(x1,y2)],fill=(82,58,45,255),width=1)
    d.line([(x2,y1),(x2,y2)],fill=(82,58,45,255),width=1)
    patch.alpha_composite(clean)
    return patch


def main():
    if OUT.exists(): raise SystemExit('Output already exists')
    OUT.mkdir(parents=True)
    source=Image.open(SOURCE).convert('RGBA')
    # Remove disconnected green-screen remnants while retaining antialiasing.
    connected=source.getchannel('A').point(lambda x:255 if x>12 else 0)
    ImageDraw.floodfill(connected,(256,125),128)
    source.putalpha(ImageChops.multiply(source.getchannel('A'),connected.point(lambda x:255 if x==128 else 0)))
    body=masked(source,[(0,0),(512,0),(512,334),(302,334),(299,350),
                        (269,358),(251,351),(248,343),(210,343),(0,333)])
    far_shin=masked(source,[(222,341),(248,341),(253,395),(223,402),(216,391)])
    far_shoe=masked(source,[(217,382),(251,382),(260,407),(256,423),(211,437),
                            (185,433),(183,414),(202,397)])
    near_shin=masked(source,[(261,350),(293,348),(301,419),(270,424)])
    near_shoe=masked(source,[(269,406),(299,405),(311,428),(306,448),
                             (285,463),(249,460),(247,443),(255,422)])
    far_shin=extend_shin(far_shin,(225,330,247,356),354,source.getpixel((235,359)))
    near_shin=extend_shin(near_shin,(267,336,292,368),366,source.getpixel((280,370)))
    # Preserve the complete original torso and arms; never punch out sleeves.
    frames=[]
    for i in range(12):
        t=2*math.pi*i/12
        bob=-1.5*(1-math.cos(2*t))
        canvas=Image.new('RGBA',(512,512))
        for near, phase, shin, shoe, knee, ankle in [
            (False,t+math.pi,far_shin,far_shoe,(235,342),(236,390)),
            (True,t,near_shin,near_shoe,(277,352),(284,414))]:
            progress=math.cos(phase)
            lift=max(0,math.sin(phase))
            dx=-27*progress
            dy=14*progress-17*lift
            new_knee=(knee[0]+dx*.38,knee[1]+bob-5*lift)
            new_ankle=(ankle[0]+dx,ankle[1]+dy)
            canvas.alpha_composite(segment(shin,knee,ankle,new_knee,new_ankle))
            # The shoe rolls a few degrees during swing and heel strike.
            canvas.alpha_composite(move(shoe,ankle,new_ankle,-9*lift+4*progress))
        canvas.alpha_composite(sway_upper(body,t,bob))
        frames.append(canvas)
    for size in (512,256):
        folder=OUT/f'frames-{size}'
        folder.mkdir()
        atlas=Image.new('RGBA',(size*4,size*3))
        mapping={}
        for i,frame in enumerate(frames):
            im=frame if size==512 else frame.resize((size,size),Image.Resampling.LANCZOS)
            name=f'boy-walk-sw-{i+1:02d}.png'
            im.save(folder/name,optimize=True)
            x,y=i%4*size,i//4*size
            atlas.alpha_composite(im,(x,y))
            mapping[name]={'frame':{'x':x,'y':y,'w':size,'h':size},'rotated':False,
                'trimmed':False,'sourceSize':{'w':size,'h':size},
                'spriteSourceSize':{'x':0,'y':0,'w':size,'h':size},
                'pivot':{'x':.5,'y':460/512}}
        name=f'boy-walk-sw-atlas-{size}'
        atlas.save(OUT/(name+'.png'),optimize=True)
        metadata={'frames':mapping,'meta':{'image':name+'.png','format':'RGBA8888',
            'size':{'w':size*4,'h':size*3},'scale':'1'},
            'animation':{'name':'boy-walk-sw','order':list(mapping),'fps':12,'loop':True}}
        (OUT/(name+'.json')).write_text(json.dumps(metadata,indent=2),encoding='utf-8')
    contact=Image.new('RGB',(1024,870),(232,236,241))
    preview=[]
    for i,im in enumerate(frames):
        im=im.resize((256,256),Image.Resampling.LANCZOS)
        contact.paste(im,(i%4*256,i//4*290),im)
        ImageDraw.Draw(contact).text((i%4*256+12,i//4*290+265),f'{i+1:02d}',fill=(36,48,64))
        bg=Image.new('RGB',(256,256),(232,236,241))
        bg.paste(im,(0,0),im)
        preview.append(bg)
    contact.save(OUT/'contact-sheet.jpg',quality=95)
    palette=contact.quantize(colors=255)
    preview=[p.quantize(palette=palette,dither=Image.Dither.NONE) for p in preview]
    preview[0].save(OUT/'walk-preview.gif',save_all=True,append_images=preview[1:],
        duration=[80,80,90]*4,loop=0,disposal=2,optimize=False)
    manifest={'source':str(SOURCE),'method':'Raster leg rig with continuous deformation of intact upper body',
        'frames':12,'fps':12,'anchor512':[256,460],
        'note':'Locally articulated original raster art; not AI redrawn animation.'}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    (OUT/'使用说明.txt').write_text('左前方行走，12帧，建议12帧/秒循环。\n'
        '由原始待机图制作左右腿交替、摆臂和轻微起伏；上半身保留完整原图，连续变形避免腰部切片缺口。\n'
        '独立透明PNG有256和512两个尺寸，图集为4列3行，JSON含帧坐标。\n'
        '512版固定角色锚点(256,460)，不要每帧重新裁紧或按透明边界居中。\n'
        '这是一套纸片关节动画，未通过AI补绘新的透视和遮挡细节。\n',encoding='utf-8')
    with zipfile.ZipFile(OUT.with_suffix('.zip'),'w',zipfile.ZIP_DEFLATED) as z:
        for p in OUT.rglob('*'):
            if p.is_file():z.write(p,p.relative_to(OUT))
    print(OUT)


if __name__=='__main__':main()
