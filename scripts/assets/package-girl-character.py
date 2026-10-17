"""Verify the prepared girl sprites and package them for manual cloud upload."""
from pathlib import Path
import hashlib
import json
import math
import shutil
import zipfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[2]/'output/girl-character-sw'


def main():
    out = OUT
    font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',20)
    small = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',12)
    idle = Image.open(out/'idle-sw.png').convert('RGBA')
    frames = {a:[Image.open(p).convert('RGBA') for p in sorted((out/a/'frames-512').glob('*.png'))] for a in ['walk','run']}
    report = []
    waist = Image.new('RGB',(1200,692),(232,236,241))
    for a,action in enumerate(['walk','run']):
        atlas = Image.open(out/f'{action}-sw.png').convert('RGBA')
        assert atlas.size == (1024,768)
        hashes = set()
        for i,im in enumerate(frames[action]):
            t = 2*math.pi*i/12
            bob = round((-3-5*math.cos(2*(t-2*math.pi*.44))) if action == 'run' else -1.5*(1-math.cos(2*t)))
            region = (239,238+bob,260,257+bob) if action == 'run' else (225,238+bob,266,258+bob)
            minimum = int(np.asarray(im.crop(region))[:,:,3].min())
            assert minimum == 255,(action,i,minimum)
            bounds = im.getbbox()
            assert bounds[0]>2 and bounds[1]>2 and bounds[2]<510 and bounds[3]<510
            assert im.getpixel((0,0))[3] == 0
            hashes.add(hashlib.sha256(im.tobytes()).hexdigest())
            x,y = i%4*256,i//4*256
            cell = np.asarray(atlas.crop((x,y,x+256,y+256)))
            single = np.asarray(Image.open(out/action/'frames-256'/f'girl-{action}-sw-{i+1:02d}.png').convert('RGBA'))
            # RGB in fully transparent pixels is irrelevant; visible pixels and
            # every alpha value must match the independently exported frame.
            assert np.array_equal(cell[:,:,3],single[:,:,3])
            assert np.array_equal(cell[:,:,:3][single[:,:,3]>0],single[:,:,:3][single[:,:,3]>0])
            mask = im.getchannel('A').point(lambda v:255 if v>32 else 0)
            ImageDraw.floodfill(mask,(240,100),128)
            islands = int((np.asarray(mask) == 255).sum())
            assert islands < 12
            crop = im.crop((180,224+bob,330,354+bob)).resize((200,173),Image.Resampling.LANCZOS)
            ox,oy = i%6*200,a*346+i//6*173
            waist.paste(crop,(ox,oy),crop)
            report.append({'action':action,'frame':i+1,'waistAlphaMin':minimum,
                           'isolatedAntialiasPixels':islands,'bounds':bounds})
        assert len(hashes) == 12
        contact = Image.open(out/action/'contact-sheet.jpg')
        palette = contact.quantize(colors=255)
        ims = []
        for im in frames[action]:
            fg = im.resize((256,256),Image.Resampling.LANCZOS)
            bg = Image.new('RGB',(256,256),(232,236,241));bg.paste(fg,(0,0),fg)
            ims.append(bg.quantize(palette=palette,dither=Image.Dither.NONE))
        durations = [60,50,60,50,60,50,60,50,60,50,60,60] if action == 'run' else [80,80,90]*4
        ims[0].save(out/f'{action}-preview.gif',save_all=True,append_images=ims[1:],duration=durations,loop=0,disposal=2)
    waist.save(out/'waist-inspection.png')
    background = Image.new('RGB',(768,340),(243,246,244))
    d = ImageDraw.Draw(background)
    for k,label in enumerate(['待机','行走','奔跑']):
        d.text((k*256+16,10),label,font=font,fill=(51,72,60))
        for y in range(44,300,16):
            for x in range(k*256,(k+1)*256,16):
                if ((x-k*256)//16+(y-44)//16)%2 == 0:
                    d.rectangle((x,y,x+15,y+15),fill=(232,238,234))
        d.line((k*256+64,274,k*256+192,274),fill=(169,185,173),width=1)
        d.text((k*256+16,308),['512 × 512','12帧 / 12fps','12帧 / 18fps'][k],font=small,fill=(83,107,89))
    preview = []
    for tick in range(100):
        t = tick*.02
        panel = background.copy()
        for k,im in enumerate([idle,frames['walk'][int(t*12)%12],frames['run'][int(t*18)%12]]):
            fg = im.resize((256,256),Image.Resampling.LANCZOS)
            panel.paste(fg,(k*256,44),fg)
        preview.append(panel)
    palette_source = Image.new('RGB',(768,340*12))
    for i in range(12):palette_source.paste(preview[i*8],(0,i*340))
    palette = palette_source.quantize(colors=255)
    preview = [p.quantize(palette=palette,dither=Image.Dither.NONE) for p in preview]
    preview[0].save(out/'actions-preview.gif',save_all=True,append_images=preview[1:],duration=20,loop=0,disposal=2,optimize=True)
    preview[0].convert('RGB').save(out/'overview.png')
    cloud = out/'cloud-upload'
    cloud.mkdir(exist_ok=True)
    for name in ['idle-sw.png','walk-sw.png','run-sw.png']:shutil.copyfile(out/name,cloud/name)
    (out/'verification.json').write_text(json.dumps({'checkedFrames':24,'allWaistsOpaque':True,
        'allCellsMatchIndividualFrames':True,'allFramesFitCanvas':True,'frames':report},indent=2),encoding='utf-8')
    excluded = {'walk-body.png','run-body.png','idle-source-512.png'}
    with zipfile.ZipFile(out.with_suffix('.zip'),'w',zipfile.ZIP_DEFLATED) as z:
        for p in out.rglob('*'):
            if p.is_file() and p.name not in excluded:z.write(p,p.relative_to(out))
    with zipfile.ZipFile(out.parent/'girl-sw-cloud-upload.zip','w',zipfile.ZIP_DEFLATED) as z:
        for p in cloud.glob('*.png'):z.write(p,p.name)
    print(json.dumps({'checkedFrames':24,'uploadFiles':{p.name:p.stat().st_size for p in cloud.glob('*.png')},
                      'fullArchiveBytes':out.with_suffix('.zip').stat().st_size}))


if __name__ == '__main__':
    main()
