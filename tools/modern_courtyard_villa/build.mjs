import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildArchitecture, ELEVATION } from './architecture.mjs';
import { furnish } from './interiors.mjs';
import { addGarden } from './garden.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] ?? join(here, '../../output/modern-courtyard-villa'));
const require = createRequire(import.meta.url);
const modelName = 'courtyard-villa.glb';
const { root, rooms } = buildArchitecture();
assert(root?.isGroup && Array.isArray(rooms), 'Architecture must supply a model and a room list');
root.name = 'Songying Courtyard Villa';
for (const level of [1, 2, 3]) {
  const floor = root.children.find((part) => part.name === 'F' + level);
  assert(floor, 'Missing floor ' + level);
  for (const name of ['Exterior', 'Walls', 'Structure', 'Furniture']) {
    assert(floor.children.some((part) => part.name === name), 'Missing F' + level + '/' + name);
  }
  const furniture = floor.children.find((part) => part.name === 'Furniture');
  // The furniture kit is drawn from each finished floor. The walls and slab are drawn in site coordinates.
  furniture.position.y = floor.worldToLocal(new THREE.Vector3(0, ELEVATION[level], 0)).y;
  furnish(furniture, level);
  assert(furniture.children.length, 'Missing furniture on floor ' + level);
  const base = new THREE.Box3().setFromObject(furniture).min.y;
  assert(Math.abs(base - ELEVATION[level]) < .12, 'Furniture does not meet the slab on floor ' + level);
}

const garden = new THREE.Group();
garden.name = 'Garden';
addGarden(garden);
assert(garden.children.length, 'Empty garden');
root.add(garden);
const outdoor = [
  { id:'arrival', name:'北侧入户前庭', level:0, position:[7.7,.6,-3.7], description:'入口铺装从落客区引向北玄关，西侧留出开放车位。' },
  { id:'pine-court', name:'松下坐席', level:0, position:[2,.65,19.5], description:'一株造型松压低视线，木椅朝中央石径和镜池布置。', featured:true },
  { id:'mirror-pool', name:'东侧镜池', level:0, position:[13.3,.68,19.65], description:'浅水与深色池沿一起衬出白墙、灰檐和园中植栽。', featured:true },
  { id:'south-garden', name:'南庭院', level:0, position:[8,.55,23.2], description:'沿中央石径回看，从二层长阳台到三层屋顶花园的退台层次一目了然。', featured:true },
];
const markers = [...rooms, ...(garden.userData.rooms ?? outdoor)];
assert.equal(new Set(markers.map((label) => label.id)).size, markers.length, 'Duplicate area IDs');
for (const level of [0, 1, 2, 3]) assert(markers.some((label) => label.level === level), 'Missing area labels at level ' + level);
for (const label of markers) {
  assert(label.id && label.name && label.description && label.position?.length === 3 &&
    label.position.every(Number.isFinite), 'Invalid area label: ' + label.id);
}
root.userData = { ...root.userData, title:'松影叠院', units:'m', up:'+Y', gardenFront:'+Z', rooms:markers };

const scene = new THREE.Scene();
scene.name = 'Courtyard villa';
scene.add(root);
scene.updateMatrixWorld(true);
const bounds = new THREE.Box3().setFromObject(root);
let triangles = 0;
let meshCount = 0;
const checked = new Set();
root.traverse((node) => {
  if (!node.isMesh) return;
  meshCount++;
  const geometry = node.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (!checked.has(geometry)) {
    assert(position?.count && position.array.every(Number.isFinite) && normal?.array.every(Number.isFinite),
      'Invalid geometry: ' + node.name);
    checked.add(geometry);
  }
  triangles += (geometry.index?.count ?? position.count) / 3;
});
assert(triangles > 0 && !bounds.isEmpty());

// GLTFExporter uses FileReader to finalize the binary in memory.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((value) => {
      this.result = value;
      this.onloadend?.();
    });
  }
};
const binary = Buffer.from(await new GLTFExporter().parseAsync(scene, { binary:true, trs:true, onlyVisible:false }));
assert.equal(binary.readUInt32LE(0), 0x46546c67, 'Invalid GLB signature');
assert.equal(binary.readUInt32LE(8), binary.length, 'Incomplete GLB');
const gltf = JSON.parse(binary.toString('utf8', 20, 20 + binary.readUInt32LE(12)));
assert.equal(gltf.buffers.length, 1);
assert(!gltf.buffers[0].uri, 'GLB must be self-contained');
for (const name of ['F1', 'F2', 'F3', 'Roof', 'Garden', 'LiftCar', 'LiftDoor1', 'LiftDoor2', 'LiftDoor3']) {
  assert.equal(gltf.nodes.filter((node) => node.name === name).length, 1, 'Expected one exported ' + name);
}
assert(gltf.nodes.some((node) => node.extras?.rooms?.length === markers.length), 'Area labels did not export');

await mkdir(output, { recursive:true });
const [template, license] = await Promise.all([
  readFile(join(here, 'viewer.html'), 'utf8'),
  readFile(resolve(dirname(require.resolve('three')), '../LICENSE'), 'utf8'),
]);
assert(template.includes('/* INLINE RUNTIME */') && template.includes('>INLINE_MODEL</script>'),
  'Missing preview template slots');
const runtime = await rolldown({ cwd:here, input:join(here, 'viewer.mjs'), platform:'browser', logLevel:'warn' });
try {
  const { output:[bundle] } = await runtime.generate({ format:'iife', minify:true, comments:{ legal:true } });
  const backslash = String.fromCharCode(92);
  const script = bundle.code.replace(/<[/]script/gi, (match) => '<' + backslash + match.slice(1));
  const nl = String.fromCharCode(10);
  const html = template.replace('/* INLINE RUNTIME */', () => script)
    .replace('>INLINE_MODEL</script>', () => '>' + binary.toString('base64') + '</script>')
    .replace('</head>', () => ['<!--', license, '-->', '</head>'].join(nl));
  const rounded = (v) => v.toArray().map((value) => Number(value.toFixed(3)));
  const manifest = { model:modelName, ...root.userData, bounds:{ min:rounded(bounds.min), max:rounded(bounds.max) },
    meshCount, triangles, bytes:binary.length };
  await Promise.all([
    writeFile(join(output, modelName), binary),
    writeFile(join(output, 'preview.html'), html),
    writeFile(join(output, 'courtyard-villa.json'), JSON.stringify(manifest, null, 2) + nl),
  ]);
  console.log(JSON.stringify({ model:join(output, modelName), bytes:binary.length, meshCount, triangles, areas:markers.length, bounds:manifest.bounds }));
} finally {
  await runtime.close();
}
