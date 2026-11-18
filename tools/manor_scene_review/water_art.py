"""Prepare a repeatable creek texture and a cutout for distant hillside trees."""
from pathlib import Path
import argparse
import importlib.util
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

parser = argparse.ArgumentParser()
parser.add_argument('reference', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
ref = Image.open(args.reference).convert('RGB')
rgb = np.asarray(ref)
spec = importlib.util.spec_from_file_location('surfaces', Path(__file__).with_name('prepare-art.py'))
surface = importlib.util.module_from_spec(spec)
spec.loader.exec_module(surface)
quads = [((548,478),(570,476),(578,485),(552,487)),
         ((560,492),(589,486),(608,499),(573,504)),
         ((545,469),(564,464),(575,472),(548,477)),
         ((557,454),(575,449),(577,456),(561,463)),
         ((555,499),(575,497),(592,504),(565,510))]
patches = surface.patches(rgb,quads,'grass')
tile = surface.quilt(patches,np.random.default_rng(68015))
# Leave the water depth and bridge shadow to the model. Preserve the painted
# reflected sky, irregular highlights and short refracted strokes.
mean = tile.mean((0,1))
tone = np.clip(np.array([116,174,177])+(tile-mean)*1.38,0,255)
Image.fromarray(tone.astype('uint8')).save(args.output/'creek.jpg',quality=94)
stone=np.asarray(Image.open(args.output/'flagstone.jpg').convert('L'),dtype='float32')
grain=np.clip(223+(stone-stone.mean())*.62,167,250).astype('uint8')
Image.fromarray(grain).convert('RGB').save(args.output/'limestone-grain.jpg',quality=90)

outline=[(768,400),(773,399),(772,395),(779,391),(782,389),(778,387),(782,383),
 (787,383),(785,379),(796,378),(798,375),(803,375),(805,378),(810,377),(813,381),
 (817,381),(816,387),(823,390),(819,394),(827,397),(831,400),(828,403),(833,406),
 (829,409),(834,411),(830,414),(826,414),(823,419),(817,417),(815,421),(808,419),
 (803,423),(800,430),(800,436),(795,437),(795,426),(792,420),(788,417),(784,419),
 (778,419),(777,416),(772,417),(770,412),(765,411),(767,408),(764,404)]
factor=ref.width/1100
mask=Image.new('L',ref.size,0)
ImageDraw.Draw(mask).polygon([(round(x*factor),round(y*factor)) for x,y in outline],fill=255)
crop=[int(x*factor) for x in (760,370,838,440)]
forest=ref.crop(crop); alpha=np.asarray(mask.crop(crop).filter(ImageFilter.GaussianBlur(.55))).astype(float)
pix=np.asarray(forest).astype(float)
# Exclude yellow grass in the gaps between the trunk branches.
yy=np.indices(alpha.shape)[0]/alpha.shape[0]
alpha[(yy>.68)&(pix[:,:,1]>115)&(pix[:,:,0]/(pix[:,:,1]+1)>.83)]=0
forest.putalpha(Image.fromarray(alpha.astype('uint8')))
forest.save(args.output/'foothill-tree.png')
