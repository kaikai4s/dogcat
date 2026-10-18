"""Prepare the supplied farm artwork as transparent, anchored game assets.

Requires Pillow, NumPy and OpenCV. The source artwork is never modified.
"""
import argparse
import json
import zipfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


CROPS = {
    'carrot': (4, [0, 1024, 2048, 3072, 4096], [(525, 668), (1518, 654), (2538, 663), (3540, 654)]),
    'corn': (5, [0, 572, 1225, 2135, 3070, 4096], [(294, 791), (910, 765), (1680, 764), (2600, 758), (3550, 767)]),
    'strawberry': (6, [0, 1050, 2030, 3035, 4096], [(544, 640), (1516, 663), (2530, 704), (3546, 725)]),
    'pumpkin': (7, [0, 1005, 2010, 3020, 4096], [(517, 686), (1525, 687), (2514, 696), (3538, 710)]),
    'sunflower': (8, [0, 1040, 2040, 3055, 4096], [(547, 718), (1550, 716), (2540, 718), (3552, 724)]),
    'radish': (9, [0, 700, 1365, 2080, 3025, 4096], [(410, 729), (1032, 727), (1720, 739), (2490, 749), (3468, 758)]),
}


def load_source(folder, index):
    stem = '\u56fe\u7247\u4fe1\u606f'
    path = folder / (f'{stem} ({index}).' + ('jpeg' if index == 1 else 'png'))
    return Image.open(path).convert('RGB')


def largest(mask, minimum=0):
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype('uint8'), 8)
    if count < 2:
        raise ValueError('Empty illustration')
    keep = np.flatnonzero(stats[1:, cv2.CC_STAT_AREA] >= minimum) + 1 if minimum else [1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])]
    return np.isin(labels, keep)


