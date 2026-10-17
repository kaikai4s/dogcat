"""Build a registered run cycle from the user's raster art (no external API).

The hoodie remains a single continuous surface. Two-bone leg articulation
provides a planted stance, knee recovery and two flight phases per cycle.
"""
from pathlib import Path
import importlib.util
import math
import json
import numpy as np
from PIL import Image, ImageDraw, ImageChops

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/boy-run-sw'
spec = importlib.util.spec_from_file_location('walk', Path(__file__).with_name('animate-boy-walk.py'))
walk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walk)


def knee_between(hip, ankle, thigh=52, shin=61):
    dx, dy = ankle[0] - hip[0], ankle[1] - hip[1]
    d = max(1, math.hypot(dx, dy))
    a = (thigh * thigh - shin * shin + d * d) / (2 * d)
    h = math.sqrt(max(0, thigh * thigh - a * a))
    return (hip[0] + dx / d * a - dy / d * h,
            hip[1] + dy / d * a + dx / d * h)


def upper_leg(canvas, hip, knee, near):
    """Paint the changing thigh silhouette; no rectangular texture cut edges."""
    dx, dy = knee[0]-hip[0], knee[1]-hip[1]
    length = math.hypot(dx, dy)
    nx, ny = -dy/length, dx/length
    cuff = (hip[0]+dx*.79, hip[1]+dy*.79)
    d = ImageDraw.Draw(canvas)
    skin = (249, 210, 169, 255) if near else (235, 190, 147, 255)
    outline = (105, 77, 53, 255)
    d.line([hip,knee], fill=outline, width=26 if near else 24)
    d.line([hip,knee], fill=skin, width=23 if near else 21)
    width = 19 if near else 17
    points=[(hip[0]+nx*width,hip[1]+ny*width),
            (hip[0]-nx*width,hip[1]-ny*width),
            (cuff[0]-nx*14,cuff[1]-ny*14),
            (cuff[0]+nx*14,cuff[1]+ny*14)]
    d.polygon(points, fill=(245, 222, 179, 255) if near else (228,204,161,255))
    d.line(points+[points[0]],fill=outline,width=2)
    # Narrow shaded side and a stitched hem follow the rotating leg.
    d.polygon([points[0],points[3],(cuff[0]+nx*9,cuff[1]+ny*9),
               (hip[0]+nx*(width-5),hip[1]+ny*(width-5))],fill=(220,194,151,255))
    d.line([(cuff[0]-nx*13-dx*.07,cuff[1]-ny*13-dy*.07),
            (cuff[0]+nx*13-dx*.07,cuff[1]+ny*13-dy*.07)],fill=(203,177,136,255),width=1)


def lower_leg(canvas, knee, ankle, near):
    d = ImageDraw.Draw(canvas)
    radius = 11 if near else 10
    outline = (111, 78, 55, 255)
    skin = (249, 210, 169, 255) if near else (235, 190, 147, 255)
    d.line([knee, ankle], fill=outline, width=2*radius+2)
    d.ellipse((knee[0]-radius-1,knee[1]-radius-1,knee[0]+radius+1,knee[1]+radius+1),fill=outline)
    d.line([knee, ankle], fill=skin, width=2*radius)
    d.ellipse((knee[0]-radius,knee[1]-radius,knee[0]+radius,knee[1]+radius),fill=skin)
    # A white ankle sock sits inside the shoe's original raster cuff.
    sock=(ankle[0]+(knee[0]-ankle[0])*.26,ankle[1]+(knee[1]-ankle[1])*.26)
    d.line([sock,ankle],fill=(248,248,238,255),width=2*radius)


