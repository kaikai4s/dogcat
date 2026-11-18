const { createManorNavigation } = require('./manor-navigation');
const { createManorPlayer } = require('./manor-player');

const MIN_DISTANCE = 23;
const PLAYER_DISTANCE = 8.5;
const PLAYER_ZOOM_MIN = 3.5;
const PLAYER_ZOOM_MAX = 36;
const PLAYER_TARGET_HEIGHT = 0.68;
const MIN_ELEVATION = Math.PI / 10;
const MAX_ELEVATION = Math.PI * 0.44;
const FULL_TURN = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = Number.isFinite;

function layoutError(message) {
  return Object.assign(new Error(message), { code: 'MANOR_INVALID_LAYOUT' });
}

function validateLayout(layout) {
  const world = layout && layout.world;
  if (!world || !finite(world.width) || !finite(world.depth) ||
    world.width < 10 || world.depth < 10 || world.width > 10000 || world.depth > 10000 ||
    !Array.isArray(layout.plots)) {
    throw layoutError('庄园地形尺寸或地块配置有误');
  }
  const plots = [];
  const ids = new Set();
  for (const plot of layout.plots) {
    if (!plot || typeof plot.id !== 'string' || !plot.id || ids.has(plot.id) ||
      ![plot.x, plot.y, plot.z, plot.width, plot.depth].every(finite) ||
      plot.width <= 0 || plot.depth <= 0 || Math.abs(plot.y) > 1000 ||
      Math.abs(plot.x) + plot.width / 2 > world.width / 2 ||
      Math.abs(plot.z) + plot.depth / 2 > world.depth / 2) continue;
    ids.add(plot.id);
    plots.push({ id: plot.id, x: plot.x, y: plot.y, z: plot.z, width: plot.width, depth: plot.depth });
  }
  if (!plots.length) throw layoutError('庄园没有可用地块');
  const rawBridge = layout.bridge;
  const bridge = rawBridge && finite(rawBridge.x) && finite(rawBridge.z) &&
    Math.abs(rawBridge.x) < world.width / 2 && Math.abs(rawBridge.z) < world.depth / 2
    ? { x: rawBridge.x, z: rawBridge.z } : { x: 0, z: 0 };
  plots.sort((a, b) => Math.hypot(a.x - bridge.x, a.z - bridge.z) - Math.hypot(b.x - bridge.x, b.z - bridge.z));
  const crossings = (Array.isArray(layout.crossings) ? layout.crossings : []).filter(item => item &&
    [item.x, item.z, item.yaw, item.width, item.length].every(finite) &&
    item.width > 0 && item.width < 100 && item.length > 0 && item.length < 300 &&
    Math.abs(item.x) < world.width / 2 && Math.abs(item.z) < world.depth / 2
  ).map(({ x, z, yaw, width, length }) => ({ x, z, yaw, width, length }));
  const landmarkTrees = (Array.isArray(layout.landmarkTrees) ? layout.landmarkTrees : []).filter(item => item &&
    [item.x, item.z, item.r].every(finite) && item.r > 0 && item.r < 100
  ).map(({ x, z, r }) => ({ x, z, r }));
  return {
    name: typeof layout.name === 'string' ? layout.name : '3D 庄园',
    width: world.width,
    depth: world.depth,
    ground: finite(layout.groundLevel) && Math.abs(layout.groundLevel) <= 1000 ? layout.groundLevel : plots[0].y,
    plots,
    bridge,
    crossings,
    landmarkTrees,
  };
}