def silhouette(rgb):
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    colored = (hsv[:, :, 1] > 65) & (hsv[:, :, 2] < 253)
    mask = largest(colored)
    # Fill only the main artwork outline, preserving pale radish/flower interiors.
    contours, _ = cv2.findContours(mask.astype('uint8'), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros(mask.shape, 'uint8')
    cv2.drawContours(filled, contours, -1, 255, cv2.FILLED)
    return filled > 0


def rgba(rgb, mask):
    result = np.dstack((rgb, mask.astype('uint8') * 255))
    result[~mask, :3] = 0
    return Image.fromarray(result, 'RGBA')


def plant_mask(rgb, name, stage, root):
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    hue, saturation, value = cv2.split(hsv)
    green = (hue >= 24) & (hue <= 100) & (saturation > 68) & (value > 65)
    # Suppress the separate green seedlings painted on the soil platform.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(green.astype('uint8'), 8)
    green = np.isin(labels, np.flatnonzero(stats[1:, cv2.CC_STAT_AREA] > 350) + 1)
    rx, ry = root
    if name in ('corn', 'carrot', 'sunflower'):
        green[ry+5:] = False
    colored = green.copy()
    region = np.zeros(hue.shape, 'uint8')
    if name == 'corn':
        upper = np.indices(hue.shape)[0] < ry-80
        colored |= upper & (hue >= 17) & (hue <= 100) & (saturation > 65)
        # Brown silk lies well above the soil, so retain its complete original ink.
        colored |= (np.indices(hue.shape)[0] < ry-260) & (saturation > 70) & (value < 250)
    if name == 'carrot' and stage:
        cv2.ellipse(region, (rx, ry-12), (85 if stage == 3 else 65, 100 if stage == 3 else 52), 0, 0, 360, 255, -1)
        colored |= (region > 0) & (hue < 26) & (saturation > 170) & (value > 200)
    if name == 'strawberry' and stage == 3:
        colored |= (hue < 10) & (saturation > 135) & (value > 160)
    if name == 'radish' and stage:
        cv2.ellipse(region, (rx-35 if stage > 2 else rx-8, ry-10), (180 if stage > 2 else 75, 180 if stage > 2 else 70), -12, 0, 360, 255, -1)
        colored |= (region > 0) & (value > 188) & (saturation > 25) & (saturation < 100) & (hue > 12) & (hue < 40)
    if name == 'pumpkin' and stage == 3:
        # Mature fruit is orange like the platform: constrain its painted extent.
        cv2.ellipse(region, (300, 593), (168, 145), 0, 0, 360, 255, -1)
        cv2.ellipse(region, (564, 521), (213, 192), 0, 0, 360, 255, -1)
        colored |= (region > 0) & (saturation > 130) & (value > 155) & (hue < 32)
    if name == 'corn' and stage >= 3:
        # Keep the original brown silk as well as the yellow kernels.
        points = ([(473, 179), (542, 112), (590, 121), (621, 196), (602, 266), (542, 260), (510, 206)],
                  [(143, 275), (199, 211), (255, 198), (294, 263), (259, 350), (174, 383), (130, 326),
                   (140, 275)])
        if stage == 3:
            cv2.fillPoly(region, [np.array(points[0], 'int32'), np.array([(172, 538), (200, 488), (254, 483), (297, 532), (286, 568), (225, 567)], 'int32')], 255)
        else:
            cv2.fillPoly(region, [np.array(points[1], 'int32'), np.array([(595, 169), (648, 134), (704, 170), (744, 230), (737, 285), (675, 288), (621, 228)], 'int32')], 255)
        colored |= (region > 0) & (saturation > 85) & (value > 95)
    if name == 'sunflower' and stage == 3:
        cv2.ellipse(region, (505, 320), (275, 265), 0, 0, 360, 255, -1)
        colored |= (region > 0) & (saturation > 55)
    if name == 'strawberry' and stage >= 2:
        # Flower whites are enclosed by their cream/brown outlines.
        for x, y, radius in ([(233, 377, 60), (338, 491, 70)] if stage == 2 else [(404, 236, 65), (675, 135, 55)]):
            cv2.circle(region, (x, y), radius, 255, -1)
        colored |= (region > 0) & (value > 170) & (saturation < 120)
    # Recover thin ink outlines and fill the small highlights inside fruit/leaves.
    grown = cv2.dilate(colored.astype('uint8'), np.ones((11, 11), 'uint8')) > 0
    ink = (value < 172) & (saturation > 65)
    mask = colored | (grown & ink)
    mask = cv2.morphologyEx(mask.astype('uint8'), cv2.MORPH_CLOSE, np.ones((5, 5), 'uint8'))
    # Preserve open gaps between stems; fill only tiny enclosed color highlights.
    inverse = 1 - mask
    count, labels, stats, _ = cv2.connectedComponentsWithStats(inverse, 8)
    tiny = [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] < 1400 and stats[i, cv2.CC_STAT_LEFT] > 0 and stats[i, cv2.CC_STAT_TOP] > 0]
    mask[np.isin(labels, tiny)] = 1
    return largest(mask)


