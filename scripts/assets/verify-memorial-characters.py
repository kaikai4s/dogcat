"""Check memorial alpha, slicing, frame counts, continuity and limb connectivity."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    root = args.root
    report = {'animations': {}, 'totalFrames': 0}
    manifest = json.loads((root / 'manifest.json').read_text())
    for who in ['boy', 'girl']:
        for action in ['idle', 'walk']:
            for direction in ['sw', 'se', 'nw', 'ne']:
                key = f'{who}/{action}-{direction}'
                atlas = Image.open(root / 'runtime' / f'{key}.png')
                assert atlas.size == (1024, 768) and atlas.mode == 'RGBA', key
                hashes, pixels, detached = set(), [], []
                for i in range(12):
                    im = Image.open(root / 'frames-256' / key / f'{i + 1:02}.png')
                    a = np.asarray(im)[:, :, 3]
                    assert a.min() == 0 and a.max() == 255, (key, i, 'alpha')
                    assert max(a[0].max(), a[-1].max(), a[:, 0].max(), a[:, -1].max()) == 0, (key, i, 'clipped')
                    cell = atlas.crop((i % 4 * 256, i // 4 * 256, i % 4 * 256 + 256, i // 4 * 256 + 256))
                    assert cell.tobytes() == im.tobytes(), (key, i, 'slice')
                    hashes.add(hashlib.sha256(im.tobytes()).hexdigest())
                    # Low threshold includes thin antialiased hair connections.
                    m = im.getchannel('A').point(lambda v: 255 if v > 24 else 0)
                    ImageDraw.floodfill(m, (128, 50), 128)
                    islands = np.asarray(m) == 255
                    # A thin ribbon can disconnect after downsampling. Below
                    # the knee there should be no detached limb-sized fragments.
                    lower_islands = int(islands[175:].sum())
                    assert lower_islands < 16, (key, i, 'detached lower-leg pixels', lower_islands)
                    detached.append(lower_islands)
                    p = np.asarray(im).astype(np.float32) / 255
                    p[:, :, :3] *= p[:, :, 3:4]
                    pixels.append(p)
                assert len(hashes) == 12, (key, 'duplicate frame')
                diffs = [float(np.abs(pixels[(i + 1) % 12] - pixels[i]).mean()) for i in range(12)]
                assert diffs[-1] < max(diffs[:-1]) * 1.5, (key, 'loop boundary jump')
                report['totalFrames'] += 12
                report['animations'][key] = {'uniqueFrames': 12, 'realAlpha': True, 'noEdgeClipping': True,
                    'atlasMatchesFrames': True, 'detachedLowerPixelsMax': max(detached),
                    'loopBoundaryDifference': diffs[-1], 'maxAdjacentDifference': max(diffs)}
                if action == 'walk':
                    animation = manifest['animations'][key]
                    assert manifest.get('version') == 2, 'Old raster-shear gait is not accepted'
                    motion = animation['motion']
                    velocity = np.array(animation['screenVector']) * animation['travelPerCycle512']
                    bone_errors, planted_drift = [], []
                    for i, pose in enumerate(motion):
                        assert any(leg['planted'] for leg in pose['legs']), (key, i, 'both feet airborne')
                        for leg in pose['legs']:
                            h, k, a = map(np.array, [leg['hip'], leg['knee'], leg['ankle']])
                            lengths = [np.linalg.norm(k - h), np.linalg.norm(a - k)]
                            bone_errors.extend(abs(float(x) - expected) for x, expected in zip(lengths, leg['lengths']))
                            if leg['planted']:
                                assert leg['lift'] == 0, (key, i, 'planted foot is lifted')
                            if i > 0:
                                previous = motion[i - 1]['legs'][leg['leg']]
                                if previous['planted'] and leg['planted'] and leg['phase'] > previous['phase']:
                                    previous_world = np.array(previous['ankle']) + velocity * (i - 1) / 12
                                    current_world = a + velocity * i / 12
                                    planted_drift.append(float(np.linalg.norm(current_world - previous_world)))
                    assert max(bone_errors) < 1e-6, (key, 'bone length changed')
                    assert planted_drift and max(planted_drift) < 1e-6, (key, 'planted foot slides')
                    report['animations'][key]['kinematics'] = {'maxBoneLengthError': max(bone_errors),
                        'maxPlantedFootWorldDrift': max(planted_drift), 'supportEveryFrame': True}
    report['status'] = 'passed'
    report['scope'] = 'Structure, alpha, slicing, limb connectivity, loop continuity, fixed bone lengths, ground support and planted ankle drift. Visual acceptance is separate.'
    (root / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'PASS: {len(report["animations"])} atlases, {report["totalFrames"]} frames')


if __name__ == '__main__':
    main()
