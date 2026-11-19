import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const byId = (id) => document.getElementById(id);
const $all = (query) => Array.from(document.querySelectorAll(query));
const stage = byId('stage');
const canvas = byId('scene-canvas');
const viewButtons = $all('[data-view]');
const lightButtons = $all('[data-light-choice]');
const wallToggle = byId('wall-toggle');
const pinToggle = byId('pin-toggle');
const pinRoot = byId('pins');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const titles = ['庭院', '一层', '二层', '三层'];
const elevations = [0, .22, 3.82, 7.12];
const data = {
  all: { index:'00 / 建筑全景', caption:'全景 · 南向鸟瞰', title:'一座朝南的庭院住宅', text:'从北侧到家，沿过厅走入南庭院。白墙与深灰挑檐围住松影，二层长阳台与三层屋顶花园逐层退让。', facts:['26 × 36 m 用地', '三层住宅', '南向庭院'], target:[8,3.25,9.7], offset:[28,21,34] },
  garden: { index:'庭 / 南向园景', caption:'南庭院 · 松影与水面', title:'松影与水面的庭院', text:'中央石径连起南侧草地与室内过厅，西边松下设座，东边镜池映出白墙与灰檐。', facts:['松下坐席', '东侧镜池', '中央石径'], target:[8,2.75,14.7], offset:[15,10,24] },
  1: { index:'01 / 会客与茶庭', caption:'一层 · 会客与茶庭', title:'一层｜开门见庭', text:'北侧入户，西侧接客厅与餐厨，东侧安排长辈房和茶室。茶室、客厅和中央过厅通向南庭院。', facts:['客餐厨', '长辈房', '独立茶室'], target:[8,.75,7], offset:[13,22,15] },
  2: { index:'02 / 卧室与阳台', caption:'二层 · 家庭与休息', title:'二层｜面园而居', text:'主卧套房、两间次卧和家庭厅围绕楼梯与电梯组织。家庭厅与两间南向卧室可直达长阳台。', facts:['主卧套房', '两间次卧', '16 × 2 m 阳台'], target:[8,4.35,7.8], offset:[13,22,15] },
  3: { index:'03 / 书房与屋顶花园', caption:'三层 · 书房与屋顶花园', title:'三层｜退台成园', text:'书房、影音室和家庭起居厅向北收进，南侧留出花园露台，从起居厅走到户外茶座。', facts:['书房与影音室', '家庭起居厅', '16 × 4 m 花园露台'], target:[8,7.65,7], offset:[12,21,15] },
};
const state = { view:'all', night:false, cut:true, pins:true, selected:null };
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(39, 1, .14, 200);
const keyTarget = new THREE.Object3D();
keyTarget.position.set(8, 1.5, 10);
scene.add(keyTarget);
const keyLight = new THREE.DirectionalLight(0xfff2dc, 2.6);
keyLight.position.set(-18, 32, 33);
keyLight.target = keyTarget;
keyLight.castShadow = true;
Object.assign(keyLight.shadow.camera, { left:-25, right:25, top:27, bottom:-27, near:.9, far:82 });
keyLight.shadow.mapSize.set(1536, 1536);
keyLight.shadow.normalBias = .035;
keyLight.shadow.bias = -.00025;
scene.add(keyLight);
const hemi = new THREE.HemisphereLight(0xeef7ff, 0xc8b79c, 1.85);
const fill = new THREE.DirectionalLight(0xdeeaf4, .45);
fill.position.set(18, 17, -9);
scene.add(hemi, fill);

let renderer, controls, model, roof, garden, lift, width = 0, height = 0;
let rooms = [], frame = 0, flight = null, liftTrip = null, liftFloor = 1, suspended = false;
const floors = new Map();
const pinElements = new Map();
const views = new Map();
const lights = [];
const lightMaterials = new Set();
const nightMaterials = new Map();
const liftDoors = new Map();
const temp = new THREE.Vector3();
const offset = new THREE.Vector3();
const spherical = new THREE.Spherical();
const north = new THREE.Vector3();
const compassNeedle = byId('compass-needle');
const floorNumber = () => Number(state.view) || 0;
const floorGroup = (name) => (root, node) => new RegExp('^' + name + '(?:_[0-9]+)?$').test(node.name) && node.parent === root;
const depthName = (root, name) => root.getObjectByName(name) || null;
const invalidate = () => { if (!frame && renderer && !suspended) frame = requestAnimationFrame(draw); };
const refreshShadows = () => { renderer.shadowMap.needsUpdate = true; invalidate(); };
const smooth = (t) => t * t * (3 - 2 * t);
const fitScale = () => Math.max(1, Math.min(1.65, 1.04 / camera.aspect));

