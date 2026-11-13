"""Build deterministic raster animations from generated memorial turnarounds.

The supplied character references were used by the imagegen CLI to create the
four-view source sheets. This script registers those views and articulates their
original pixels. It does not call an image service or redraw character details.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFont

N = 512
DIRECTIONS = ['sw', 'se', 'nw', 'ne']
STANCE = .6
STRIDE = 48.0
# Measured hip, knee and ankle centers in the registered 512px source views.
RIGS = {
    'boy/sw': [[(237, 298), (239, 358), (234, 424)], [(280, 298), (291, 360), (307, 432)]],
    'boy/se': [[(230, 298), (224, 359), (215, 432)], [(279, 298), (287, 360), (292, 424)]],
    'boy/nw': [[(235, 300), (230, 360), (224, 435)], [(286, 300), (291, 360), (299, 435)]],
    'boy/ne': [[(225, 300), (222, 360), (215, 435)], [(278, 300), (286, 360), (287, 435)]],
    'girl/sw': [[(237, 285), (240, 351), (245, 425)], [(272, 285), (288, 352), (303, 433)]],
    'girl/se': [[(251, 285), (229, 351), (215, 433)], [(285, 285), (273, 351), (267, 425)]],
    'girl/nw': [[(228, 305), (238, 360), (241, 439)], [(268, 305), (286, 360), (299, 440)]],
    'girl/ne': [[(248, 305), (227, 360), (217, 439)], [(287, 305), (279, 360), (271, 439)]],
}


def prepare(root):
    font = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 13)
    report = {}
    for who in ['boy', 'girl']:
        src = Image.open(root / 'raw' / f'{who}-turnaround.png').convert('RGBA')
        contact = Image.new('RGB', (1024, 1024), '#263f39')
        for i, direction in enumerate(DIRECTIONS):
            col, row = i % 2, i // 2
            box = (col * src.width // 2, row * src.height // 2,
                   (col + 1) * src.width // 2, (row + 1) * src.height // 2)
            cell = src.crop(box)
            alpha = cell.getchannel('A')
            mask = alpha.point(lambda x: 255 if x > 12 else 0)
            solid = alpha.point(lambda x: 255 if x > 100 else 0)
            bbox = solid.getbbox()
            head = solid.crop((0, bbox[1], cell.width, bbox[1] + round((bbox[3] - bbox[1]) * .2))).getbbox()
            seed = (round((head[0] + head[2]) / 2), bbox[1] + round((head[1] + head[3]) / 2))
            ImageDraw.floodfill(mask, seed, 128)
            cell.putalpha(ImageChops.multiply(alpha, mask.point(lambda x: 255 if x == 128 else 0)))
            bbox = cell.getbbox()
            head = cell.getchannel('A').crop((0, bbox[1], cell.width, bbox[1] + round((bbox[3] - bbox[1]) * .2))).point(lambda x: 255 if x > 100 else 0).getbbox()
            center_x = (head[0] + head[2]) / 2
            scale = 420 / (bbox[3] - bbox[1])
            resized = cell.resize((round(cell.width * scale), round(cell.height * scale)), Image.Resampling.LANCZOS)
            target = Image.new('RGBA', (N, N))
            target.alpha_composite(resized, (round(256 - center_x * scale), round(460 - bbox[3] * scale)))
            folder = root / 'bases' / who
            folder.mkdir(parents=True, exist_ok=True)
            target.save(folder / f'{direction}.png')
            contact.paste(target, (col * N, row * N), target)
            draw = ImageDraw.Draw(contact)
            for x in range(0, N, 32):
                draw.line((col * N + x, row * N, col * N + x, row * N + N - 1), fill='#52665d')
                draw.text((col * N + x + 1, row * N + 1), str(x), font=font, fill='white')
            for y in range(32, N, 32):
                draw.line((col * N, row * N + y, col * N + N - 1, row * N + y), fill='#52665d')
                draw.text((col * N + 1, row * N + y), str(y), font=font, fill='white')
            report[f'{who}/{direction}'] = {'source': f'raw/{who}-turnaround.png', 'sourceCrop': box,
                                           'scale': scale, 'base': f'bases/{who}/{direction}.png'}
        contact.save(root / f'{who}-rig-guides.jpg', quality=95)
    (root / 'base-registration.json').write_text(json.dumps(report, indent=2) + '\n')


def smooth(v):
    v = np.clip(v, 0, 1)
    return v * v * (3 - 2 * v)


def sample(layer, sx, sy):
    # Premultiplied-alpha interpolation preserves light edges without a matte.
    sx, sy = np.clip(sx, 0, N - 1.001), np.clip(sy, 0, N - 1.001)
    x, y = np.floor(sx).astype(int), np.floor(sy).astype(int)
    fx, fy = (sx - x)[..., None], (sy - y)[..., None]
    a = np.asarray(layer).astype(np.float32) / 255
    a[:, :, :3] *= a[:, :, 3:4]
    pixels = (a[y, x] * (1 - fx) * (1 - fy) + a[y, x + 1] * fx * (1 - fy)
              + a[y + 1, x] * (1 - fx) * fy + a[y + 1, x + 1] * fx * fy)
    pixels[:, :, :3] /= np.maximum(pixels[:, :, 3:4], 1e-6)
    return Image.fromarray(np.rint(np.clip(pixels, 0, 1) * 255).astype('uint8'))


def foot_path(u):
    """Linear planted-foot travel; smooth airborne return, with no ankle warp."""
    u %= 1
    if u <= STANCE:
        return STRIDE * (.5 - u / STANCE), 0.0, True
    t = (u - STANCE) / (1 - STANCE)
    return STRIDE * (-.5 + t * t * (3 - 2 * t)), 14 * math.sin(math.pi * t) ** 2, False


def solve_leg(hip, ankle, upper_length, lower_length, bend):
    v = ankle - hip
    distance = float(np.linalg.norm(v))
    if distance >= upper_length + lower_length:
        raise ValueError('Unreachable ankle: adjust the hip height, never stretch the leg')
    unit = v / distance
    along = (upper_length ** 2 - lower_length ** 2 + distance ** 2) / (2 * distance)
    height = math.sqrt(max(0, upper_length ** 2 - along ** 2))
    normal = np.array([-unit[1], unit[0]])
    return hip + unit * along + normal * height * bend


def deform_leg(layer, original, target):
    """A continuous triangle strip through hip/knee/ankle, rigid below ankle.

    Shared strip edges prevent cutout cracks. Segment lengths come from the IK
    solution. Below the ankle the strip is a translation, preserving the shoe.
    """
    hip, knee, ankle = np.array(original, dtype=float)
    h, k, a = np.array(target, dtype=float)
    src_centers = [hip + (0, -16), hip, (hip + knee) / 2, knee,
                   (knee + ankle) / 2, ankle, ankle + (0, 60)]
    dst_centers = [h + (0, -16), h, (h + k) / 2, k,
                   (k + a) / 2, a, a + (0, 60)]
    # Cross sections stay horizontal at hip and ankle. At the knee their
    # orientation follows the average bone rotation, preserving knee volume.
    def angle(p, q):
        v = q - p
        return math.atan2(v[1], v[0])
    upper_rotation = angle(h, k) - angle(hip, knee)
    lower_rotation = angle(k, a) - angle(knee, ankle)
    rotations = [0, 0, upper_rotation * .5,
                 (upper_rotation + lower_rotation) * .5, lower_rotation * .5, 0, 0]
    src_nodes, dst_nodes = [], []
    for s, d, theta in zip(src_centers, dst_centers, rotations):
        offset = np.array([math.cos(theta), math.sin(theta)]) * 46
        src_nodes.append([s + (-46, 0), s + (46, 0)])
        dst_nodes.append([d - offset, d + offset])
    sx = np.zeros((N, N), np.float32)
    sy = np.zeros((N, N), np.float32)
    coverage = np.zeros((N, N), bool)
    for row in range(len(src_nodes) - 1):
        for indices in [((row, 0), (row, 1), (row + 1, 1)),
                        ((row, 0), (row + 1, 1), (row + 1, 0))]:
            src = np.array([src_nodes[r][c] for r, c in indices])
            dst = np.array([dst_nodes[r][c] for r, c in indices])
            x0, y0 = np.maximum(0, np.floor(dst.min(axis=0)).astype(int))
            x1, y1 = np.minimum(N, np.ceil(dst.max(axis=0)).astype(int) + 1)
            y, x = np.mgrid[y0:y1, x0:x1]
            inv = np.linalg.inv(np.column_stack((dst[1] - dst[0], dst[2] - dst[0])))
            bary = inv @ np.stack([x - dst[0, 0], y - dst[0, 1]]).reshape(2, -1)
            u, v = bary.reshape(2, y1 - y0, x1 - x0)
            inside = (u >= -1e-5) & (v >= -1e-5) & (u + v <= 1 + 1e-5)
            mapped_x = src[0, 0] + u * (src[1, 0] - src[0, 0]) + v * (src[2, 0] - src[0, 0])
            mapped_y = src[0, 1] + u * (src[1, 1] - src[0, 1]) + v * (src[2, 1] - src[0, 1])
            sx[y0:y1, x0:x1][inside] = mapped_x[inside]
            sy[y0:y1, x0:x1][inside] = mapped_y[inside]
            coverage[y0:y1, x0:x1] |= inside
    result = sample(layer, sx, sy)
    alpha = np.asarray(result.getchannel('A')).copy()
    alpha[~coverage] = 0
    result.putalpha(Image.fromarray(alpha))
    return result


def animate(root):
    yy, xx = np.indices((N, N), dtype=np.float32)
    font = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 16)
    report = {'method': 'Directional raster bases, fixed-length hip/knee/ankle rig and rigid shoes',
              'version': 2, 'visualStatus': 'requires-review',
              'modelRequested': 'gpt-image-2.6-sunburst', 'frameSize': [256, 256],
              'masterFrameSize': [512, 512], 'anchor': [128, 230], 'columns': 4, 'rows': 3,
              'frameCount': 12, 'animations': {},
              'limitations': 'Cutout animation preserves fixed-perspective details; no newly drawn limb rotations.'}
    for who in ['boy', 'girl']:
        for direction in DIRECTIONS:
            source = Image.open(root / 'bases' / who / f'{direction}.png').convert('RGBA')
            rig = np.array(RIGS[f'{who}/{direction}'], dtype=float)
            rear = direction in ['nw', 'ne']
            cut = 330 if who == 'girl' and rear else int(rig[0, 0, 1])
            left = np.interp(yy, [cut, cut + 36, 390, 512],
                             [rig[0, 0, 0] - 22, rig[0, 1, 0] - 25, 180, 180])
            right = np.interp(yy, [cut, cut + 36, 390, 512],
                              [rig[1, 0, 0] + 22, rig[1, 1, 0] + 25, 340, 340])
            # Slanted legs cross a constant vertical divider, leaving a thin
            # disconnected strip on the other layer. Follow the empty gap.
            gap_centers = {
                'boy/sw': [261, 263, 268, 270], 'boy/se': [253, 254, 254, 253],
                'boy/nw': [262, 262, 261, 261], 'boy/ne': [252, 252, 252, 251],
                'girl/sw': [257, 266, 270, 275], 'girl/se': [260, 253, 246, 239],
                'girl/nw': [250, 261, 268, 271], 'girl/ne': [262, 257, 251, 242],
            }
            split = np.interp(yy, [270, 322, 352, 392, 460],
                              [float(rig[:, 0, 0].mean()), *gap_centers[f'{who}/{direction}']])
            leg_zone = (xx >= left) & (xx < right)
            body = source.copy()
            alpha = np.asarray(source.getchannel('A')).copy()
            alpha[(yy > cut + 5) & leg_zone] = 0
            body.putalpha(Image.fromarray(alpha))
            legs = []
            for lower, upper in [(left, split), (split, right)]:
                leg = source.copy()
                a = np.asarray(source.getchannel('A')).copy()
                a[(yy < cut - 10) | (xx < lower) | (xx >= upper)] = 0
                leg.putalpha(Image.fromarray(a))
                legs.append(leg)
            for action in ['idle', 'walk']:
                frames = []
                motion = []
                for i in range(12):
                    phase = 2 * math.pi * i / 12
                    if action == 'idle':
                        breathe = math.sin(phase)
                        upper_weight = 1 - smooth((yy - 240) / 155)
                        side = smooth((np.abs(xx - 256) - 40) / 65)
                        cloak = smooth((yy - 130) / 80) * (1 - smooth((yy - 305) / 30))
                        dx = 1.7 * math.sin(phase - .5) * side * cloak
                        sx = 256 + (xx - 256 - dx) / (1 + .003 * breathe * upper_weight)
                        sy = yy + 1.5 * breathe * upper_weight
                        frame = sample(source, sx, sy)
                    else:
                        frame = Image.new('RGBA', (N, N))
                        joints = []
                        screen_vector = np.array([1 if direction in ['se', 'ne'] else -1,
                                                  -.22 if rear else .22])
                        # Solve pelvis height from both contacts. A constant
                        # lowered pelvis makes every stance look like a squat.
                        # Keep the supporting knee close to extension, allowing
                        # only the amount of lowering required by the stride.
                        targets = []
                        minimum_drop = 0.0
                        for leg_i in range(2):
                            u = (i / 12 + leg_i * .5) % 1
                            travel, lift, planted = foot_path(u)
                            hip, knee, ankle = rig[leg_i]
                            target_ankle = ankle + screen_vector * travel - [0, lift]
                            length = np.linalg.norm(knee - hip) + np.linalg.norm(ankle - knee) - .6
                            dx = target_ankle[0] - hip[0]
                            max_vertical = math.sqrt(max(0, length * length - dx * dx))
                            minimum_drop = max(minimum_drop, target_ankle[1] - hip[1] - max_vertical)
                            targets.append((u, lift, planted, target_ankle))
                        bob = minimum_drop + .5
                        # Far leg is drawn first. A fixed camera never changes
                        # the near/far relationship during the gait cycle.
                        order = [0, 1] if direction in ['sw', 'ne'] else [1, 0]
                        for leg_i in order:
                            leg = legs[leg_i]
                            u, lift, planted, target_ankle = targets[leg_i]
                            hip, knee, ankle = rig[leg_i]
                            target_hip = hip + [0, bob]
                            upper_len, lower_len = np.linalg.norm(knee - hip), np.linalg.norm(ankle - knee)
                            target_knee = solve_leg(target_hip, target_ankle, upper_len, lower_len,
                                                    -int(screen_vector[0]))
                            frame.alpha_composite(deform_leg(leg, rig[leg_i], [target_hip, target_knee, target_ankle]))
                            joints.append({'leg': leg_i, 'phase': u, 'planted': planted,
                                           'lift': lift, 'hip': target_hip.tolist(),
                                           'knee': target_knee.tolist(), 'ankle': target_ankle.tolist(),
                                           'lengths': [float(upper_len), float(lower_len)]})
                        # Keep the lower trouser/cape seams stationary relative
                        # to the leg roots while sleeves and loose cloth sway.
                        side = smooth((np.abs(xx - 256) - 34) / 65)
                        cloth = smooth((yy - 135) / 85) * (1 - smooth((yy - 290) / 35))
                        dx = 2.5 * math.sin(phase - .5) * side * cloth
                        frame.alpha_composite(sample(body, xx - dx, yy - bob))
                        motion.append({'frame': i + 1, 'legs': sorted(joints, key=lambda j: j['leg']),
                                       'bodyBob': round(bob, 4)})
                    frames.append(frame)
                name = f'{action}-{direction}'
                for size in [512, 256]:
                    folder = root / f'frames-{size}' / who / name
                    folder.mkdir(parents=True, exist_ok=True)
                    atlas = Image.new('RGBA', (size * 4, size * 3))
                    for i, frame in enumerate(frames):
                        target = frame if size == 512 else frame.resize((size, size), Image.Resampling.LANCZOS)
                        target.save(folder / f'{i + 1:02}.png', optimize=True)
                        atlas.paste(target, (i % 4 * size, i // 4 * size))
                    out = root / ('runtime' if size == 256 else 'masters') / who
                    out.mkdir(parents=True, exist_ok=True)
                    atlas.save(out / f'{name}.png', optimize=True)
                contact = Image.new('RGB', (1024, 864), '#263f39')
                preview = []
                draw = ImageDraw.Draw(contact)
                for i, frame in enumerate(frames):
                    fg = frame.resize((256, 256), Image.Resampling.LANCZOS)
                    x, y = i % 4 * 256, i // 4 * 288
                    contact.paste(fg, (x, y + 24), fg)
                    draw.text((x + 12, y + 4), f'{who} {name} · {i + 1:02}', font=font, fill='white')
                    bg = Image.new('RGB', (256, 256), '#426c43')
                    bg.paste(fg, (0, 0), fg)
                    preview.append(bg)
                out = root / 'previews' / who
                out.mkdir(parents=True, exist_ok=True)
                contact.save(out / f'{name}-contact.jpg', quality=95)
                preview[0].save(out / f'{name}.gif', save_all=True, append_images=preview[1:],
                                duration=125 if action == 'idle' else [80, 80, 90] * 4, loop=0, disposal=2)
                report['animations'][f'{who}/{name}'] = {'atlas': f'runtime/{who}/{name}.png',
                    'fps': 8 if action == 'idle' else 12, 'source': f'bases/{who}/{direction}.png',
                    'sourceSha256': hashlib.sha256((root / 'bases' / who / f'{direction}.png').read_bytes()).hexdigest(),
                    'motion': motion, 'legCut': cut, 'stanceFraction': STANCE,
                    'stride512': STRIDE, 'travelPerCycle512': STRIDE / STANCE,
                    'screenVector': [1 if direction in ['se', 'ne'] else -1, -.22 if rear else .22]}
                print(f'Prepared {who}/{name}', flush=True)
    (root / 'manifest.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    prepare(args.root)
    if not args.prepare_only:
        animate(args.root)
