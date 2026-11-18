import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildArchitecture } from '../manor_villa_review/architecture.mjs';
import { buildRoofs } from '../manor_villa_review/roofs.mjs';
import { createVillaInterior } from './villa-interior.js';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] || join(here, '../../output/manor-villa-interior'));
const model = 'manor-villa-interior.glb';

// Derive the same origin as the exterior export, using the same geometry builders.
// Materials do not affect the model bounds.
const proxyMaterial = new THREE.MeshStandardMaterial();
const tones = count => Array.from({ length: count }, () => proxyMaterial);
const exterior = buildArchitecture({
  ...Object.fromEntries(['plaster', 'mortar', 'door', 'glass', 'lead', 'brass', 'peg', 'soot', 'pottery', 'tile']
    .map(key => [key, proxyMaterial])),
  stoneTones: tones(6), woodTones: tones(4), glassTones: tones(6), tileTones: tones(5), leaves: tones(5),
});
exterior.add(buildRoofs(THREE));
const exteriorBounds = new THREE.Box3().setFromObject(exterior);
const exteriorCenter = exteriorBounds.getCenter(new THREE.Vector3());
const toExteriorOrigin = new THREE.Vector3(-exteriorCenter.x, -exteriorBounds.min.y, -exteriorCenter.z);
exterior.name = 'Tudor villa';
exterior.userData = { units: 'meters', up: '+Y', front: '+Z', origin: 'floor center' };
const interiorScene = createVillaInterior(THREE);
assert(interiorScene?.root?.isGroup && typeof interiorScene.setCutaway === 'function',
  'The villa interior module did not produce a cutaway interior');
const interior = interiorScene.root;
interiorScene.setCutaway('both');

const root = new THREE.Group();
root.name = 'VillaInterior';
root.userData = { units: 'meters', up: '+Y', front: '+Z', origin: 'existing villa exterior floor center' };
root.add(interior);

const markers = {};
function addMarker(name, x, y, z, yaw = 0) {
  const marker = new THREE.Object3D();
  marker.name = name;
  marker.position.set(x, y, z).add(toExteriorOrigin);
  marker.rotation.y = yaw;
  root.add(marker);
  markers[name] = { position: marker.position.toArray(), yaw };
}

// The front arch is centered on x=1.28 at z=3.56 in the exterior source.
addMarker('FrontDoor', 1.28, .40, 3.56);
addMarker('InteriorSpawn', 1.28, .405, 2.42, Math.PI);

const scene = new THREE.Scene();
scene.name = 'Tudor Villa Interior';
scene.add(root);
interior.position.add(toExteriorOrigin);
const interiorBounds = new THREE.Box3().setFromObject(interior);
const normalizedExterior = exteriorBounds.clone().translate(toExteriorOrigin).expandByScalar(.01);
assert(normalizedExterior.containsBox(interiorBounds), 'Interior geometry extends beyond the exterior model bounds');

let triangles = 0;
interior.traverse(node => {
  if (!node.isMesh) return;
  const { index, attributes: { position, normal } } = node.geometry;
  assert(position.array.every(Number.isFinite) && normal.array.every(Number.isFinite), node.name);
  triangles += (index?.count ?? position.count) / 3;
});
assert(triangles > 0, 'No interior geometry found');

// GLTFExporter uses FileReader to finalize its in-memory GLB in Node.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(result => {
      this.result = result;
      this.onloadend?.();
    });
  }
};

const binary = Buffer.from(await new GLTFExporter().parseAsync(scene, {
  binary: true,
  onlyVisible: false,
  trs: true,
}));
assert.equal(binary.readUInt32LE(0), 0x46546c67);
assert.equal(binary.readUInt32LE(8), binary.length);
const gltf = JSON.parse(binary.toString('utf8', 20, 20 + binary.readUInt32LE(12)));
assert(gltf.meshes.length && gltf.buffers.length === 1 && !gltf.buffers[0].uri);
for (const name of Object.keys(markers)) assert(gltf.nodes.some(node => node.name === name), `Missing ${name}`);
const floors = new Set(gltf.nodes.map(node => node.extras?.floorLevel).filter(Boolean));
assert(floors.has(1) && floors.has(2), 'Both floors must be retained in the GLB');

const rounded = values => values.map(value => Number(value.toFixed(4)));
const metadata = {
  model,
  ...root.userData,
  dimensionsMeters: rounded(interiorBounds.getSize(new THREE.Vector3()).toArray()),
  exteriorDimensionsMeters: rounded(exteriorBounds.getSize(new THREE.Vector3()).toArray()),
  bounds: { min: rounded(interiorBounds.min.toArray()), max: rounded(interiorBounds.max.toArray()) },
  frontDoorOpening: { width: 1.28, height: 2.34, archRise: .49, enterDirection: [0, 0, -1] },
  anchors: Object.fromEntries(Object.entries(markers).map(([name, anchor]) => [name, {
    position: rounded(anchor.position), yaw: Number(anchor.yaw.toFixed(4)),
  }])),
  triangles,
  meshes: gltf.meshes.length,
};
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(join(output, model), binary),
  writeFile(join(output, 'model.json'), JSON.stringify(metadata, null, 2) + '\n'),
]);
console.log(JSON.stringify({ output: join(output, model), bytes: binary.length, ...metadata }, null, 2));
