import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildArchitecture } from '../manor_villa_review/architecture.mjs';
import { buildRoofs } from '../manor_villa_review/roofs.mjs';
import { createVillaInterior, VILLA_LAYOUT } from './villa-interior.js';
import { BAYS, ELEVATOR, GROUND_Y, UPPER_Y, WEST_STUDY_FLOOR } from './villa-layout.js';
import { writeVillaInteriorPreview } from './build-preview.mjs';

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

interior.updateMatrixWorld(true);
const floorMeshes = ['Ground floorboards', 'Upper floorboards'].map(name => interior.getObjectByName(name));
const ray = ([x, y, z], [dx, dy, dz], far) =>
  new THREE.Raycaster(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz), 0, far);
function floorHit({ x, y, z, level }, underside = false) {
  const floorRay = underside ? ray([x, y - .29, z], [0, 1, 0], .25) : ray([x, y + .10, z], [0, -1, 0], .135);
  return floorRay.intersectObject(floorMeshes[level - 1], true)[0];
}
const shaft = {
  x: (ELEVATOR.bounds.minX + ELEVATOR.bounds.maxX) / 2,
  z: (ELEVATOR.bounds.minZ + ELEVATOR.bounds.maxZ) / 2,
};
// Probe the eastern extension, western projection, and each bay where previous models left gaps.
for (const [level, y] of [[1, GROUND_Y], [2, UPPER_Y]]) {
  const westY = level === 2 ? WEST_STUDY_FLOOR.y : y;
  for (const [x, z, slabY] of [[3.24, -4.04, y], [4.17, 4.50, y], [-9.41, 3.63, westY]]) {
    const sample = { x, y: slabY, z, level };
    assert(floorHit(sample) && floorHit(sample, true), `Missing slab at level ${level}: ${x}, ${z}`);
  }
  assert(!floorHit({ ...shaft, y, level }), 'Floorboards block the lift travel');
}
assert(floorHit({ ...shaft, y: GROUND_Y, level: 1 }, true), 'Ground slab must close under the lift pit');
for (const [name, bay] of Object.entries(BAYS)) {
  const sample = { x: bay.x, y: bay.floorY, z: bay.z + bay.depth * .63, level: bay.level };
  assert(floorHit(sample) && floorHit(sample, true), `Missing ${name} bay slab`);
  const glazing = ray([bay.x + .11, bay.y + .38, bay.z + bay.depth + .10], [0, 0, -1], .20)
    .intersectObject(interior, true)[0];
  assert.equal(glazing?.object.material.name, 'glass', `Misaligned ${name} bay sill`);
}
const studyEdge = ray([WEST_STUDY_FLOOR.maxX - .25, WEST_STUDY_FLOOR.y + .25, 1.30], [1, 0, 0], .40);
assert(studyEdge.intersectObject(floorMeshes[1], true).length, 'Missing vertical finish at the study landing');

const root = new THREE.Group();
root.name = 'VillaInterior';
root.userData = { units: 'meters', up: '+Y', front: '+Z', origin: 'existing villa exterior floor center' };
const { floors: walkableFloors, ramps, obstacles, restSpots } = VILLA_LAYOUT;
root.userData.navigation = {
  offset: { x: toExteriorOrigin.x, y: toExteriorOrigin.y, z: toExteriorOrigin.z },
  floors: walkableFloors,
  ramps,
  obstacles,
  restSpots,
  elevator: interiorScene.elevator,
};
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
const spawn = VILLA_LAYOUT.insideEntrance;
addMarker('InteriorSpawn', spawn.x, spawn.y, spawn.z, spawn.yaw);

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
const { elevator } = root.userData.navigation;
const cabin = gltf.nodes.find(node => node.name === elevator.platformNode);
assert(cabin?.extras?.elevatorRole === 'car', 'Missing moving glass cabin');
assert.equal(cabin.translation[1], elevator.landings[0].y, 'Cabin deck must start flush with the first floor');
for (const { name } of elevator.doorNodes) {
  assert(gltf.nodes.some(node => node.name === name && node.extras?.elevatorRole === 'door'), `Missing ${name}`);
}

const rounded = values => values.map(value => Number(value.toFixed(4)));
const metadata = {
  model,
  revision: 'interior-v2',
  ...interior.userData,
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
  writeVillaInteriorPreview(output, binary),
]);
console.log(JSON.stringify({ output: join(output, model), bytes: binary.length, ...metadata }, null, 2));
