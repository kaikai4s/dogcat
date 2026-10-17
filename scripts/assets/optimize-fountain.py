"""Reproject the supplied raster pool, then register water above a fixed base.

Requires Pillow and numpy. No originals are overwritten and no AI API is used.
"""

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont


def perspective(source, src, dst, size):
    rows, values = [], []
    for (x, y), (u, v) in zip(dst, src):
        rows.extend([[x, y, 1, 0, 0, 0, -u*x, -u*y],
                     [0, 0, 0, x, y, 1, -v*x, -v*y]])
        values.extend([u, v])
    coeff = np.linalg.solve(np.array(rows), np.array(values))
    out = source.transform(size, Image.Transform.PERSPECTIVE, coeff,
                           Image.Resampling.BICUBIC)
    mask = Image.new('L', size)
    ImageDraw.Draw(mask).polygon(dst, fill=255)
    out.putalpha(ImageChops.multiply(out.getchannel('A'), mask))
    return out


def point(u, v):
    # Same ground projection as World2D: y / x = 0.52 on both axes.
    return (512 + 245*u - 155*v, 710 + .52*(245*u + 155*v))


def water_cutout(source, box, rim_y=905, stem_x=770):
    crop = source.crop(box).convert('RGBA')
    a = np.array(crop).astype(float)
    # Water is blue; the paper and stone are neutral. Preserve translucent edges.
    blue = a[:, :, 2] - a[:, :, 0]
    alpha = np.clip((blue - 7) / 15, 0, 1)
    # The source's grey rear pool wall is slightly blue too. Exclude it without
    # cutting the upright stem or the saturated falling water in front of it.
    yy, xx = np.indices(alpha.shape)
    on_wall = (yy + box[1] >= rim_y) & (abs(xx + box[0] - stem_x) > 18)
    alpha[on_wall] *= np.clip((blue[on_wall] - 65) / 20, 0, 1)
    if stem_x != 770:
        # Beyond the original water line only the narrow upright column belongs
        # to this sprite. Otherwise a blue rectangle of the old pool survives.
        alpha[(yy + box[1] >= rim_y + 38) &
              (abs(xx + box[0] - stem_x) > 15)] = 0
    a[:, :, 3] = alpha * 255
    return Image.fromarray(a.astype('uint8'))


def extend_falling_water(layer, outlet_y, surface_y):
    a=np.array(layer)
    result=np.zeros_like(a)
    yy,xx=np.indices(a.shape[:2])
    start=outlet_y-110
    # Lengthen just the outer falling streams; the central outlet stays fixed.
    weight=np.clip((abs(xx-512)-22)/18,0,1)
    stretch=1+(surface_y-outlet_y)/110*weight
    sy=np.where(yy>start,start+(yy-start)/stretch,yy)
    sy=np.clip(np.rint(sy).astype(int),0,1023)
    result[:]=a[sy,xx]
    return Image.fromarray(result)


def place(layer, sprite, bottom, scale):
    sprite = sprite.resize((round(sprite.width*scale), round(sprite.height*scale)),
                           Image.Resampling.LANCZOS)
    layer.alpha_composite(sprite, (round(bottom[0]-sprite.width/2),
                                   round(bottom[1]-sprite.height)))


