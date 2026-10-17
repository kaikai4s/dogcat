"""Prepare the supplied girl art as registered transparent game sprites.

No image service is used: original outfit/head/shoes are raster cutouts;
two-bone articulation supplies the missing alternating leg poses. The entire
torso, arms, waistband and skirt stay on one continuous deformation surface.
"""
from pathlib import Path
import argparse
import json
import math
import zipfile
import numpy as np
from PIL import Image, ImageDraw, ImageChops, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
N = 512


def keyed(path):
    im = Image.open(path).convert('RGBA')
    a = np.array(im)
    rgb = a[:, :, :3].astype(np.float32)
    green = rgb[:, :, 1] - np.maximum(rgb[:, :, 0], rgb[:, :, 2])
    opacity = 1 - np.clip((green - 1)/8, 0, 1)
    # Yellow-green antialiasing can have R > G. Remove that spill only in an
    # exterior band, preserving all opaque cream fabric and white shoe pixels.
    solid = Image.fromarray(np.where(opacity > .01,255,0).astype('uint8'))
    band = (np.asarray(solid.filter(ImageFilter.MinFilter(7))) == 0) & (opacity > 0)
    spill = rgb[:,:,1]-(rgb[:,:,0]+rgb[:,:,2])/2
    opacity[band] = np.minimum(opacity[band],1-np.clip((spill[band]-10)/10,0,1))
    opacity[(~band) & (opacity > .1)] = 1
    a[:, :, 3] = np.rint(opacity*255).astype('uint8')
    edge = (opacity > 0) & (opacity < 1)
    # Replace semitransparent edge RGB with nearby solid foreground RGB instead
    # of retaining the green backdrop under transparent pixels.
    weight = np.where(opacity > .99,1,0).astype(np.float32)
    guide = Image.fromarray(np.rint(rgb*weight[:,:,None]).astype('uint8')).filter(ImageFilter.GaussianBlur(1.6))
    w = np.asarray(Image.fromarray(np.rint(weight*255).astype('uint8')).filter(ImageFilter.GaussianBlur(1.6))).astype(np.float32)/255
    foreground = np.asarray(guide).astype(np.float32)/np.maximum(w[:,:,None],.01)
    a[:,:,:3][edge] = np.rint(np.clip(foreground[edge],0,255)).astype('uint8')
    a[opacity == 0, :3] = 0
    return Image.fromarray(a)


def clean(im, seed):
    alpha = im.getchannel('A')
    m = alpha.point(lambda v:255 if v > 12 else 0)
    ImageDraw.floodfill(m, seed, 128)
    im.putalpha(ImageChops.multiply(alpha, m.point(lambda v:255 if v == 128 else 0)))
    return im


def registered(im, scale=None):
    im = im.crop(im.getbbox())
    head = np.asarray(im)[:round(im.height*.3), :, 3] > 127
    xs = np.where(head)[1]
    center = (xs.min()+xs.max()+1)/2
    scale = scale or 430/im.height
    out = Image.new('RGBA', (N,N))
    sized = im.resize((round(im.width*scale),round(im.height*scale)),Image.Resampling.LANCZOS)
    out.alpha_composite(sized,(round(256-center*scale),460-sized.height))
    return out


def masked(im, points):
    m = Image.new('L',im.size)
    ImageDraw.Draw(m).polygon(points,fill=255)
    o = im.copy()
    o.putalpha(ImageChops.multiply(o.getchannel('A'),m))
    return o


def sample(layer, sx, sy):
    sx, sy = np.clip(sx,0,510.999),np.clip(sy,0,510.999)
    x0,y0 = np.floor(sx).astype(int),np.floor(sy).astype(int)
    fx,fy = (sx-x0)[...,None],(sy-y0)[...,None]
    a = np.asarray(layer).astype(np.float32)/255
    a[:,:,:3] *= a[:,:,3:4]
    o = (a[y0,x0]*(1-fx)*(1-fy)+a[y0,x0+1]*fx*(1-fy)
         +a[y0+1,x0]*(1-fx)*fy+a[y0+1,x0+1]*fx*fy)
    o[:,:,:3] /= np.maximum(o[:,:,3:4],1e-6)
    return Image.fromarray(np.rint(np.clip(o,0,1)*255).astype('uint8'))