// Measure downstream distance along the exported river, following its bends.
function addFlowCoordinates(THREE, geometry) {
  if (geometry.getAttribute('manorFlow')) return true;
  const positions = geometry.getAttribute('position');
  if (!positions || !positions.count) return false;
  const sections = new Map();
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const row = sections.get(x);
    if (row) {
      row.min = Math.min(row.min, z);
      row.max = Math.max(row.max, z);
    } else {
      sections.set(x, { x, min: z, max: z });
    }
  }
  const rows = Array.from(sections.values()).sort((a, b) => a.x - b.x);
  let previous;
  for (const row of rows) {
    row.center = (row.min + row.max) / 2;
    row.distance = previous ? previous.distance + Math.hypot(row.x - previous.x, row.center - previous.center) : 0;
    previous = row;
  }
  const flow = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const row = sections.get(positions.getX(i));
    const across = positions.getZ(i) - row.center;
    flow[i * 3] = row.distance;
    flow[i * 3 + 1] = across;
    flow[i * 3 + 2] = clamp(2 * across / Math.max(0.01, row.max - row.min), -1, 1);
  }
  geometry.setAttribute('manorFlow', new THREE.BufferAttribute(flow, 3));
  return true;
}

function installMotion(material, mode, clock) {
  material.onBeforeCompile = shader => {
    shader.uniforms.manorTime = clock;
    if (mode === 'leaf' || mode === 'grass') {
      const leaf = mode === 'leaf';
      shader.vertexShader = 'uniform float manorTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'vec3 manorPlant = (modelMatrix * vec4(position, 1.0)).xyz;',
        'float manorWind = sin(manorPlant.x * .19 + manorPlant.z * .23 - manorTime * 1.46)',
        '  + .38 * sin(manorPlant.x * .61 - manorPlant.z * .17 - manorTime * 2.1);',
        leaf ? 'float manorTip = .3 + .7 * clamp(uv.y, 0.0, 1.0);' : 'float manorTip = pow(clamp(uv.y, 0.0, 1.0), 2.0);',
        leaf ? 'transformed.xz += vec2(.12, .055) * manorWind * manorTip;' : 'transformed.xz += vec2(.046, .023) * manorWind * manorTip;',
      ].join('\n'));
      return;
    }
    const river = mode === 'river';
    const flowHeader = 'varying vec3 vManorFlow;\n';
    shader.vertexShader = (river ? 'attribute vec3 manorFlow;\n' : '') + flowHeader + shader.vertexShader.replace(
      '#include <begin_vertex>', '#include <begin_vertex>\n' + (river ? 'vManorFlow = manorFlow;' : 'vManorFlow = vec3(uv, 0.0);')
    );
    const current = [
      '#include <map_fragment>',
      'float manorBank = abs(vManorFlow.z);',
      'float manorAlong = vManorFlow.x - manorTime * (1.85 - .54 * manorBank);',
      'float manorAcross = vManorFlow.y;',
      'float manorWave = sin(manorAlong * .51 + manorAcross * .96);',
      'float manorPhase = manorAlong * .95 + manorAcross * 1.41 + manorWave * .6;',
      'float manorStreak = smoothstep(.80, .995, sin(manorPhase));',
      'float manorBreak = smoothstep(-.3, .82, sin(manorAlong * .31 - manorAcross * .92));',
      'float manorFoam = smoothstep(.78, .97, manorBank) * smoothstep(.46, .98, sin(manorAlong * 1.47));',
      'diffuseColor.rgb = mix(diffuseColor.rgb * (.96 + .05 * manorWave),',
      '  vec3(.54, .83, .78), clamp(.29 * manorStreak * manorBreak + .38 * manorFoam, 0.0, .65));',
    ];
    const cascade = [
      '#include <map_fragment>',
      'float manorSheet = sin(vManorFlow.y * 57.0 + manorTime * 7.8 + sin(vManorFlow.x * 73.0));',
      'diffuseColor.rgb *= .93 + .11 * manorSheet;',
    ];
    shader.fragmentShader = 'uniform float manorTime;\n' + flowHeader + shader.fragmentShader.replace(
      '#include <map_fragment>', (river ? current : cascade).join('\n')
    );
  };
  material.customProgramCacheKey = () => 'manor-nature/' + mode + '/1';
  material.needsUpdate = true;
}