def upper_warp(layer, phase, bob):
    yy, xx = np.indices((512, 512), dtype=np.float32)
    sy = yy - bob
    # Modest forward lean about the waist; shoulder and bent arm counter-swing.
    sx = xx + np.clip((300 - sy) / 150, 0, 1) * 5
    weight = np.clip((sy - 185) / 45, 0, 1) * np.clip((295 - sy) / 35, 0, 1)
    side = np.tanh((xx-235)/25)
    sx -= np.sin(phase) * weight * (1+8*side)
    sy += np.sin(phase) * weight * (.5+4.5*side)
    x0 = np.floor(np.clip(sx, 0, 510)).astype(int)
    y0 = np.floor(np.clip(sy, 0, 510)).astype(int)
    fx = np.clip(sx - x0, 0, 1)[..., None]
    fy = np.clip(sy - y0, 0, 1)[..., None]
    a = np.asarray(layer).astype(float) / 255
    a[:, :, :3] *= a[:, :, 3:4]
    o = (a[y0, x0]*(1-fx)*(1-fy) + a[y0, x0+1]*fx*(1-fy)
         + a[y0+1, x0]*(1-fx)*fy + a[y0+1, x0+1]*fx*fy)
    o[:, :, :3] /= np.maximum(o[:, :, 3:4], 1e-6)
    return Image.fromarray(np.rint(np.clip(o, 0, 1)*255).astype('uint8'))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    source = Image.open(walk.SOURCE).convert('RGBA')
    mask = source.getchannel('A').point(lambda x: 255 if x > 12 else 0)
    ImageDraw.floodfill(mask, (256, 125), 128)
    source.putalpha(ImageChops.multiply(source.getchannel('A'), mask.point(lambda x: 255 if x == 128 else 0)))
    # Extract this bent-arm reference with prepare-boy-walk.py first.
    run = Image.open(ROOT/'output/boy-run-source/frames-512/boy-walk-sw-02.png').convert('RGBA')
    mask = run.getchannel('A').point(lambda x:255 if x>20 else 0)
    ImageDraw.floodfill(mask, (250,120), 128)
    run.putalpha(ImageChops.multiply(run.getchannel('A'),mask.point(lambda x:255 if x==128 else 0)))
    run = run.transform((512,512),Image.Transform.AFFINE,
                        (1/1.08,0,25.8/1.08,0,1/1.08,56.4/1.08),Image.Resampling.BICUBIC)
    # Use the same face/head as idle and walking, with the reference's bent arms.
    torso = walk.masked(run, [(0,170),(512,170),(512,292),(304,292),(302,314),(220,318),(0,292)])
    torso.alpha_composite(walk.masked(source, [(0, 0), (512, 0), (512, 166),
                                             (292, 166), (275, 178), (227, 178), (210, 166), (0, 166)]))
    shoes = [walk.masked(source, [(217,382),(251,382),(260,407),(256,423),(211,437),(185,433),(183,414),(202,397)]),
             walk.masked(source, [(269,406),(299,405),(311,428),(306,448),(285,463),(249,460),(247,443),(255,422)])]
    frames = []
    for i in range(12):
        phase = 2*math.pi*i/12
        # Down at support, up at mid-flight. All frames use one ground anchor.
        bob = -6*(1-math.cos(2*phase))
        canvas = Image.new('RGBA', (512,512))
        for j in (0,1):
            p = phase + (math.pi if j == 0 else 0)
            swing = max(0, -math.sin(p))
            hip0 = (232,309) if j == 0 else (273,315)
            knee0 = (235,343) if j == 0 else (280,352)
            ankle0 = (236,390) if j == 0 else (284,414)
            hip = (hip0[0], hip0[1]+bob)
            ankle = (ankle0[0]-42*math.cos(p), (386 if j == 0 else 405)+22*math.cos(p)-58*swing)
            knee = knee_between(hip, ankle)
            lower_leg(canvas, knee, ankle, j == 1)
            upper_leg(canvas, hip, knee, j == 1)
            canvas.alpha_composite(walk.move(shoes[j], ankle0, ankle, -24*swing + 8*math.cos(p)))
        pelvis=Image.new('RGBA',(512,512))
        d=ImageDraw.Draw(pelvis)
        points=[(220,294),(302,290),(298,318),(278,335),(258,324),(232,329)]
        points=[(x,y+bob) for x,y in points]
        d.polygon(points,fill=(245,222,179,255))
        d.line(points+[points[0]],fill=(105,77,53,255),width=2)
        d.line([(259,307+bob),(258,324+bob)],fill=(182,151,112,255),width=1)
        canvas.alpha_composite(pelvis)
        canvas.alpha_composite(upper_warp(torso, phase, bob))
        frames.append(canvas)
    for size in (512,256):
        folder = OUT/f'frames-{size}'
        folder.mkdir(exist_ok=True)
        atlas = Image.new('RGBA', (size*4,size*3))
        for i, frame in enumerate(frames):
            im = frame.resize((size,size),Image.Resampling.LANCZOS)
            im.save(folder/f'boy-run-sw-{i+1:02d}.png',optimize=True)
            atlas.alpha_composite(im,(i%4*size,i//4*size))
        atlas.save(OUT/f'run-sw-{size}.png',optimize=True)
        if size == 256:
            # Cloud upload export stays outside the miniprogram package.
            atlas.quantize(colors=256,method=Image.Quantize.FASTOCTREE).save(
                OUT/'run-sw.png', optimize=True)
    contact=Image.new('RGB',(1024,870),(232,236,241))
    preview=[]
    for i, frame in enumerate(frames):
        im=frame.resize((256,256),Image.Resampling.LANCZOS)
        contact.paste(im,(i%4*256,i//4*290),im)
        ImageDraw.Draw(contact).text((i%4*256+12,i//4*290+265),str(i+1),fill='black')
        bg=Image.new('RGB',(256,256),(232,236,241));bg.paste(im,(0,0),im);preview.append(bg)
    contact.save(OUT/'contact-sheet.jpg',quality=96)
    palette=contact.quantize(colors=255)
    preview=[p.quantize(palette=palette,dither=Image.Dither.NONE) for p in preview]
    preview[0].save(OUT/'run-preview.gif',save_all=True,append_images=preview[1:],duration=60,loop=0,disposal=2)
    (OUT/'manifest.json').write_text(json.dumps({'frames':12,'columns':4,'rows':3,'anchor':[256,460],
        'method':'Original raster rig; two-bone legs and continuous intact torso warp',
        'strideWorldUnits':9.5,'reference':'Downloads/豆包 (61).png'},ensure_ascii=False,indent=2),encoding='utf-8')
    print(OUT)


if __name__ == '__main__':
    main()