def generate(folder, out):
    if out.exists():
        raise SystemExit('Refusing to overwrite an existing package; select a new version directory')
    upload = out / 'cloud-upload' / 'farm'
    upload.mkdir(parents=True)
    singles = out / 'frames-256'
    singles.mkdir()
    contact = Image.new('RGB', (1280, 7*288), '#253f4a')
    light = Image.new('RGB', contact.size, '#e2e9df')
    isolated = Image.new('RGB', contact.size, '#253f4a')
    draw, light_draw = ImageDraw.Draw(contact), ImageDraw.Draw(light)
    isolated_draw = ImageDraw.Draw(isolated)
    manifest = {'version': 1, 'cloudDirectory': 'packagePlayground/2d/baseImage/farm',
                'cell': [256, 256], 'anchor': [128, 192], 'soil': {}, 'crops': {}}
    checks = []

    def verify(frame, label):
        alpha = np.asarray(frame.getchannel('A'))
        assert frame.size == (256, 256)
        assert alpha.max() == 255 and (alpha == 0).mean() > .15
        assert not np.any(alpha[0]) and not np.any(alpha[-1]) and not np.any(alpha[:, 0]) and not np.any(alpha[:, -1])
        checks.append({'name': label, 'bounds': frame.getbbox(), 'transparentPixels': int((alpha == 0).sum())})

    def preview(frame, col, row, label):
        for target, painter in [(contact, draw), (light, light_draw)]:
            x, y = col*256, row*288
            target.paste(frame, (x, y), frame)
            painter.text((x+10, y+263), label, fill='white' if target is contact else '#243b37')

    soils = []
    for i, name in enumerate(['soil-wild', 'soil-tilled', 'soil-watered']):
        rgb = np.array(load_source(folder, i+1))
        sprite = rgba(rgb, silhouette(rgb))
        sprite = sprite.crop(sprite.getbbox()).resize((224, 116), Image.Resampling.LANCZOS)
        frame = Image.new('RGBA', (256, 256))
        frame.alpha_composite(sprite, (16, 134))
        frame.save(upload / (name+'.png'), optimize=True)
        verify(frame, name)
        preview(frame, i, 0, name)
        isolated.paste(frame, (i*256, 0), frame)
        isolated_draw.text((i*256+10, 263), name, fill='white')
        soils.append(frame)
        manifest['soil'][name.removeprefix('soil-')] = name+'.png'

    for row, (name, (index, edges, roots)) in enumerate(CROPS.items(), 1):
        source = load_source(folder, index)
        sprites = []
        for stage, (left, right) in enumerate(zip(edges, edges[1:])):
            rgb = np.array(source.crop((left, 0, right, 1024)))
            root = (roots[stage][0]-left, roots[stage][1])
            sprites.append((rgba(rgb, plant_mask(rgb, name, stage, root)), root))
        # One scale per species keeps the original relative growth and width.
        scales = []
        for sprite, (rx, ry) in sprites:
            l, t, r, b = sprite.getbbox()
            scales.append(min(116/max(1, rx-l), 116/max(1, r-rx), 176/max(1, ry-t), 49/max(1, b-ry)))
        scale = min(scales)
        atlas = Image.new('RGBA', (256*len(sprites), 256))
        views = []
        for stage, (sprite, (rx, ry)) in enumerate(sprites):
            bounds = sprite.getbbox()
            cropped = sprite.crop(bounds)
            resized = cropped.resize((round(cropped.width*scale), round(cropped.height*scale)), Image.Resampling.LANCZOS)
            frame = Image.new('RGBA', (256, 256))
            frame.alpha_composite(resized, (128-round((rx-bounds[0])*scale), 192-round((ry-bounds[1])*scale)))
            verify(frame, f'{name}-{stage+1}')
            frame.save(singles / f'{name}-{stage+1:02d}.png', optimize=True)
            atlas.alpha_composite(frame, (stage*256, 0))
            isolated.paste(frame, (stage*256, row*288), frame)
            isolated_draw.text((stage*256+10, row*288+263), f'{name} {stage+1}/{len(sprites)}', fill='white')
            composite = soils[1].copy()
            composite.alpha_composite(frame)
            preview(composite, stage, row, f'{name} {stage+1}/{len(sprites)}')
            views.append(composite)
        atlas.save(upload / (name+'-stages.png'), optimize=True)
        atlas = Image.open(upload / (name+'-stages.png')).convert('RGBA')
        for stage in range(len(sprites)):
            saved = Image.open(singles/f'{name}-{stage+1:02d}.png').convert('RGBA')
            assert np.array_equal(np.array(saved), np.array(atlas.crop((stage*256, 0, (stage+1)*256, 256))))
        manifest['crops'][name] = {'file': name+'-stages.png', 'stages': len(sprites), 'columns': len(sprites), 'rows': 1,
                                  'progressThresholds': [0, 20, 65, 100] if len(sprites)==4 else [0, 15, 45, 75, 100],
                                  'sourceRootPixels': roots, 'sourceColumnEdges': edges, 'scale': scale}
        # This is a slow growth review, never a game animation.
        backgrounds = []
        for view in views:
            bg = Image.new('RGB', (256, 256), '#253f4a')
            bg.paste(view, (0, 0), view)
            backgrounds.append(bg)
        backgrounds[0].save(out/f'{name}-growth-preview.gif', save_all=True, append_images=backgrounds[1:], duration=1100, loop=0)
    contact.save(out/'preview-dark.jpg', quality=95)
    light.save(out/'preview-light.jpg', quality=95)
    isolated.save(out/'preview-isolated.jpg', quality=95)
    (out/'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    (out/'verification.json').write_text(json.dumps({'passed': True, 'assets': checks, 'cropFrames': len(checks)-3, 'uploadPngs': 9}, indent=2), encoding='utf-8')
    (out/'UPLOAD-README.md').write_text('''# 农场素材上传说明

## 上传位置

微信开发者工具 → 云开发 → 项目正在使用的云环境 → 存储。
当前项目环境：cloud1-5gnhqn4t0554c1d9。

进入 packagePlayground/2d/baseImage/，新建 farm 文件夹。
进入 farm 后，上传本地 cloud-upload/farm/ 中的全部 9 张 PNG。
最终路径必须是 packagePlayground/2d/baseImage/farm/文件名.png。
不要多套一层 cloud-upload、farm-assets-ready-v1 或第二层 farm。

## 只上传这 9 个文件

| 文件名 | 内容 | 尺寸 | 阶段 |
|---|---|---|---|
| soil-wild.png | 待开垦土地 | 256×256 | 单张 |
| soil-tilled.png | 已开垦土地 | 256×256 | 单张 |
| soil-watered.png | 已浇水土地 | 256×256 | 单张 |
| carrot-stages.png | 胡萝卜 | 1024×256 | 4列1行 |
| radish-stages.png | 白萝卜 | 1280×256 | 5列1行 |
| corn-stages.png | 玉米 | 1280×256 | 5列1行 |
| strawberry-stages.png | 草莓 | 1024×256 | 4列1行 |
| pumpkin-stages.png | 南瓜 | 1024×256 | 4列1行 |
| sunflower-stages.png | 向日葵 | 1024×256 | 4列1行 |

## 接入参数

全部是真实 RGBA 透明 PNG。已移除棋盘格、分隔框及作物自带土台；
土地与作物分层使用。每格 256×256，根部/地面中心统一为 (128,192)。
土地宽224、高116；同种作物共用缩放比例，保留原有阶段大小差异。
图集阶段从左到右排列，属于成长状态，不是逐帧循环动画。
四阶段进度参考：0%、20%、65%、100%；五阶段：0%、15%、45%、75%、100%。
成熟状态应显式选最后一格，不能在99%时提前使用成熟图。
绘制时源切片为 (阶段索引×256,0,256,256)，目标左上角为
(地面屏幕X-宽×0.5, 地面屏幕Y-高×0.75)。土地和作物使用相同绘制矩形。
素材不应再经过项目普通装饰图片的去白底/压方图流程，避免破坏白花和白萝卜。
完整参数见 manifest.json。

## 本地附加文件

frames-256/：26张独立透明阶段图，备用；不必上传。
preview-dark.jpg、preview-light.jpg：在土地上叠加的深浅背景预览。
preview-isolated.jpg：实际透明素材的深色接触表。
六个 growth-preview.gif：每阶段1.1秒的成长检查，不是游戏动画。
verification.json：尺寸、透明边界、非空和图集切片一致性检查结果。

此包仅完成本地素材处理，未代为上传、发布，也未切换游戏渲染器。
上传后提供云存储中的文件ID，即可核对路径并继续接入。
''', encoding='utf-8')
    with zipfile.ZipFile(out.with_suffix('.zip'), 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(out.rglob('*')):
            if path.is_file():
                archive.write(path, Path(out.name)/path.relative_to(out))
    print(json.dumps({'output': str(out), 'uploadPngs': 9, 'cropFrames': len(checks)-3}))


def inspect(folder, out):
    out.mkdir(parents=True, exist_ok=True)
    sheet = Image.new('RGB', (1280, 6 * 300), '#283e48')
    draw = ImageDraw.Draw(sheet)
    for row, (name, (index, edges, roots)) in enumerate(CROPS.items()):
        source = load_source(folder, index)
        for stage, (left, right) in enumerate(zip(edges, edges[1:])):
            crop = source.crop((left, 0, right, 1024))
            crop.thumbnail((248, 276))
            x, y = stage * 256, row * 300
            sheet.paste(crop, (x, y))
            scale = crop.height / 1024
            rx, ry = roots[stage]
            draw.ellipse((x + (rx-left)*scale-3, y+ry*scale-3, x+(rx-left)*scale+3, y+ry*scale+3), fill='red')
            draw.text((x+8, y+280), f'{name} {stage+1}', fill='white')
    sheet.save(out / 'source-inspection.jpg', quality=94)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--inspect', action='store_true')
    args = parser.parse_args()
    if args.inspect:
        inspect(args.source_dir, args.out)
    else:
        generate(args.source_dir, args.out)


if __name__ == '__main__':
    main()