def normalize_body(layer, action):
    yy,xx = np.indices((N,N),dtype=np.float32)
    if action == 'walk':
        sy = np.interp(yy,[0,171,251,345,512],[0,190,270,360,512])
        sx = (xx-24)/.94
    else:
        sy = np.interp(yy,[-5,175,250,345,512],[0,200,280,360,512])
        sx = (xx-35)/.92
    return sample(layer,sx,sy)


def smooth(v):
    v = np.clip(v,0,1)
    return v*v*(3-2*v)


def upper(layer, phase, bob, running):
    yy,xx = np.indices((N,N),dtype=np.float32)
    sx,sy = xx.copy(),yy-bob
    for _ in range(5):
        skirt = smooth((sy-251)/90)
        # The waist remains exactly attached; motion increases toward the hem.
        dx = math.sin(phase)*(4.5 if running else 3)*skirt
        arms = smooth((sy-192)/45)*(1-smooth((sy-282)/35)) if running else smooth((sy-207)/80)*(1-smooth((sy-317)/25))
        left,right = smooth((214-sx)/25),smooth((sx-282)/24)
        dx += math.cos(phase)*(10 if running else 6)*(right-left)*arms
        dy = math.sin(phase)*(5 if running else 2)*(right-left)*arms
        tail = smooth((sx-301)/28)*smooth((sy-86)/65)*(1-smooth((sy-191)/28))
        dx += math.sin(phase-.7)*(6 if running else 3)*tail
        dy += math.cos(phase-.7)*(3.5 if running else 1.5)*tail
        lean = smooth((255-sy)/150)*(3 if running else .5)
        sx,sy = xx-dx+lean,yy-bob-dy
    return sample(layer,sx,sy)


def transform_bone(layer, a, b, c, d):
    v,n = np.array(b,float)-a,np.array(d,float)-c
    u,w = v/np.linalg.norm(v),n/np.linalg.norm(n)
    src = np.column_stack((u,[-u[1],u[0]]))
    dst = np.column_stack((w*np.linalg.norm(n)/np.linalg.norm(v),[-w[1],w[0]]))
    m = src@np.linalg.inv(dst)
    t = np.array(a)-m@c
    return layer.transform((N,N),Image.Transform.AFFINE,
        (m[0,0],m[0,1],t[0],m[1,0],m[1,1],t[1]),Image.Resampling.BICUBIC)


def shoe_move(layer, start, end, angle):
    angle = math.radians(angle)
    c,s = math.cos(angle),math.sin(angle)
    return layer.transform((N,N),Image.Transform.AFFINE,
        (c,s,start[0]-c*end[0]-s*end[1],-s,c,start[1]+s*end[0]-c*end[1]),Image.Resampling.BICUBIC)


def solve_knee(hip, ankle, thigh, shin):
    dx,dy = ankle[0]-hip[0],ankle[1]-hip[1]
    length = math.hypot(dx,dy)
    # Keep physically reachable endpoints; a shoe must not detach from its calf.
    if length > thigh+shin-.1:
        r = (thigh+shin-.1)/length
        ankle = (hip[0]+dx*r,hip[1]+dy*r)
        dx,dy = ankle[0]-hip[0],ankle[1]-hip[1]
        length = math.hypot(dx,dy)
    a = (thigh*thigh-shin*shin+length*length)/(2*length)
    h = math.sqrt(max(0,thigh*thigh-a*a))
    return ((hip[0]+dx/length*a-dy/length*h,hip[1]+dy/length*a+dx/length*h),ankle)


def thigh_layer(hip, knee, near):
    # Painted joint overlap stays behind the original skirt and original socks.
    o = Image.new('RGBA',(N,N))
    d = ImageDraw.Draw(o)
    radius = 12 if near else 11
    color = (253,218,185,255) if near else (240,199,166,255)
    outline = (117,77,55,255)
    d.line([hip,knee],fill=outline,width=2*radius+2)
    for p in (hip,knee):d.ellipse((p[0]-radius-1,p[1]-radius-1,p[0]+radius+1,p[1]+radius+1),fill=outline)
    d.line([hip,knee],fill=color,width=2*radius)
    for p in (hip,knee):d.ellipse((p[0]-radius,p[1]-radius,p[0]+radius,p[1]+radius),fill=color)
    return o