function prepareLandscape(THREE, group, clock, { bridge, ground }) {
  const grass = [];
  const animated = new Set();
  const bridgePoint = new THREE.Vector3(bridge.x, ground, bridge.z);
  group.updateMatrixWorld(true);
  group.traverse(mesh => {
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const data = mesh.userData;
    const label = String(mesh.name).replace(/_/g, ' ').toLowerCase();
    const display = materials.map(material => (material && material.name) || '').join(' ').toLowerCase();
    const castsShadow = /stone arch|landmark trees|canopy \d|outcrops \d|rounded creek stones/.test(label) ||
      /painted leaf and blossom tips/.test(display);
    if (castsShadow || data.grass === true) {
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const sphere = geometry.boundingSphere.clone().applyMatrix4(mesh.matrixWorld);
      if (castsShadow) mesh.castShadow = bridgePoint.distanceTo(sphere.center) < sphere.radius + 135;
      if (data.grass === true) {
        const detailRange = data.detail === 'near' ? 122 : 210;
        grass.push({ mesh, center: sphere.center, range2: Math.pow(sphere.radius + detailRange, 2),
          plot: data.grassPlotId, sourceVisible: mesh.visible });
      }
    }
    mesh.receiveShadow = castsShadow || /sunlit meadow|sky-blue current|handlaid buff limestone|meadow grass|reference wildflowers/.test(display);
    for (const material of materials) {
      if (!material) continue;
      const name = material.name.toLowerCase();
      if (name === 'painted valley sky') {
        material.fog = false;
        material.toneMapped = false;
        material.needsUpdate = true;
      }
      const mode = /mineral-green and sky-blue current/.test(name) ? 'river'
        : /waterfall curtain/.test(name) ? 'cascade'
          : /leaf and blossom tips|botanical leaf sprays/.test(name) ? 'leaf'
            : /meadow grass/.test(name) ? 'grass' : null;
      if (!mode || (mode === 'river' ? !addFlowCoordinates(THREE, geometry) : !geometry.getAttribute('uv'))) continue;
      if (animated.has(material)) continue;
      animated.add(material);
      installMotion(material, mode, clock);
    }
  });
  return grass;
}

