import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {rolldown} from 'rolldown';
import * as T from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {buildArchitecture} from './architecture.mjs';
import {buildRoofs} from './roofs.mjs';
import {makeTextures} from './textures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here,'../..');
const out = resolve(process.argv[2] || join(root,'output/manor-villa-review'));
const require = createRequire(import.meta.url);
const license = resolve(dirname(require.resolve('three')),'../LICENSE');

if (!globalThis.FileReader) {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(result => {
        this.result = result;
        this.onloadend?.();
      }, error => {
        this.error = error;
        this.onerror?.(error);
      });
    }
  };
}

async function prepareArt() {
  const work = await mkdtemp(join(tmpdir(),'dogcat-villa-art-'));
  const art = {}, sources = new Map();
  try {
    const files = await makeTextures(work);
    for (const [key,file] of Object.entries(files)) {
      const bytes = await readFile(file), name = file.split('/').at(-1);
      const source = {name}, texture = new T.Texture(source);
      texture.name = name;
      texture.flipY = false;
      texture.colorSpace = key.endsWith('Color') ? T.SRGBColorSpace : T.NoColorSpace;
      texture.wrapS = texture.wrapT = T.RepeatWrapping;
      texture.userData.mimeType = 'image/png';
      art[key] = texture;
      sources.set(source,{bytes,name});
    }
  } finally {
    await rm(work,{recursive:true,force:true});
  }
  return {art,sources};
}

function buildMaterials(a) {
  const standard = (name,parameters) => new T.MeshStandardMaterial({name,...parameters});
  const relief = {plaster:.44, stone:.69, wood:.61, roof:.66};
  const textured = (name,key,color,roughness,extra={}) => standard(name,{
    color,roughness,map:a[key+'Color'],
    // PNGs already use glTF tangent-space orientation; geometry has no tangents.
    ...(a[key+'Normal'] && {normalMap:a[key+'Normal'],normalScale:new T.Vector2(relief[key],-relief[key])}),...extra,
  });
  const palette = (name,key,values,roughness,extra) => values.map((color,i) =>
    textured(name+' '+(i+1),key,color,roughness,extra));
  const woodTones = palette('Weathered oak','wood',[0xc4b1a3,0xa68b76,0xd4c0b0,0xbca791],.82);
  const tileTones = palette('Hand fired terracotta','roof',[0xe9cabf,0xbda39b,0xf7e5da,0xceaea2,0xe9d1bf],.86);
  return {
    plaster:textured('Warm lime plaster','plaster',0xfffaf1,.94),
    mortar:textured('Stone mortar','stone',0xac9882,.96),
    stoneTones:palette('Dressed limestone','stone',[0xdeceb6,0xf1e2ca,0xfff1d7,0xcbbaa0,0xe2d8c3,0xbfae97],.92),
    wood:woodTones[1],woodEdge:woodTones[2],woodTones,
    tile:tileTones[0],tileDetail:tileTones[1],tileTones,
    door:textured('Stained oak door boards','wood',0xbb9a78,.8),
    glass:textured('Recessed glass','glass',0x96918c,.47,{metalness:.08}),
    glassTones:palette('Leaded glass','glass',[0xb6b7b0,0xc1c5bb,0xcfc9bf,0xb5c1c6,0xc3b6a4,0xb4b5b4],.38,{metalness:.12}),
    lead:textured('Glazing cames and hinges','metal',0x886c59,.6,{metalness:.33}),
    brass:standard('Door brass',{color:0x9a7144,roughness:.37,metalness:.38}),
    peg:standard('Carpenter pins',{color:0x39251d,roughness:.92}),
    soot:standard('Soot inside flues',{color:0x3a3027,roughness:.98}),
    pottery:standard('Clay garden pots',{color:0x9f5a3c,roughness:.92}),
    leaves:[0x3b5124,0x526929,0x5e7631,0x394726,0x798748].map((color,i)=>
      standard('Boxwood '+(i+1),{color,roughness:.91})),
  };
}