def build(source_dir, dest):
    dest.mkdir(parents=True, exist_ok=True)
    pq = dest / 'pq'
    pq.mkdir(exist_ok=True)
    originals = [Image.open(source_dir/f'pq{i}.png').convert('RGBA') for i in range(1, 7)]
    source = originals[0]
    size = (1024, 1024)
    # Remove the old nozzles from the rear coping before reprojecting its texture.
    clean = source.copy()
    for x0, x1 in [(415, 517), (700, 837), (1032, 1147)]:
        patch = source.crop((530, 904, 650, 956)).resize((x1-x0, 52))
        clean.paste(patch, (x0, 904))
    # Rectify the original coping into a flat plane.
    flat = perspective(clean, [(299,905), (1249,905), (1468,1131), (69,1131)],
                       [(0,0), (1199,0), (1199,759), (0,759)], (1200,760))
    # Reuse an unobstructed patch of the original hand-painted water.
    patch = source.crop((525, 1042, 661, 1106)).resize((272,128), Image.Resampling.LANCZOS)
    texture = Image.new('RGBA', (1200,760))
    for row, y in enumerate(range(0, 760, 128)):
        for col, x in enumerate(range(0, 1200, 272)):
            tile = patch.transpose(Image.Transpose.FLIP_LEFT_RIGHT) if col%2 else patch
            tile = tile.transpose(Image.Transpose.FLIP_TOP_BOTTOM) if row%2 else tile
            texture.paste(tile, (x,y))
    # Pool interior: keep a consistent stone border in the rectified plane.
    interior = Image.new('L', flat.size)
    ImageDraw.Draw(interior).rectangle((89, 135, 1111, 747), fill=255)
    flat.paste(texture, (0,0), interior)
    edges = ImageDraw.Draw(flat)
    edges.rectangle((88,134,1112,748), outline=(66,111,130,255), width=3)
    corners = [point(-1,-1), point(1,-1), point(1,1), point(-1,1)]
    base = Image.new('RGBA', size)
    # Vertical stone faces use the original stone face texture, not skewed jets.
    face = source.crop((294,1173,980,1203))
    for a,b,brightness in [(corners[3],corners[2],.82),(corners[2],corners[1],.96)]:
        q=[a,b,(b[0],b[1]+26),(a[0],a[1]+26)]
        shade=ImageEnhance.Brightness(face).enhance(brightness)
        base.alpha_composite(perspective(shade,[(0,0),(685,0),(685,29),(0,29)],q,size))
        ImageDraw.Draw(base).line(q+[q[0]],fill=(105,105,112,255),width=2)
    top = perspective(flat, [(0,0),(1199,0),(1199,759),(0,759)],corners,size)
    base.alpha_composite(top)
    draw=ImageDraw.Draw(base)
    draw.line(corners+[corners[0]],fill=(103,105,113,255),width=2)
    # Ripples live on the same ground plane, centered on the three fixed nozzles.
    positions = [point(-.58,0),point(0,0),point(.58,0)]
    for px,py in positions:
        for r in [27,39,51]:
            draw.ellipse((px-r,py-r*.42,px+r,py+r*.42),outline=(179,231,244,170),width=2)
    pedestal = source.crop((710,930,830,1034))
    mask=Image.new('L',pedestal.size)
    ImageDraw.Draw(mask).polygon([(36,1),(86,1),(92,61),(116,71),(117,96),
                                  (107,102),(14,102),(4,94),(4,72),(28,61)],fill=255)
    pedestal.putalpha(mask)
    # Small original pedestal, with an explicit outline to retain white stone.
    small=source.crop((424,999,501,1029))
    smallmask=Image.new('L',small.size)
    ImageDraw.Draw(smallmask).rounded_rectangle((1,1,75,28),radius=11,fill=255)
    small.putalpha(smallmask)
    for i,p in enumerate(positions):
        place(base,pedestal if i==1 else small,p,.62 if i==1 else .7)
    base.save(dest/'fountain-base.png', optimize=True)
    # The side jets remain fixed; central water changes height but its outlet is locked.
    side = water_cutout(source,(401,780,525,1008),stem_x=463)
    base_heights=[940,941,1021,1070,1025,940]
    rim_heights=[905,905,983,1028,1010,905]
    frames=[]
    invariant_hashes=[]
    water_mask=Image.new('L',size)
    for i,(original,height) in enumerate(zip(originals,base_heights),1):
        water=Image.new('RGBA',size)
        for p in [positions[0],positions[2]]:
            place(water,side,(p[0],p[1]-17),.7)
        jet=water_cutout(original,(572,100,966,height),rim_y=rim_heights[i-1])
        center_water=Image.new('RGBA',size)
        place(center_water,jet,(positions[1][0],positions[1][1]-59),.62)
        center_water=extend_falling_water(center_water,651,708)
        water.alpha_composite(center_water)
        water.save(dest/f'water-{i}.png',optimize=True)
        water_mask=ImageChops.lighter(water_mask,water.getchannel('A'))
        result=Image.alpha_composite(base,water)
        result.save(pq/f'pq{i}.png',optimize=True)
        frames.append(result)
    # Verify that every non-water pixel, including all coping/stone, is identical.
    stable=np.asarray(water_mask)==0
    for f in frames:
        invariant_hashes.append(hashlib.sha256(np.asarray(f)[stable].tobytes()).hexdigest())
    assert len(set(invariant_hashes))==1
    sheet=Image.new('RGB',(1200,800),'#dce9cf')
    font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',18)
    for i,f in enumerate(frames):
        tile=Image.new('RGBA',size,'#dce9cf')
        tile.alpha_composite(f)
        tile=tile.convert('RGB').resize((400,400),Image.Resampling.LANCZOS)
        sheet.paste(tile,((i%3)*400,(i//3)*400))
        ImageDraw.Draw(sheet).text(((i%3)*400+16,(i//3)*400+14),f'pq{i+1}',font=font,fill='#334b30')
    sheet.save(dest/'preview-sheet.jpg',quality=94)
    previews=[]
    for f in frames:
        bg=Image.new('RGBA',size,'#dce9cf');bg.alpha_composite(f)
        previews.append(bg.convert('RGB').resize((640,640),Image.Resampling.LANCZOS))
    previews[0].save(dest/'preview.gif',save_all=True,append_images=previews[1:],
                     duration=125,loop=0,disposal=2)
    (dest/'manifest.json').write_text(json.dumps({
        'size':[1024,1024], 'background':'transparent', 'fps':8,
        'groundAnchor':[.5,.7], 'groundAxisSlope':.52,
        'frames':[f'pq/pq{i}.png' for i in range(1,7)],
        'fixedBasePixelVerification':'identical outside water alpha in all six frames',
        'fixedPixelsSha256':invariant_hashes[0],
        'method':'original raster layer extraction, ground-plane projection, registered compositing; no AI generation'
    },ensure_ascii=False,indent=2),encoding='utf-8')
    (dest/'上传说明.txt').write_text(
        '喷泉斜向修正版\n\n'
        '上传 pq 文件夹里的 pq1.png～pq6.png，覆盖云存储原来的六张同名文件。\n'
        '云存储目录：packagePlayground/2d/baseImage/pq/\n'
        '不要上传外层 fountain-isometric 文件夹，也不要把预览图当作素材。\n\n'
        '六帧均为 1024×1024 透明 PNG，固定画布、池底和喷头；水柱保持竖直。\n'
        '地面边线斜率为 ±0.52，与当前游戏投影一致。保持原来 0.7 的纵向锚点。\n'
        '现有游戏使用 pq1～pq6、8 帧/秒，文件路径无需修改。\n'
        '覆盖后请重新进入场景；若开发工具仍显示旧图，清理缓存后重试。\n\n'
        'preview.gif：动画预览；preview-sheet.jpg：六帧对比。\n'
        'fountain-base.png / water-1～6.png：分层备份，不需要上传。\n'
        '本包用原图进行分层、透视校正和合成，未使用 AI 生成。\n',encoding='utf-8')
    archive=dest.with_suffix('.zip')
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for f in sorted(dest.rglob('*')):
            if f.is_file():z.write(f,f.relative_to(dest))
    print(json.dumps({'folder':str(dest),'zip':str(archive),'verifiedFixedBase':True},ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    build(args.source,args.output)