function message(title, detail, retry) {
  byId('screen').hidden = false;
  byId('screen-title').textContent = title;
  byId('screen-text').textContent = detail;
  byId('reload').hidden = !retry;
  stage.setAttribute('aria-busy', String(!retry));
}
function resize() {
  const w = Math.round(stage.clientWidth);
  const h = Math.round(stage.clientHeight);
  if (!w || !h || (w === width && h === height)) return;
  width = w; height = h;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.6));
  renderer.setSize(w, h, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  invalidate();
}
function flyTo(target, delta, animate = true) {
  const end = new THREE.Spherical().setFromVector3(delta);
  if (!animate || motion.matches) {
    flight = null;
    controls.target.copy(target);
    camera.position.copy(target).add(delta);
    controls.update();
    invalidate();
    return;
  }
  const start = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  const angle = THREE.MathUtils.euclideanModulo(end.theta - start.theta + Math.PI, Math.PI * 2) - Math.PI;
  flight = { start, end, angle, from:controls.target.clone(), target, time:performance.now() };
  invalidate();
}
function framePreset(animate = true) {
  const preset = data[state.view];
  const target = new THREE.Vector3(...preset.target);
  const delta = new THREE.Vector3(...preset.offset);
  // Leave room for the nearest garden/slab edge in perspective, including on narrow screens.
  if (state.view === 'all') target.add(new THREE.Vector3(-.7, -1.6, 2.1));
  if (floorNumber()) target.add(new THREE.Vector3(.8, -.45, 1));
  flyTo(target, delta.multiplyScalar(fitScale() * 1.07), animate);
}
function focus(room) {
  state.selected = room;
  updateRoomDetails();
  const y = floorNumber() ? elevations[floorNumber()] + .65 : Math.max(.45, room.position[1] - .2);
  const target = new THREE.Vector3(room.position[0], y, room.position[2]);
  const config = room.level === 0 ? [8, 7.5, 10.5] : [5, 10, 7.5];
  flyTo(target, new THREE.Vector3(...config).multiplyScalar(fitScale()));
}
function readRooms(gltf) {
  const extras = [gltf.scene.userData, gltf.userData, ...gltf.scene.children.map((node) => node.userData)];
  const raw = extras.find((entry) => Array.isArray(entry?.rooms))?.rooms;
  const unique = new Set();
  return (raw || []).filter((room) => {
    if (!room || typeof room.id !== 'string' || typeof room.name !== 'string' || !Number.isInteger(room.level) || room.level < 0 || room.level > 3 || !Array.isArray(room.position) || room.position.length !== 3 || !room.position.every(Number.isFinite) || unique.has(room.id)) return false;
    unique.add(room.id);
    return true;
  }).map((room) => ({ ...room, point:new THREE.Vector3(...room.position) }));
}
function floorParts(root, key) {
  return root.children.filter((node) => floorGroup(key)(root, node));
}
function looksGlass(mat) { return /^glazing[: _-]/i.test(mat.name); }
function looksLamp(mat) { return /^lamp[: _-]/i.test(mat.name); }
function registerMaterial(mat) {
  if (!mat?.emissive?.isColor || (!looksGlass(mat) && !looksLamp(mat)) || lightMaterials.has(mat)) return;
  lightMaterials.add(mat);
  nightMaterials.set(mat, { emissive:mat.emissive.clone(), intensity:mat.emissiveIntensity });
}
function normalizeMaterials(root) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const transparent = materials.some((mat) => mat?.transparent || looksGlass(mat));
    node.castShadow = !transparent;
    node.receiveShadow = !transparent;
    materials.forEach(registerMaterial);
  });
}
function addPopLights() {
  const points = [
    [0,4.2,1.2,18.5,22,8], [0,12.4,1.05,20.2,17,7], [0,8,1.9,-2.4,25,7],
    [1,3.3,2.5,10.8,25,7], [1,12.6,2.45,11.5,21,6],
    [2,4,6.3,10.6,19,7], [2,13.3,6.3,11.2,18,6],
    [3,4.2,9.7,6.4,19,7], [3,12,8.1,11.8,17,6],
  ];
  for (const [level,x,y,z,intensity,distance] of points) {
    const object = new THREE.PointLight(0xffbd83, intensity, distance, 2);
    object.position.set(x, y, z);
    object.visible = false;
    scene.add(object);
    lights.push({ object, level });
  }
}
function updatePopLights() {
  const level = floorNumber();
  for (const light of lights) light.object.visible = state.night && (level ? light.level === level : true);
}
function setLighting(night) {
  state.night = night;
  stage.dataset.light = night ? 'night' : 'day';
  lightButtons.forEach((button) => button.setAttribute('aria-pressed', String((button.dataset.lightChoice === 'night') === night)));
  keyLight.color.set(night ? 0xa2c5ff : 0xfff2dc);
  keyLight.intensity = night ? .36 : 2.6;
  hemi.color.set(night ? 0xabc5ec : 0xeef7ff);
  hemi.groundColor.set(night ? 0x9b8074 : 0xc8b79c);
  hemi.intensity = night ? .86 : 1.85;
  fill.intensity = night ? .13 : .45;
  renderer.toneMappingExposure = night ? 1.06 : 1.03;
  for (const [mat, base] of nightMaterials) {
    if (!night) {
      mat.emissive.copy(base.emissive);
      mat.emissiveIntensity = base.intensity;
    } else {
      const isLamp = looksLamp(mat);
      mat.emissive.set(isLamp ? 0xffb26c : 0xff9c52);
      mat.emissiveIntensity = isLamp ? 1.65 : .52;
    }
  }
  updatePopLights();
  invalidate();
}
// Clone the shell materials per floor so the section plane never cuts through furniture.
function installSection(level, root) {
  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), elevations[level] + .86);
  const switches = [];
  const clones = new Map();
  const sectionMaterial = (material) => {
    if (!material) return material;
    if (!clones.has(material)) {
      const clone = material.clone();
      clone.clippingPlanes = [plane];
      clone.clipShadows = true;
      registerMaterial(clone);
      clones.set(material, clone);
    }
    return clones.get(material);
  };
  for (const group of [...floorParts(root, 'Walls'), ...floorParts(root, 'Exterior')]) {
    group.traverse((object) => {
      if (!object.isMesh) return;
      const base = object.material;
      const clip = Array.isArray(base) ? base.map(sectionMaterial) : sectionMaterial(base);
      switches.push({ object, base, clip });
    });
  }
  views.set(level, switches);
}
function setLiftVisibility() {
  if (!lift) return;
  const level = floorNumber();
  lift.visible = level === 0 || Math.abs(lift.position.y - elevations[level]) < .92;
}
function updateVisibility() {
  const level = floorNumber();
  if (roof) roof.visible = level === 0;
  if (garden) garden.visible = level === 0;
  for (const [n, node] of floors) {
    node.visible = level === 0 || n === level;
    for (const { object, base, clip } of views.get(n)) object.material = level === n && state.cut ? clip : base;
  }
  setLiftVisibility();
  updatePopLights();
  refreshShadows();
}
function placePins() {
  const level = floorNumber();
  const candidates = [];
  for (const room of rooms) {
    const button = pinElements.get(room.id);
    button.hidden = true;
    const isSelected = state.selected?.id === room.id;
    if (!state.pins || room.level !== level || (state.view === 'all' && !isSelected && !room.featured)) continue;
    temp.copy(room.point).project(camera);
    if (temp.z < -1 || temp.z > 1) continue;
    const x = (temp.x + 1) * width * .5;
    const y = (1 - temp.y) * height * .5;
    const half = Math.min(105, 17 + room.name.length * 6.4);
    if (x < half + 5 || x > width - half - 5 || y < 84 || y > height - 42) continue;
    candidates.push({button, x, y, half, selected:isSelected, featured:!!room.featured, depth:temp.z});
  }
  const placed = [];
  candidates.sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.featured) - Number(a.featured) || a.depth - b.depth);
  for (const pin of candidates) {
    if (placed.some((taken) => Math.abs(taken.x - pin.x) < taken.half + pin.half + 4 && Math.abs(taken.y - pin.y) < 35)) continue;
    pin.button.style.left = Math.round(pin.x) + 'px';
    pin.button.style.top = Math.round(pin.y) + 'px';
    pin.button.hidden = false;
    placed.push(pin);
  }
  north.set(0,0,-1).applyQuaternion(camera.quaternion.clone().invert());
  compassNeedle.style.transform = 'rotate(' + (Math.atan2(north.x, north.y) * 180 / Math.PI) + 'deg)';
}
function roomList() {
  const active = rooms.filter((room) => room.level === floorNumber());
  byId('room-heading').textContent = floorNumber() ? '室内外空间' : '庭院景点';
  byId('room-panel').hidden = !active.length;
  byId('rooms').replaceChildren(...active.map((room) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.roomId = room.id;
    button.textContent = room.name;
    button.addEventListener('click', () => focus(room));
    return button;
  }));
  updateRoomDetails();
}
function updateRoomDetails() {
  const room = state.selected;
  for (const button of $all('[data-room-id]')) button.setAttribute('aria-pressed', String(room?.id === button.dataset.roomId));
  byId('room-detail').hidden = !room;
  byId('room-name').textContent = room?.name || '';
  byId('room-description').textContent = room?.description || '';
  invalidate();
}
function selectView(view, animate = true) {
  if (!model || !Object.hasOwn(data, view)) return;
  state.view = view;
  state.selected = null;
  const preset = data[view];
  viewButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  wallToggle.hidden = !floorNumber() || !views.get(floorNumber())?.length;
  byId('scene-caption').textContent = preset.caption;
  byId('guide-kicker').textContent = preset.index;
  byId('guide-title').textContent = preset.title;
  byId('guide-text').textContent = preset.text;
  byId('facts').replaceChildren(...preset.facts.map((text) => { const li = document.createElement('li'); li.textContent = text; return li; }));
  updateVisibility();
  roomList();
  framePreset(animate);
}
function moveLift(level) {
  if (!lift || (liftTrip && liftTrip.level === level) || (!liftTrip && liftFloor === level)) return;
  const target = elevations[level];
  liftTrip = { start:lift.position.y, target, level, time:performance.now(), duration:Math.max(420, Math.abs(target - lift.position.y) * 330) };
  for (const doors of liftDoors.values()) if (doors) doors.visible = true;
  byId('lift-status').textContent = '前往' + titles[level];
  invalidate();
}
function draw(now) {
  frame = 0;
  if (suspended) return;
  if (flight) {
    const t = smooth(Math.min(1, (now - flight.time) / 650));
    const { start, end } = flight;
    controls.target.lerpVectors(flight.from, flight.target, t);
    spherical.set(THREE.MathUtils.lerp(start.radius, end.radius, t), THREE.MathUtils.lerp(start.phi, end.phi, t), start.theta + flight.angle * t);
    camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
    if (t === 1) flight = null;
  }
  if (liftTrip) {
    const t = motion.matches ? 1 : smooth(Math.min(1, (now - liftTrip.time) / liftTrip.duration));
    lift.position.y = THREE.MathUtils.lerp(liftTrip.start, liftTrip.target, t);
    if (t === 1) {
      liftFloor = liftTrip.level;
      if (liftDoors.get(liftFloor)) liftDoors.get(liftFloor).visible = false;
      byId('lift-status').textContent = '停在' + titles[liftFloor];
      liftTrip = null;
    }
    setLiftVisibility();
    renderer.shadowMap.needsUpdate = true;
  }
  controls.update();
  renderer.render(scene, camera);
  placePins();
  if (flight || liftTrip) invalidate();
}
function parseEmbeddedModel() {
  const el = byId('villa-data');
  const payload = el?.textContent.trim();
  if (!payload || payload === 'INLINE_MODEL') throw new Error('Missing embedded model data');
  const decoded = atob(payload);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; ++i) bytes[i] = decoded.charCodeAt(i);
  el.remove();
  return new GLTFLoader().parseAsync(bytes.buffer, '');
}
async function boot() {
  byId('reload').addEventListener('click', () => location.reload());
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha:true, antialias:true, powerPreference:'high-performance' });
  } catch (error) {
    console.error(error);
    message('当前浏览器无法显示 3D', '可尝试开启浏览器的硬件加速，或用支持 WebGL 的浏览器打开此页面。家具平面图仍可查看。', true);
    return;
  }
  try {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = !motion.matches;
    controls.dampingFactor = .13;
    controls.minDistance = 4;
    controls.maxDistance = 110;
    controls.minPolarAngle = .12;
    controls.maxPolarAngle = Math.PI * .49;
    controls.zoomSpeed = .85;
    controls.rotateSpeed = .62;
    controls.enabled = false;
    controls.addEventListener('start', () => { flight = null; });
    controls.addEventListener('change', invalidate);
    new ResizeObserver(resize).observe(stage);
    resize();
    framePreset(false);
    const gltf = await parseEmbeddedModel();
    model = gltf.scene;
    rooms = readRooms(gltf);
    for (let level = 1; level <= 3; level++) {
      const node = depthName(model, 'F' + level);
      if (!node) throw new Error('Missing model group F' + level);
      floors.set(level, node);
    }
    roof = depthName(model, 'Roof');
    garden = depthName(model, 'Garden');
    lift = depthName(model, 'LiftCar');
    normalizeMaterials(model);
    for (const [level, node] of floors) {
      installSection(level, node);
      liftDoors.set(level, depthName(model, 'LiftDoor' + level));
    }
    if (lift && liftDoors.get(1)) liftDoors.get(1).visible = false;
    for (const room of rooms) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pin';
      button.dataset.roomId = room.id;
      button.textContent = room.name;
      button.hidden = true;
      button.addEventListener('click', () => focus(room));
      pinRoot.append(button);
      pinElements.set(room.id, button);
    }
    scene.add(model);
    addPopLights();
    setLighting(false);
    selectView('all', false);
    controls.enabled = true;
    $all('[data-scene]').forEach((button) => { button.disabled = false; });
    byId('lift-panel').hidden = !lift;
    byId('screen').hidden = true;
    stage.setAttribute('aria-busy', 'false');
    stage.dataset.ready = 'true';
    viewButtons.forEach((button) => button.addEventListener('click', () => selectView(button.dataset.view)));
    lightButtons.forEach((button) => button.addEventListener('click', () => setLighting(button.dataset.lightChoice === 'night')));
    $all('[data-lift]').forEach((button) => button.addEventListener('click', () => moveLift(Number(button.dataset.lift))));
    pinToggle.addEventListener('click', () => {
      state.pins = !state.pins;
      pinToggle.setAttribute('aria-pressed', String(state.pins));
      invalidate();
    });
    wallToggle.addEventListener('click', () => {
      state.cut = !state.cut;
      wallToggle.setAttribute('aria-pressed', String(state.cut));
      updateVisibility();
    });
    byId('reset').addEventListener('click', () => { state.selected = null; updateRoomDetails(); framePreset(); });
    canvas.addEventListener('keydown', (event) => {
      if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','+','=','-','_'].includes(event.key)) return;
      event.preventDefault();
      flight = null;
      spherical.setFromVector3(offset.copy(camera.position).sub(controls.target));
      if (event.key === 'ArrowLeft') spherical.theta -= .14;
      if (event.key === 'ArrowRight') spherical.theta += .14;
      if (event.key === 'ArrowUp') spherical.phi -= .105;
      if (event.key === 'ArrowDown') spherical.phi += .105;
      if (event.key === '+' || event.key === '=') spherical.radius *= .88;
      if (event.key === '-' || event.key === '_') spherical.radius /= .88;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
      spherical.radius = THREE.MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
      camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
      controls.update();
      invalidate();
    });
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      suspended = true;
      controls.enabled = false;
      $all('[data-scene]').forEach((button) => { button.disabled = true; });
      message('3D 显示已中断', '图形设备暂时断开，可重新载入预览。', true);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      suspended = false;
      controls.enabled = true;
      $all('[data-scene]').forEach((button) => { button.disabled = false; });
      byId('screen').hidden = true;
      refreshShadows();
    });
    refreshShadows();
  } catch (error) {
    console.error(error);
    message('无法读取 3D 模型', '请重新载入预览文件。也可打开平面图或下载 GLB 查看建筑。', true);
  }
}
void boot();
