import assert from 'node:assert/strict';
import {copyFile, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as THREE from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {rolldown} from 'rolldown';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../..'), defaultOutput=join(root,'output/manor-building-valley');
const require=createRequire(import.meta.url);
const threeLicense=resolve(dirname(require.resolve('three')),'../LICENSE');

// The exporter uses two asynchronous Blob reads to assemble a binary GLB.
if(typeof globalThis.FileReader==='undefined') {
  globalThis.FileReader=class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(bytes=>{this.result=bytes;this.onloadend?.();},err=>{this.error=err;this.onerror?.(err);});
    }
  };
}

async function artInputs(directory) {
  const textures={},sources=new Map();
  const files=(await readdir(directory)).filter(s=>/\.(?:jpe?g|png)$/i.test(s)).sort();
  for(const file of files){
    const bytes=await readFile(join(directory,file)), mimeType=/\.png$/i.test(file)?'image/png':'image/jpeg';
    const source={file},texture=new THREE.Texture(source);
    texture.name=file;texture.flipY=false;texture.colorSpace=THREE.SRGBColorSpace;
    texture.userData.mimeType=mimeType;
    textures[file]=texture;sources.set(source,{file,bytes,mimeType});
  }
  return {textures,sources};
}

function embedArt(exporter,sources){
  exporter.register(writer=>{
    const indexes=new Map();
    writer.processImage=(image,format,flipY)=>{
      const art=sources.get(image);
      assert(art,'A material references an image that did not come from the art directory');
      assert.equal(flipY,false,'Texture must use glTF UVs (row zero at v=0): '+art.file);
      if(indexes.has(image))return indexes.get(image);
      const images=writer.json.images??=[],views=writer.json.bufferViews??=[];
      const padded=new Uint8Array((art.bytes.byteLength+3)&~3);padded.set(art.bytes);
      const bv=views.push({buffer:writer.processBuffer(padded.buffer),byteOffset:writer.byteOffset,byteLength:art.bytes.byteLength})-1;
      writer.byteOffset+=padded.byteLength;
      const idx=images.push({name:art.file,mimeType:art.mimeType,bufferView:bv})-1;
      indexes.set(image,idx);return idx;
    };
    return {name:'RawCanvasFreeImages'};
  });
}

async function runtime(out){
  const vendor=join(out,'vendor');
  await mkdir(vendor,{recursive:true});
  const build=await rolldown({
    cwd:root,input:join(here,'scene-runtime.mjs'), platform:'browser',logLevel:'warn'
  });
  try{await build.write({file:join(vendor,'scene-runtime.js'),format:'iife',minify:true,comments:{legal:true}});}
  finally{await build.close();}
  await copyFile(threeLicense,join(vendor,'THREE-LICENSE.txt'));
  await copyFile(join(here,'viewer.html'),join(out,'index.html'));
}

export async function buildValley(out,makeValley){
  out=resolve(out);const {textures,sources}=await artInputs(join(out,'art'));
  const {scene,layout}=await makeValley(THREE,textures);
  const exporter=new GLTFExporter();embedArt(exporter,sources);
  const binary=Buffer.from(await exporter.parseAsync(scene,{binary:true}));
  const gltf=JSON.parse(binary.subarray(20,20+binary.readUInt32LE(12)).toString('utf8'));
  const binStart=28+binary.readUInt32LE(12);
  for(const image of gltf.images??[]) {
    const bv=gltf.bufferViews[image.bufferView],start=binStart+(bv.byteOffset??0);
    const expected=sources.get(textures[image.name]?.image);
    assert(expected && !image.uri && binary.subarray(start,start+bv.byteLength).equals(expected.bytes),'Embedded texture mismatch: '+image.name);
  }
  await runtime(out);
  await writeFile(join(out,'manor.glb'),binary);
  await writeFile(join(out,'layout.json'),JSON.stringify(layout,null,2)+'\n');
  console.log('Built '+join(out,'manor.glb')+' ('+(binary.length/1048576).toFixed(1)+' MiB; '+(gltf.meshes?.length??0)+' meshes; '+(gltf.images?.length??0)+' embedded images)');
  return {binary,gltf};
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {makeValley}=await import('./world.mjs');
  await buildValley(process.argv[2]??defaultOutput,makeValley);
}
