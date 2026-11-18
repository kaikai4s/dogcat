"""Extract the review landscape's repeating ground materials and upper-hemisphere sky.

Usage: python3 prepare-art.py reference.png OUTPUT
Coordinates refer to a 1100px-wide proof of the supplied 2048x1153 painting.
"""

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


GRASS = [
    ((351, 535), (427, 538), (425, 595), (346, 601)),
    ((473, 555), (537, 552), (557, 603), (480, 605)),
    ((353, 576), (408, 568), (409, 616), (345, 616)),
    ((131, 551), (209, 542), (211, 579), (148, 580)),
    ((265, 577), (312, 578), (323, 608), (256, 615)),
    ((882, 382), (957, 382), (946, 406), (879, 407)),
    ((476, 355), (552, 346), (548, 371), (470, 375)),
]
STONE = [
    ((711, 580), (754, 570), (831, 599), (786, 610)),
    ((765, 597), (803, 586), (883, 608), (838, 618)),
    ((665, 531), (702, 524), (716, 547), (680, 552)),
    ((680, 504), (720, 497), (705, 516), (669, 522)),
    ((692, 488), (750, 479), (728, 497), (684, 502)),
    ((712, 457), (773, 459), (766, 471), (716, 474)),
    ((674, 556), (716, 551), (747, 564), (701, 575)),
]
# Conservative hand-traced sky-side envelope; the transition is feathered upwards.
SKYLINE = [
    (0, 60), (18, 63), (40, 70), (73, 82), (108, 95), (132, 94),
    (155, 87), (184, 77), (214, 68), (226, 69), (248, 79), (278, 94),
    (300, 104), (323, 117), (354, 119), (376, 124), (392, 119),
    (405, 126), (437, 137), (466, 145), (497, 149), (525, 155),
    (550, 153), (574, 155), (600, 151), (625, 143), (650, 138),
    (665, 135), (685, 141), (704, 132), (731, 122), (754, 115),
    (773, 113), (790, 117), (819, 113), (851, 101), (883, 90),
    (920, 84), (944, 80), (969, 73), (994, 65), (1010, 65),
    (1031, 69), (1051, 72), (1073, 73), (1100, 69),
]


def smooth(t):
    t = np.clip(t, 0., 1.)
    return t * t * (3. - 2. * t)


def patches(source, quads, kind):
    size = 192
    dst = np.float32([(0, 0), (size-1, 0), (size-1, size-1), (0, size-1)])
    result = []
    for quad in quads:
        src = np.float32(quad) * (source.shape[1] / 1100.)
        H = cv2.getPerspectiveTransform(src, dst)
        cut = cv2.warpPerspective(source, H, (size, size), flags=cv2.INTER_CUBIC).astype('float32')
        # Remove broad directional shadow, but keep actual blade/stone shading and pigments.
        if kind == 'grass':
            blur = cv2.GaussianBlur(cut, (0, 0), 22)
            cut += .67 * (cut.mean((0, 1)) - blur)
        result.append(cut)
    means = np.array([p.mean((0, 1)) for p in result])
    base = np.median(means, axis=0)
    for i, p in enumerate(result):
        p += (base - means[i]) * (.88 if kind == 'stone' else .91)
    return result


def seam(error):
    h, w = error.shape
    score = error[0].copy()
    parents = np.empty((h, w), dtype='int8')
    x = np.arange(w)
    for y in range(1, h):
        prev = np.pad(score, 1, constant_values=1.e12)
        options = np.stack([prev[i:i+w] for i in range(3)])
        pick = options.argmin(0)
        score = options[pick, x] + error[y]
        parents[y] = pick - 1
    path = np.empty(h, dtype=int)
    path[-1] = score.argmin()
    for y in range(h-1, 0, -1):
        path[y-1] = path[y] + parents[y, path[y]]
    return path


def quilt(collection, rng):
    step, ov, repeats = 80, 32, 6
    dim, side = step * repeats, step + ov
    out = np.zeros((dim, dim, 3), np.float32)
    filled = np.zeros((dim, dim), bool)
    seq = np.arange(side)
    for by in range(repeats):
        for bx in range(repeats):
            region = np.ix_((step*by+seq) % dim, (step*bx+seq) % dim)
            dest, known = out[region], filled[region]
            best_cost, best = float('inf'), None
            for _ in range(32):
                src = collection[rng.integers(len(collection))]
                if rng.random() < .5:
                    src = src[:, ::-1]
                src = np.rot90(src, rng.integers(4))
                yi, xi = rng.integers(0, src.shape[0]-side+1, 2)
                candidate = src[yi:yi+side, xi:xi+side]
                cost = float(((candidate[known]-dest[known])**2).mean()) if known.any() else 0.
                if cost < best_cost:
                    best_cost, best = cost, candidate
            err = ((best-dest)**2).mean(2)
            err[~known] = 0
            alpha = np.ones((side, side), np.float32)
            # The last strip wraps over the first, allowing the minimum-error cut to
            # cross the texture boundary rather than leaving a fixed visible edge.
            if bx:
                alpha[:, :ov] *= seq[None, :ov] >= seam(err[:, :ov])[:, None]
            if bx == repeats-1:
                alpha[:, -ov:] *= seq[None, :ov] <= seam(err[:, -ov:])[:, None]
            if by:
                alpha[:ov] *= seq[:ov, None] >= seam(err[:ov].T)[None, :]
            if by == repeats-1:
                alpha[-ov:] *= seq[:ov, None] <= seam(err[-ov:].T)[None, :]
            alpha = cv2.GaussianBlur(alpha, (3, 3), .64)
            alpha[~known] = 1
            out[region] = dest + (best-dest)*alpha[..., None]
            filled[region] = True
    # Resample wrapped edge pixels too, so generated mipmaps have matching derivatives.
    out = np.pad(out, ((3, 3), (3, 3), (0, 0)), mode='wrap')
    x = (np.arange(512, dtype='float32')+.5)*dim/512-.5+3
    mx, my = np.meshgrid(x, x)
    return cv2.remap(out, mx, my, cv2.INTER_CUBIC)