def foot_path(q, running, near):
    if running:
        stance = .38
        if q < stance:
            dx = 37*(-1+2*q/stance)
            lift = 0
        else:
            u = (q-stance)/(1-stance)
            dx = 37*math.cos(math.pi*u)
            lift = 49*math.sin(math.pi*u)**1.2
        y = (415 if near else 399)-.52*dx-lift
    else:
        dx = -25*math.cos(2*math.pi*q)
        lift = 14*max(0,-math.sin(2*math.pi*q))
        y = (422 if near else 407)-.52*dx-lift
    return ((269 if near else 232)+dx,y),lift


def animate(body, idle, running):
    calves = [
        masked(idle,[(216,365),(245,365),(251,417),(215,420)]),
        masked(idle,[(251,376),(283,376),(291,434),(252,436)])]
    shoes = [
        masked(idle,[(216,408),(246,408),(253,421),(249,433),(221,445),(187,441),(185,425),(202,414)]),
        masked(idle,[(256,422),(283,422),(294,437),(285,453),(258,464),(232,455),(230,440),(242,430)])]
    # Narrow masks can graze a neighboring leg. Remove those detached slivers
    # before articulation rather than carrying them as extra shoe fragments.
    calves = [clean(calves[0],(232,390)),clean(calves[1],(270,405))]
    shoes = [clean(shoes[0],(215,430)),clean(shoes[1],(260,445))]
    knees0,ankles0 = [(232,370),(268,380)],[(232,418),(270,432)]
    frames = []
    for i in range(12):
        t = 2*math.pi*i/12
        bob = (-3-5*math.cos(2*(t-2*math.pi*.44))) if running else -1.5*(1-math.cos(2*t))
        frame = Image.new('RGBA',(N,N))
        for j in (0,1):
            q = (i/12+(.5 if j == 0 else 0))%1
            ankle,lift = foot_path(q,running,j == 1)
            hip = ((232 if j == 0 else 269),(330 if j == 0 else 337)+bob)
            knee,ankle = solve_knee(hip,ankle,52 if running else 45,60 if running else 56)
            frame.alpha_composite(thigh_layer(hip,knee,j == 1))
            frame.alpha_composite(transform_bone(calves[j],knees0[j],ankles0[j],knee,ankle))
            frame.alpha_composite(shoe_move(shoes[j],ankles0[j],ankle,-20*lift/49 if running else -9*lift/14))
        frame.alpha_composite(upper(body,t,bob,running))
        frames.append(clean(frame,(240,100)))
    return frames


