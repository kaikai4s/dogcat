"""Package the user's 4 by 6 dog pose sheet as transparent registered frames."""
from pathlib import Path
import importlib.util
import json
import zipfile
import numpy as np
from PIL import Image, ImageDraw, ImageChops, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(r'C:\Users\16377\AppData\Local\Temp\codex-clipboard-790bb075-fa6b-46ae-87d8-47b5a8b7284f.png')
OUT = ROOT / 'output' / 'cream-dog-walk-24-v2'
spec = importlib.util.spec_from_file_location('pet_cutout', Path(__file__).with_name('package-cat-walk.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def clear_leg_gaps(image):
    data = np.array(image)
    rgb = data[:,:,:3]
    candidate = (rgb.min(2)>238) & (rgb.max(2).astype(int)-rgb.min(2)<12) & (data[:,:,3]>0)
    mask = Image.fromarray((candidate*255).astype('uint8')).copy()
    gaps = np.zeros(candidate.shape,dtype=bool)
    for y,x in np.argwhere(candidate):
        if mask.getpixel((int(x),int(y))) != 255:
            continue
        before = np.asarray(mask).copy()
        ImageDraw.floodfill(mask,(int(x),int(y)),128)
        region = (before==255) & (np.asarray(mask)==128)
        yy,xx = np.where(region)
        # Near-pure white enclosed below the torso is background between legs.
        # Keep the cream chest and paw shading intact.
        if len(xx)>8 and yy.min()>image.height*.6 and rgb[region].min(1).mean()>248:
            gaps |= region
    data[gaps,3]=0
    band = (np.asarray(Image.fromarray((gaps*255).astype('uint8')).filter(ImageFilter.MaxFilter(3)))>0) & ~gaps
    alpha = np.clip((255-rgb.min(2).astype(float))/35,0,1)*255
    data[:,:,3][band] = np.minimum(data[:,:,3][band],alpha[band]).astype('uint8')
    return Image.fromarray(data)


def main(source_path=SOURCE, output_path=OUT, rows=6, animal='dog', row_boundaries=None):
    OUT = Path(output_path)
    count = 4 * rows
    if OUT.exists():
        raise SystemExit('Refusing to overwrite existing output')
    OUT.mkdir(parents=True)
    source = Image.open(source_path).convert('RGB')
    row_boundaries = row_boundaries or [round(row*source.height/rows) for row in range(rows+1)]
    assert len(row_boundaries) == rows+1
    source.save(OUT/'source-sheet.png')
    folder = OUT/'frames-256'
    folder.mkdir()
    upload = OUT/'cloud-upload'
    upload.mkdir()
    atlas = Image.new('RGBA', (1024,256*rows))
    contact = Image.new('RGB', (768,216*rows), (48,65,73))
    previews, checks = [], []
    for index in range(count):
        col, row = index % 4, index // 4
        box = (round(col*source.width/4), row_boundaries[row],
               round((col+1)*source.width/4), row_boundaries[row+1])
        cropped = clear_leg_gaps(helper.cutout(source.crop(box)))
        scale = min(195/cropped.height, 230/cropped.width)
        sprite = cropped.resize((round(cropped.width*scale),round(cropped.height*scale)),Image.Resampling.LANCZOS)
        frame = Image.new('RGBA',(256,256))
        frame.alpha_composite(sprite, ((256-sprite.width)//2,230-sprite.height))
        frame.save(folder/f'walk-{index+1:02d}.png',optimize=True)
        atlas.alpha_composite(frame,(col*256,row*256))
        bg = Image.new('RGB',(256,256),(48,65,73))
        bg.paste(frame,(0,0),frame)
        previews.append(bg)
        contact.paste(bg.resize((192,192),Image.Resampling.LANCZOS),(col*192,row*216))
        ImageDraw.Draw(contact).text((col*192+12,row*216+194),f'FRAME {index+1:02d}',fill='white')
        a = np.asarray(frame)[:,:,3]
        assert a[0,:].max()==0 and a[-1,:].max()==0 and a[:,0].max()==0 and a[:,-1].max()==0
        checks.append({'frame':index+1,'source_box':box,'bounds':frame.getbbox(),'opaque_pixels':int((a==255).sum())})
    atlas.save(upload/'walk.png',optimize=True)
    atlas.save(OUT/'walk.png',optimize=True)
    for index in range(count):
        cell=atlas.crop((index%4*256,index//4*256,index%4*256+256,index//4*256+256))
        original=Image.open(folder/f'walk-{index+1:02d}.png')
        assert ImageChops.difference(original,cell).getbbox() is None
    contact.save(OUT/'frames-preview.jpg',quality=95)
    previews[0].save(OUT/'walk-preview.gif',save_all=True,append_images=previews[1:],duration=100,loop=0,disposal=2)
    manifest={'action':'walk','frames':count,'columns':4,'rows':rows,'cell':[256,256],'atlas':[1024,256*rows],
              'anchor':[0.5,230/256],'frame_duration_ms':100,'order':'left to right, top to bottom',
              'direction':'reference-facing-right','source_resolution':list(source.size),
              'method':'Supplied poses cut out and aligned; no new poses or AI detail generation',
              'runtime_note':f'Requires {count}-frame pet animation configuration after cloud upload.'}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    (OUT/'verification.json').write_text(json.dumps({'transparent_borders':True,'all_atlas_cells_match_frames':True,'frames':checks},indent=2),encoding='utf-8')
    with zipfile.ZipFile(OUT/f'{animal}-walk-materials.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(OUT.rglob('*')):
            if file.is_file() and file.suffix!='.zip':
                archive.write(file,file.relative_to(OUT))
    print(OUT)
    print(f'Verified {count} transparent frames and matching 4x{rows} atlas.')


if __name__=='__main__':
    main()