def sky_map(src):
    h, w = 864, 6144
    az = (np.arange(w, dtype='float32')/w-.5)*(2*np.pi)
    center = np.float32([34., 29., 158.])
    forward = np.float32([-48., -26., -244.])
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0., 1., 0.]).astype('float32')
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    focal = 309.5/np.tan(np.deg2rad(18.))
    ref_height = src.shape[0]*1100./src.shape[1]
    origin_az = np.arctan2(forward[0], -forward[2])
    # Beyond the main perspective frame continue the painting around the dome,
    # reversing the flanks smoothly and closing the seam behind the viewer.
    dist = (az-origin_az+np.pi)%(2*np.pi)-np.pi
    flank = np.deg2rad(33.)
    folded = np.where(np.abs(dist)<flank,dist,
                      np.sign(dist)*flank*(1-(np.abs(dist)-flank)/(np.pi-flank)))
    mapped = origin_az+folded
    scale = src.shape[1]/1100.
    horizon,high,zenith = np.float32([[184,220,241],[71,151,211],[58,127,194]])
    result = np.empty((h,w,3),'float32')
    for start in range(0,h,48):
        stop = min(h,start+48)
        altitude = np.linspace(np.pi/2,0,h,dtype='float32')[start:stop,None]
        elev = np.rad2deg(altitude)
        x = 1770.*np.cos(altitude)*np.sin(mapped)-center[0]
        y = 1770.*np.sin(altitude)-center[1]
        z = -1770.*np.cos(altitude)*np.cos(mapped)-center[2]
        depth = np.maximum(x*forward[0]+y*forward[1]+z*forward[2],1.)
        sx = 549.5+focal*(x*right[0]+z*right[2])/depth
        sx = 1099.-np.abs(np.mod(sx,2198.)-1099.)
        sy = ref_height*.5-focal*(x*up[0]+y*up[1]+z*up[2])/depth
        crest = np.interp(sx,*np.transpose(SKYLINE)).astype('float32')
        lookup_y = np.where(sy>=0,sy,np.minimum(-sy*.32,18.))
        sample = cv2.remap(src,(sx*scale).astype('float32'),(lookup_y*scale).astype('float32'),
                           cv2.INTER_CUBIC,borderMode=cv2.BORDER_REPLICATE).astype('float32')
        mask = smooth((crest-sy-2.5)/10.)*smooth((sy+74.)/74.)
        base = horizon+(high-horizon)*smooth(elev/27.)[...,None]
        base += (zenith-high)*smooth((elev-27.)/55.)[...,None]
        result[start:stop] = base+(sample-base)*mask[...,None]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference', type=Path)
    parser.add_argument('output', type=Path)
    args=parser.parse_args()
    with Image.open(args.reference) as image:
        reference=np.asarray(image.convert('RGB'))
    if abs(reference.shape[1]/reference.shape[0]-2048/1153)>.025:
        parser.error('Expected the original uncropped manor reference (2048:1153).')
    args.output.mkdir(parents=True, exist_ok=True)
    cv2.setNumThreads(1)
    rng=np.random.default_rng(9134)
    for name,make in [
        ('meadow.jpg', lambda: quilt(patches(reference, GRASS, 'grass'), rng)),
        ('flagstone.jpg', lambda: quilt(patches(reference, STONE, 'stone'), rng)),
        ('sky.jpg', lambda: sky_map(reference)),
    ]:
        rgb=np.clip(np.rint(make()),0,255).astype('uint8')
        Image.fromarray(rgb).save(args.output/name, 'JPEG', quality=95, subsampling=0, optimize=True)
        mean=rgb.mean((0,1)).round().astype(int)
        print(f'{name} {rgb.shape[1]}x{rgb.shape[0]} sRGB #' + ''.join(f'{v:02x}' for v in mean), flush=True)


if __name__ == '__main__':
    main()