function createManorScene({ THREE, renderer, disposeModel }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc7dfec);
  scene.fog = new THREE.Fog(0xc7dfec, 1400, 3700);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.4, 14000);
  const target = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const followPoint = new THREE.Vector3();
  const followOffset = new THREE.Vector3();
  const clock = { value: 0 };
  const sun = new THREE.DirectionalLight(0xfff6df, 1.69);
  const rim = new THREE.DirectionalLight(0xdbedff, 0.29);
  rim.position.set(-95, 88, -150);
  scene.add(new THREE.HemisphereLight(0xf4fbff, 0xbad1a1, 1.38), sun, sun.target, rim);
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  if ('toneMapping' in renderer) renderer.toneMapping = THREE.NoToneMapping;
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    sun.castShadow = true;
    const size = Math.min(1024, renderer.capabilities ? renderer.capabilities.maxTextureSize : 1024);
    sun.shadow.mapSize.set(size, size);
    Object.assign(sun.shadow.camera, { left: -115, right: 115, top: 115, bottom: -115, near: 8, far: 510 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.00022;
    sun.shadow.normalBias = 0.065;
  }

  let config;
  let landscape;
  let villa;
  let villaAnchor;
  let villaBounds;
  let villaPlot;
  let plannedPlot;
  let player;
  let grass = [];
  let height = 1;
  let azimuth = 0.72;
  let elevation = 0.50;
  let distance = 155;
  let view = 'default';
  let dirty = true;
  let disposed = false;

  function trackPlayer(force = false, dt = 0) {
    if (!player?.position) return;
    followPoint.copy(player.position).add(followOffset);
    followPoint.y += player.height * PLAYER_TARGET_HEIGHT;
    if (!force && target.distanceToSquared(followPoint) < 0.000004) return;
    if (force) target.copy(followPoint);
    else target.lerp(followPoint, 1 - Math.exp(-13 * dt));
    dirty = true;
  }

  function focusCharacter() {
    if (disposed || !player?.position) return false;
    if (view !== 'player') {
      view = 'player';
      azimuth = 0.76;
      elevation = 0.38;
      distance = PLAYER_DISTANCE;
    }
    followOffset.set(0, 0, 0);
    constrainFollowOffset();
    trackPlayer(true);
    return true;
  }

  function showCharacter(model) {
    if (disposed || !player || model === landscape || model === villa) throw new Error('请先加载庄园地形');
    const first = !player.position;
    player.show(model, azimuth);
    if (first) focusCharacter();
    else if (view === 'player') {
      constrainFollowOffset();
      trackPlayer(true);
    }
  }

  function setPlayerInput(x, y, run) {
    if (disposed || !player?.position) return;
    if (Math.hypot(x, y) > 0.14 && view !== 'player') focusCharacter();
    player.setInput(x, y, run);
  }

  function maxDistance() {
    const diagonal = config ? Math.hypot(config.width, config.depth) : 1537;
    return clamp(diagonal * 1.65 / Math.max(0.37, Math.min(1, camera.aspect)), 160, 6000);
  }

  function cameraDirection() {
    return direction.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
  }

  function fit(points, minimumDistance) {
    const dir = cameraDirection();
    const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    const up = new THREE.Vector3().crossVectors(dir, right);
    const vertical = Math.tan(camera.fov * Math.PI / 360);
    distance = minimumDistance;
    for (const point of points) {
      offset.set(point[0], point[1], point[2]).sub(target);
      distance = Math.max(distance, offset.dot(dir) + Math.max(
        Math.abs(offset.dot(right)) / (vertical * camera.aspect * 0.84),
        Math.abs(offset.dot(up)) / (vertical * 0.77)
      ));
    }
    distance = clamp(distance, MIN_DISTANCE, maxDistance());
    dirty = true;
  }

  function defaultView() {
    azimuth = 0.76;
    elevation = 0.51;
    const bridge = config ? config.bridge : { x: 0, z: 66 };
    const ground = config ? config.ground : 4.1;
    const plot = villaPlot || plannedPlot;
    target.set(plot ? (bridge.x + plot.x) * 0.5 : bridge.x, ground + 3.5, plot ? (bridge.z + plot.z) * 0.5 : bridge.z);
    const points = [[bridge.x - 15, ground, bridge.z - 11], [bridge.x + 15, ground + 6, bridge.z + 11]];
    if (plot) {
      for (const x of [plot.x - 12, plot.x + 12]) for (const z of [plot.z - 8, plot.z + 8]) {
        points.push([x, plot.y, z], [x, plot.y + 13, z]);
      }
    }
    fit(points, plot ? 100 : 145);
  }

  function resetView() {
    if (disposed || !config) return;
    view = 'overview';
    azimuth = 0.41;
    elevation = 0.83;
    target.set(0, config.ground + 3.5, 0);
    const points = [];
    for (const x of [-config.width / 2, config.width / 2]) {
      for (const z of [-config.depth / 2, config.depth / 2]) points.push([x, config.ground, z]);
    }
    fit(points, MIN_DISTANCE);
  }

  function focusVilla() {
    if (disposed || !villaBounds) return false;
    view = 'villa';
    azimuth = 0.54;
    elevation = 0.34;
    const { min, max } = villaBounds;
    villaBounds.getCenter(target);
    const corners = [];
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      corners.push([x, y, z]);
    }
    fit(corners, MIN_DISTANCE);
    return true;
  }

  function resize(width, nextHeight) {
    if (disposed || !finite(width) || !finite(nextHeight) || width <= 0 || nextHeight <= 0) return;
    renderer.setSize(width, nextHeight, false);
    height = nextHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (view === 'default') defaultView();
    else if (view === 'villa') focusVilla();
    else if (view === 'overview') resetView();
    else if (view === 'player') {
      constrainFollowOffset();
      trackPlayer(true);
    } else distance = clamp(distance, MIN_DISTANCE, maxDistance());
    dirty = true;
  }

  function flagShadows() {
    if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true;
  }

  function removeVilla() {
    if (!villa) return;
    scene.remove(villaAnchor);
    villaAnchor.remove(villa);
    disposeModel(villa);
    villa = villaAnchor = villaBounds = villaPlot = null;
  }

  function showLandscape(group, layout) {
    if (disposed || !group || !group.isObject3D || group === villa) throw layoutError('庄园模型不可用');
    if (landscape === group) return config;
    const next = validateLayout(layout);
    const nextGrass = prepareLandscape(THREE, group, clock, next);
    const navigation = createManorNavigation({ THREE, landscape: group, config: next });
    player?.dispose();
    player = createManorPlayer({ THREE, scene, navigation, getVillaBounds: () => villaBounds, disposeModel });
    removeVilla();
    if (landscape) {
      scene.remove(landscape);
      disposeModel(landscape);
    }
    config = next;
    grass = nextGrass;
    landscape = group;
    plannedPlot = next.plots.find(plot => plot.width >= 21 && plot.depth >= 13) || next.plots[0];
    scene.add(group);
    sun.target.position.set(next.bridge.x, next.ground, next.bridge.z);
    sun.position.copy(sun.target.position).add(new THREE.Vector3(135, 192, 55));
    flagShadows();
    view = 'default';
    defaultView();
    return config;
  }

  function showVilla(group) {
    if (disposed || !landscape || !group || !group.isObject3D || group === landscape) {
      throw new Error('请先加载庄园地形');
    }
    if (villa === group) return villaPlot;
    const bounds = new THREE.Box3().setFromObject(group);
    const size = bounds.getSize(new THREE.Vector3());
    if (bounds.isEmpty() || ![size.x, size.y, size.z].every(finite) || Math.min(size.x, size.y, size.z) <= 0) {
      throw new Error('别墅模型尺寸有误');
    }
    const plot = config.plots.find(item => item.width >= size.x + 2 && item.depth >= size.z + 2);
    if (!plot) throw new Error('庄园没有能放下这栋别墅的地块');
    const center = bounds.getCenter(new THREE.Vector3());
    const anchor = new THREE.Group();
    anchor.name = 'Villa plot ' + plot.id;
    anchor.position.set(plot.x - center.x, plot.y - bounds.min.y - 0.015, plot.z - center.z);
    group.traverse(mesh => {
      if (mesh.isMesh) mesh.castShadow = mesh.receiveShadow = true;
    });
    removeVilla();
    anchor.add(group);
    scene.add(anchor);
    villa = group;
    villaAnchor = anchor;
    villaPlot = plot;
    villaBounds = bounds.translate(anchor.position);
    if (player?.avoidVilla() && view === 'player') trackPlayer(true);
    flagShadows();
    if (view === 'default' && plot !== plannedPlot) defaultView();
    else if (view === 'villa') focusVilla();
    dirty = true;
    return plot;
  }

  function constrainFollowOffset() {
    // Fit the rotating avatar's envelope inside the perspective view before allowing pan.
    const sinEl = Math.sin(elevation), cosEl = Math.cos(elevation);
    const tanY = Math.tan(camera.fov * Math.PI / 360) * 0.9;
    const tanX = tanY * camera.aspect;
    const feet = -player.height * PLAYER_TARGET_HEIGHT;
    const top = feet + player.height;
    const radius = player.radius + 0.1;
    const support = (side, forward, vertical) => Math.hypot(side, forward) * radius +
      Math.max(feet * vertical, top * vertical);
    const horizontalSupport = support(1, tanX * cosEl, tanX * sinEl);
    const topPlane = tanY * cosEl - sinEl;
    const bottomPlane = tanY * cosEl + sinEl;
    const topSupport = support(0, topPlane, tanY * sinEl + cosEl);
    const bottomSupport = support(0, bottomPlane, tanY * sinEl - cosEl);
    distance = Math.max(distance, horizontalSupport / tanX, topSupport / tanY, bottomSupport / tanY);
    followOffset.clampLength(0, distance * 0.24 * Math.min(1, camera.aspect));
    const sinAz = Math.sin(azimuth), cosAz = Math.cos(azimuth);
    const right = followOffset.x * cosAz - followOffset.z * sinAz;
    const forward = followOffset.x * sinAz + followOffset.z * cosAz;
    let fraction = 1;
    const fitPlane = (available, used) => {
      if (used > 0) fraction = Math.min(fraction, Math.max(0, available) / used);
    };
    fitPlane(distance * tanX - horizontalSupport, Math.abs(right) - forward * tanX * cosEl);
    fitPlane(distance * tanY - topSupport, -forward * topPlane);
    fitPlane(distance * tanY - bottomSupport, -forward * bottomPlane);
    followOffset.multiplyScalar(fraction);
  }

  function pan(dx, dy) {
    if (disposed || !config || !finite(dx) || !finite(dy) || (!dx && !dy)) return;
    const scale = 2 * distance * Math.tan(camera.fov * Math.PI / 360) / height;
    const x = dx * scale;
    const z = dy * scale / Math.sin(elevation);
    const moveX = -x * Math.cos(azimuth) - z * Math.sin(azimuth);
    const moveZ = x * Math.sin(azimuth) - z * Math.cos(azimuth);
    if (view === 'player') {
      followOffset.x += moveX;
      followOffset.z += moveZ;
      constrainFollowOffset();
      trackPlayer(true);
      return;
    }
    target.x = clamp(target.x + moveX, -config.width / 2, config.width / 2);
    target.z = clamp(target.z + moveZ, -config.depth / 2, config.depth / 2);
    view = 'free';
    dirty = true;
  }

  function orbit(dx, dy) {
    if (disposed || !config || !finite(dx) || !finite(dy)) return;
    const anglePerPixel = 3.5 / Math.max(150, height);
    azimuth = (azimuth - dx * anglePerPixel) % FULL_TURN;
    elevation = clamp(elevation + dy * anglePerPixel, MIN_ELEVATION, MAX_ELEVATION);
    if (view === 'player') {
      constrainFollowOffset();
      trackPlayer(true);
    } else view = 'free';
    dirty = true;
  }

  function zoom(factor) {
    if (disposed || !config || !finite(factor) || factor <= 0) return;
    if (view === 'player') {
      distance = clamp(distance / factor, PLAYER_ZOOM_MIN, PLAYER_ZOOM_MAX);
      constrainFollowOffset();
      trackPlayer(true);
    } else {
      distance = clamp(distance / factor, MIN_DISTANCE, maxDistance());
      view = 'free';
    }
    dirty = true;
  }

  function render(timeSeconds, deltaSeconds = 0) {
    if (disposed || !landscape) return;
    if (finite(timeSeconds)) clock.value = timeSeconds;
    const dt = finite(deltaSeconds) ? clamp(deltaSeconds, 0, 0.1) : 0;
    player?.update(dt, azimuth);
    if (view === 'player' && dt > 0) trackPlayer(false, dt);
    if (dirty) {
      camera.position.copy(target).addScaledVector(cameraDirection(), distance);
      camera.lookAt(target);
      camera.near = clamp(distance / 125, 0.25, 25);
      camera.updateProjectionMatrix();
      const fogOffset = Math.max(0, distance - 970);
      scene.fog.near = 1400 + fogOffset;
      scene.fog.far = 3700 + fogOffset;
      for (const tile of grass) {
        tile.mesh.visible = tile.sourceVisible && (!villaPlot || tile.plot !== villaPlot.id) &&
          camera.position.distanceToSquared(tile.center) <= tile.range2;
      }
      dirty = false;
    }
    renderer.render(scene, camera);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    player?.dispose();
    player = null;
    removeVilla();
    if (landscape) disposeModel(landscape);
    landscape = config = plannedPlot = null;
    grass = [];
    scene.clear();
    sun.shadow.dispose();
  }

  return { resize, showLandscape, showVilla, showCharacter, setPlayerInput, pan, orbit, zoom,
    resetView, focusVilla, focusCharacter, render, dispose };
}

module.exports = { createManorScene };
