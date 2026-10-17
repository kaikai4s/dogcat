"""Extract the four user-provided cat poses without synthesizing missing poses."""
from pathlib import Path
import json
import zipfile
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(r'C:\Users\16377\AppData\Local\Temp\codex-clipboard-39545d63-d05b-4338-88aa-326da6abd0b5.png')
OUT = ROOT / 'output' / 'orange-cat-walk-v2'


def cutout(image):
    rgb = np.asarray(image.convert('RGB'))
    # Only remove near-white pixels connected to the outside of each crop.
    # White fur enclosed by the illustration's outline remains opaque.
    candidate = (rgb.min(axis=2) >= 238) & ((rgb.max(axis=2).astype(int)-rgb.min(axis=2)) < 12)
    mask = Image.fromarray(np.where(candidate, 255, 0).astype('uint8')).copy()
    for x in range(mask.width):
        for y in (0, mask.height-1):
            if mask.getpixel((x,y)) == 255:
                ImageDraw.floodfill(mask, (x,y), 128)
    for y in range(mask.height):
        for x in (0, mask.width-1):
            if mask.getpixel((x,y)) == 255:
                ImageDraw.floodfill(mask, (x,y), 128)
    background = np.asarray(mask) == 128
    alpha = np.where(background, 0, 255).astype('uint8')
    # Unmatte just the edge next to exterior white; do not key the whole cat.
    exterior_band = np.asarray(Image.fromarray(np.where(background,255,0).astype('uint8')).filter(ImageFilter.MaxFilter(3))) > 0
    edge = exterior_band & ~background
    opacity = np.clip((255-rgb.min(axis=2).astype(float))/35, 0, 1)
    alpha[edge] = np.rint(opacity[edge]*255).astype('uint8')
    result = image.convert('RGBA')
    result.putalpha(Image.fromarray(alpha))
    return result.crop(result.getbbox())


def main():
    if OUT.exists():
        raise SystemExit('Refusing to overwrite existing output')
    OUT.mkdir(parents=True)
    source = Image.open(SOURCE).convert('RGB')
    source.save(OUT/'source-sheet.png')
    boxes = [(0,140,440,525),(440,140,900,525),(20,530,520,945),(530,530,1024,945)]
    frames = []
    for index, box in enumerate(boxes, 1):
        cropped = cutout(source.crop(box))
        # Register every pose to the same overall height and ground baseline.
        scale = min(390/cropped.height, 460/cropped.width)
        sprite = cropped.resize((round(cropped.width*scale), round(cropped.height*scale)), Image.Resampling.LANCZOS)
        frame = Image.new('RGBA',(512,512))
        frame.alpha_composite(sprite,((512-sprite.width)//2,460-sprite.height))
        frames.append(frame)
        for size in (256,512):
            folder=OUT/f'frames-{size}'
            folder.mkdir(exist_ok=True)
            frame.resize((size,size),Image.Resampling.LANCZOS).save(folder/f'walk-{index:02d}.png')
    atlas=Image.new('RGBA',(1024,256))
    for index, frame in enumerate(frames):
        atlas.alpha_composite(frame.resize((256,256),Image.Resampling.LANCZOS),(256*index,0))
    upload=OUT/'cloud-upload'
    upload.mkdir()
    atlas.save(upload/'walk.png',optimize=True)
    atlas.save(OUT/'walk.png',optimize=True)
    previews=[]
    contact=Image.new('RGB',(1024,300),(48,65,73))
    for index,frame in enumerate(frames):
        small=frame.resize((256,256),Image.Resampling.LANCZOS)
        bg=Image.new('RGB',(256,256),(48,65,73))
        bg.paste(small,(0,0),small)
        previews.append(bg)
        contact.paste(bg,(256*index,0))
        ImageDraw.Draw(contact).text((256*index+12,272),f'FRAME {index+1}',fill='white')
    contact.save(OUT/'frames-preview.jpg',quality=95)
    previews[0].save(OUT/'walk-preview.gif',save_all=True,append_images=previews[1:],duration=160,loop=0,disposal=2)
    manifest={'action':'walk','frames':4,'columns':4,'rows':1,'cell':[256,256],'anchor':[0.5,460/512],'frame_duration_ms':160,'direction':'reference-facing-right','method':'Four supplied poses, background extraction and registration only; no generated intermediate frames','runtime_note':'Existing 12-frame character configuration does not apply to this four-frame pet atlas.'}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    with zipfile.ZipFile(OUT/'cat-walk-materials.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(OUT.rglob('*')):
            if file.is_file() and file.suffix!='.zip':
                archive.write(file,file.relative_to(OUT))
    print(OUT)


if __name__=='__main__':
    main()
