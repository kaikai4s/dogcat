"""Extract supplied 6 by 2 character art into transparent, registered game assets."""
import argparse
import json
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def runs(mask):
    edges = np.diff(np.r_[False, mask, False].astype(int))
    return list(zip(np.where(edges == 1)[0], np.where(edges == -1)[0]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    dest = args.destination
    if dest.exists():
        raise SystemExit('Destination already exists; choose a new version to preserve files.')
    original = Image.open(args.source).convert('RGBA')
    pixels = np.array(original)
    rgb = pixels[:, :, :3].astype(np.float32)
    green = rgb[:, :, 1] - np.maximum(rgb[:, :, 0], rgb[:, :, 2])
    opacity = 1 - np.clip((green - 2) / 14, 0, 1)
    pixels[:, :, 3] = np.rint(opacity * 255).astype(np.uint8)
    edge = (opacity > 0) & (opacity < 1)
    pixels[:, :, 1][edge] = np.minimum(
        pixels[:, :, 1][edge],
        np.maximum(pixels[:, :, 0][edge], pixels[:, :, 2][edge]) + 2)
    pixels[opacity == 0, :3] = 0
    keyed = Image.fromarray(pixels)
    solid = opacity > 0.5
    row_runs = [(int(a), int(b)) for a, b in runs(solid.sum(axis=1) > 30) if b-a > 100]
    if len(row_runs) != 2:
        raise ValueError(f'Expected two rows, found {row_runs}')
    subjects = []
    for top, bottom in row_runs:
        cols = [(int(a), int(b)) for a, b in runs(solid[top:bottom].sum(axis=0) > 8) if b-a > 80]
        if len(cols) != 6:
            raise ValueError(f'Expected six subjects, found {cols}')
        boundaries = [0] + [(cols[i][1]+cols[i+1][0])//2 for i in range(5)] + [original.width]
        for col in range(6):
            region = (boundaries[col], max(0, top-4), boundaries[col+1], min(original.height, bottom+4))
            cell = keyed.crop(region)
            box = cell.getbbox()
            cut = cell.crop(box)
            # Register the head rather than the swinging hands or feet.
            head = np.asarray(cut)[:round(cut.height * 0.30), :, 3] > 127
            xs = np.where(head)[1]
            center = (int(xs.min()) + int(xs.max()) + 1) / 2
            subjects.append((cut, center, [int(region[0]+box[0]), int(region[1]+box[1]),
                                           int(region[0]+box[2]), int(region[1]+box[3])]))
    dest.mkdir(parents=True)
    scale512 = 430 / max(cut.height for cut, _, _ in subjects)
    frame_metadata = []
    all_frames = {}
    for size in (512, 256):
        folder = dest / f'frames-{size}'
        folder.mkdir()
        atlas = Image.new('RGBA', (size*4, size*3))
        frames = []
        mapping = {}
        for i, (cut, center, source_box) in enumerate(subjects):
            scale = scale512*size/512
            width, height = round(cut.width*scale), round(cut.height*scale)
            resized = cut.resize((width, height), Image.Resampling.LANCZOS)
            frame = Image.new('RGBA', (size, size))
            x = round(size/2-center*scale)
            y = round(size*460/512)-height
            if x < 2 or x+width > size-2 or y < 2:
                raise ValueError(f'Frame {i+1} does not fit canvas')
            frame.alpha_composite(resized, (x, y))
            name = f'boy-walk-sw-{i+1:02d}.png'
            frame.save(folder / name, optimize=True)
            ax, ay = (i%4)*size, (i//4)*size
            atlas.alpha_composite(frame, (ax, ay))
            mapping[name] = {'frame': {'x':ax,'y':ay,'w':size,'h':size},
                             'rotated':False,'trimmed':False,
                             'spriteSourceSize':{'x':0,'y':0,'w':size,'h':size},
                             'sourceSize':{'w':size,'h':size},
                             'pivot':{'x':0.5,'y':460/512}}
            frames.append(frame)
            if size == 512:
                frame_metadata.append({'index':i+1,'file':f'frames-512/{name}',
                                       'sourceBounds':source_box})
        atlas_name=f'boy-walk-sw-atlas-{size}.png'
        atlas.save(dest / atlas_name, optimize=True)
        atlas_meta={'frames':mapping,'meta':{'image':atlas_name,'format':'RGBA8888',
                     'size':{'w':size*4,'h':size*3},'scale':'1'},
                    'animation':{'name':'boy-walk-sw','order':list(mapping),'fps':10,
                                 'loop':True,'anchor':{'x':0.5,'y':460/512}}}
        (dest / f'boy-walk-sw-atlas-{size}.json').write_text(
            json.dumps(atlas_meta,ensure_ascii=False,indent=2),encoding='utf-8')
        all_frames[size]=frames
    # A labeled contact sheet and a playback preview expose defects in supplied poses.
    contact=Image.new('RGB',(256*4,290*3),(232,236,241))
    draw=ImageDraw.Draw(contact)
    for i,frame in enumerate(all_frames[256]):
        x,y=(i%4)*256,(i//4)*290
        contact.paste(frame,(x,y),frame)
        draw.text((x+12,y+264),f'{i+1:02d}',fill=(36,48,64))
    contact.save(dest / 'contact-sheet.jpg',quality=94)
    preview=[]
    for frame in all_frames[256]:
        bg=Image.new('RGB',(256,256),(232,236,241))
        bg.paste(frame,(0,0),frame)
        preview.append(bg)
    # One common GIF palette avoids color flicker; production assets remain RGBA PNG.
    palette=contact.quantize(colors=255)
    preview=[im.quantize(palette=palette,dither=Image.Dither.NONE) for im in preview]
    preview[0].save(dest / 'walk-preview.gif',save_all=True,append_images=preview[1:],
                    duration=100,loop=0,optimize=False,disposal=2)
    manifest={'source':str(args.source),'sourceSize':list(original.size),'frameCount':12,
              'action':'walk','direction':'sw (left-front as supplied)',
              'order':'source row 1 left to right, then row 2 left to right',
              'fpsSuggested':10,'canvasSizes':[512,256], 'anchor512':[256,460],
              'uniformScale512':scale512,'frames':frame_metadata,
              'limitation':'Source poses are very similar and do not provide a complete alternating-leg walk cycle. Extraction does not invent missing poses.'}
    (dest / 'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    (dest / '使用说明.txt').write_text(
        '男孩左前方行走素材：原图12个人物，按第一排从左到右、第二排从左到右编号。\n'
        'frames-512：12张512×512透明PNG；frames-256：12张256×256透明PNG，适合较小显示尺寸。\n'
        '已去除绿色背景和原有地面阴影，清理绿边。所有帧使用同一缩放比例，以头部横向中心和脚底地面线对齐。\n'
        '512版锚点(256,460)，256版锚点(128,230)。图集为4列3排，JSON提供每帧矩形、播放顺序与锚点。\n'
        'walk-preview.gif是10帧/秒的检查预览；实际播放速度按游戏中移动速度调整。\n'
        '注意：原图多数人物为同一侧腿迈出的相近姿势，缺少完整左右腿交替动作；直接循环会像滑步。'
        '这些文件是已抠图并对齐的原图帧，不是补绘后的完整步态。\n',encoding='utf-8')
    archive=dest.with_suffix('.zip')
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for file in dest.rglob('*'):
            if file.is_file(): z.write(file,file.relative_to(dest))
    print(json.dumps({'output':str(dest),'zip':str(archive),'frames':len(subjects),
                      'sourceBounds':[s[2] for s in subjects]},ensure_ascii=False))


if __name__=='__main__':
    main()