def export_action(frames, out, action):
    folder = out/action
    folder.mkdir()
    for size in (512,256):
        d = folder/f'frames-{size}'
        d.mkdir()
        atlas = Image.new('RGBA',(size*4,size*3))
        mapping = {}
        for i,frame in enumerate(frames):
            im = frame.resize((size,size),Image.Resampling.LANCZOS)
            name = f'girl-{action}-sw-{i+1:02d}.png'
            im.save(d/name,optimize=True)
            x,y = i%4*size,i//4*size
            atlas.alpha_composite(im,(x,y))
            mapping[name] = {'frame':{'x':x,'y':y,'w':size,'h':size},'pivot':{'x':.5,'y':460/512}}
        path = out/f'{action}-sw.png' if size == 256 else folder/f'{action}-sw-512.png'
        atlas.save(path,optimize=True)
        (path.with_suffix('.json')).write_text(json.dumps({'frames':mapping,'meta':{'image':path.name,
            'size':{'w':size*4,'h':size*3}},'animation':{'frames':12,'fps':18 if action == 'run' else 12,
            'loop':True,'columns':4,'rows':3,'anchor':[size/2,size*460/512]}},indent=2),encoding='utf-8')
    contact = Image.new('RGB',(1024,870),(232,236,241))
    preview = []
    for i,frame in enumerate(frames):
        im = frame.resize((256,256),Image.Resampling.LANCZOS)
        x,y = i%4*256,i//4*290
        contact.paste(im,(x,y),im)
        ImageDraw.Draw(contact).text((x+12,y+265),f'{i+1:02d}',fill=(36,48,64))
        bg = Image.new('RGB',(256,256),(232,236,241));bg.paste(im,(0,0),im);preview.append(bg)
    contact.save(folder/'contact-sheet.jpg',quality=96)
    palette = contact.quantize(colors=255)
    preview = [p.quantize(palette=palette,dither=Image.Dither.NONE) for p in preview]
    preview[0].save(out/f'{action}-preview.gif',save_all=True,append_images=preview[1:],
                   duration=([60,50,60,50,60,50,60,50,60,50,60,60] if action == 'run' else [80,80,90]*4),loop=0,disposal=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir',type=Path,default=Path.home()/'Downloads')
    parser.add_argument('--output',type=Path,default=ROOT/'output/girl-character-sw')
    args = parser.parse_args()
    out = args.output
    out.mkdir(parents=True,exist_ok=False)
    idle = registered(clean(keyed(args.source_dir/'豆包 (62).png'),(1000,400)))
    walk = keyed(args.source_dir/'豆包 (63).png').crop((233,78,540,696))
    walk = registered(clean(walk,(140,100)),430/622)
    run = keyed(args.source_dir/'豆包 (65).png').crop((298,113,644,685))
    run = registered(clean(run,(140,100)),430/581)
    walk = masked(walk,[(0,0),(512,0),(512,321),(310,321),(303,344),(276,355),
                        (247,360),(217,359),(189,352),(167,339),(0,322)])
    run = masked(run,[(0,0),(512,0),(512,327),(320,327),(307,344),(280,355),
                      (247,366),(214,363),(185,354),(159,338),(0,327)])
    walk,run = normalize_body(walk,'walk'),normalize_body(run,'run')
    idle.save(out/'idle-sw.png',optimize=True)
    idle.resize((256,256),Image.Resampling.LANCZOS).save(out/'idle-sw-256.png',optimize=True)
    idle.save(out/'idle-source-512.png',optimize=True)
    walk.save(out/'walk-body.png',optimize=True)
    run.save(out/'run-body.png',optimize=True)
    for name,body in [('walk',walk),('run',run)]:
        frames = animate(body,idle,name == 'run')
        export_action(frames,out,name)
    (out/'manifest.json').write_text(json.dumps({'character':'girl','direction':'sw as supplied',
        'sourceFiles':['豆包 (62).png','豆包 (63).png','豆包 (65).png'],
        'method':'Local raster extraction, continuous intact outfit deformation and two-bone leg articulation; no AI redraw.',
        'idle':{'file':'idle-sw.png','size':[512,512]},
        'walk':{'file':'walk-sw.png','frames':12,'columns':4,'rows':3,'cell':[256,256],'fps':12},
        'run':{'file':'run-sw.png','frames':12,'columns':4,'rows':3,'cell':[256,256],'fps':18},
        'anchor512':[256,460],'anchor256':[128,230],
        'note':'Current game still uses the boy. Upload the three root PNGs, then configure the selected character.'},
        ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'使用说明.txt').write_text('女孩左前方素材，待机、行走、跑步。\n'
        '上传云端只需 idle-sw.png、walk-sw.png、run-sw.png 三张。\n'
        '待机512×512，行走/跑步各12帧，4列3行，每格256×256；锚点(128,230)。\n'
        '行走建议12帧/秒，跑步18帧/秒；游戏中应按实际移动距离推进相位。\n'
        'walk/run文件夹保留256与512单帧、512图集及检查总览。JSON给出帧位置。\n'
        '基于原图抠图和关节变形，非AI逐帧重绘；上衣与裙子连续保留，避免腰部挖空。\n'
        '当前项目角色仍是男孩；本次仅交付女孩素材，尚未上传云端或替换游戏角色。\n',encoding='utf-8')
    print(out)


if __name__ == '__main__':
    main()