function embedImages(exporter,sources) {
  exporter.register(writer=>{
    const imageIds = new Map();
    writer.processImage = (image,format,flipY) => {
      const art = sources.get(image);
      assert(art && !flipY,'Invalid embedded texture source');
      if (imageIds.has(image)) return imageIds.get(image);
      const images = writer.json.images ??= [], views = writer.json.bufferViews ??= [];
      const data = new Uint8Array((art.bytes.byteLength+3)&~3);
      data.set(art.bytes);
      const bufferView = views.push({
        buffer:writer.processBuffer(data.buffer), byteOffset:writer.byteOffset,byteLength:art.bytes.byteLength,
      })-1;
      writer.byteOffset += data.byteLength;
      const id = images.push({name:art.name,mimeType:'image/png',bufferView})-1;
      imageIds.set(image,id);
      return id;
    };
    return {name:'RawPngs'};
  });
}

function verifyGLB(binary,sources) {
  assert.equal(binary.readUInt32LE(0),0x46546c67);
  assert.equal(binary.readUInt32LE(8),binary.length);
  const jsonLength = binary.readUInt32LE(12);
  const gltf = JSON.parse(binary.subarray(20,20+jsonLength).toString('utf8'));
  const binOffset = 28+jsonLength;
  assert(gltf.meshes.length>0 && gltf.buffers.length===1 && !gltf.buffers[0].uri);
  const rootNode = gltf.nodes[gltf.scenes[gltf.scene].nodes[0]];
  assert(rootNode.translation?.every(Number.isFinite),'Missing finite floor pivot');
  const lookup = new Map([...sources.values()].map(({name,bytes})=>[name,bytes]));
  assert.equal(gltf.images?.length,lookup.size);
  for (const image of gltf.images) {
    const view = gltf.bufferViews[image.bufferView],start=binOffset+(view.byteOffset||0);
    assert(!image.uri && binary.subarray(start,start+view.byteLength).equals(lookup.get(image.name)),
      'Missing inline PNG '+image.name);
  }
  return gltf;
}

const {art,sources} = await prepareArt();
const m = buildMaterials(art);
const scene = new T.Scene();
scene.name = 'Manor villa';
const villa = buildArchitecture(m);
villa.add(buildRoofs(T,m));
const bounds = new T.Box3().setFromObject(villa), size = bounds.getSize(new T.Vector3());
const center = bounds.getCenter(new T.Vector3());
villa.position.set(-center.x,-bounds.min.y,-center.z);
// GLTFLoader reserves extras.pivot for a numeric pivot transform.
villa.userData = {units:'meters',up:'+Y',front:'+Z',origin:'floor center'};
scene.add(villa);
assert(size.x>17 && size.x<21 && size.y>12 && size.y<14 && size.z>10 && size.z<12);
let faces = 0;
scene.traverse(node=>{
  if (!node.isMesh) return;
  const g = node.geometry;
  assert(g.attributes.position.array.every(Number.isFinite) && g.attributes.normal.array.every(Number.isFinite), node.name);
  faces += (g.index?.count ?? g.attributes.position.count)/3;
});
const exporter = new GLTFExporter();
embedImages(exporter,sources);
const binary = Buffer.from(await exporter.parseAsync(scene,{binary:true,onlyVisible:true,trs:true}));
const gltf = verifyGLB(binary,sources);
const vendor = join(out,'vendor');
await mkdir(vendor,{recursive:true});
const runtime = await rolldown({cwd:root,input:join(here,'scene-runtime.mjs'),platform:'browser',logLevel:'warn'});
try {
  await runtime.write({file:join(vendor,'scene-runtime.js'),format:'iife',minify:true,comments:{legal:true}});
} finally {
  await runtime.close();
}
const data = {
  model:'manor-villa.glb', dimensionsMeters:size.toArray().map(n=>Number(n.toFixed(2))),
  front:'+Z',up:'+Y',pivot:'floor center',triangles:faces,meshBatches:gltf.meshes.length,embeddedTextures:gltf.images.length,
};
await Promise.all([
  copyFile(license,join(vendor,'THREE-LICENSE.txt')),
  copyFile(join(here,'viewer.html'),join(out,'index.html')),
  writeFile(join(out,'model.json'),JSON.stringify(data,null,2)+'\n'),
  writeFile(join(out,data.model),binary),
]);
console.log('Built '+join(out,data.model)+' ('+(binary.byteLength/1048576).toFixed(2)+' MiB)');
console.log(JSON.stringify(data));
