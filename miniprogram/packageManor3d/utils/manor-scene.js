const { createManorNavigation } = require('./manor-navigation');
const { createManorInteriorNavigation } = require('./manor-interior-navigation');
const { createManorInteriorElevator } = require('./manor-interior-elevator');
const { createCourtyardInterior } = require('./manor-courtyard-interior');
const { createManorPlayer } = require('./manor-player');
const { createManorBuildView, RED_VILLA, COURTYARD, visualSpecs } = require('./manor-build-view');

const MIN_DISTANCE = 23;
const PLAYER_DISTANCE = 8.5;
const INTERIOR_PLAYER_DISTANCE = 4.8;
const PLAYER_ZOOM_MIN = 3.5;
const PLAYER_ZOOM_MAX = 36;
const PLAYER_TARGET_HEIGHT = 0.68;
const INTERIOR_TARGET_HEIGHT = 0.58;
const CAMERA_FOV = 40;
const MAX_INTERIOR_FOV = 108;
const MIN_ELEVATION = -Math.PI / 6;
const MIN_PAN_ELEVATION = Math.PI / 10;
const MAX_ELEVATION = Math.PI * 0.44;
const CAMERA_GROUND_CLEARANCE = 0.4;
const INTERIOR_CAMERA_CLEARANCE = 0.18;
const COURTYARD_DOOR_REACH = 2.1;
const COURTYARD_DOOR_SWING_TIME = .32;
const COURTYARD_DOOR_WALK_SPEED = 2.9;
const SHARED_SOURCE_WIDTH = 2240;
const SHARED_SOURCE_DEPTH = 2240;
const SHARED_POSITION_WIDTH = 1200;
const SHARED_POSITION_DEPTH = 960;
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
  const buildings = createManorBuildView({ THREE, scene, disposeModel });
  scene.background = new THREE.Color(0xc7dfec);
  scene.fog = new THREE.Fog(0xc7dfec, 1400, 3700);
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.4, 14000);
  const target = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const followPoint = new THREE.Vector3();
  const cameraRay = new THREE.Raycaster();
  const cameraHit = new THREE.Vector3();
  const cameraArm = new THREE.Vector3();
  const cameraCandidate = new THREE.Vector3();
  const avatarPoint = new THREE.Vector3();
  const cameraIntersections = [];
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
  let interior;
  let interiorNavigation;
  let interiorElevator;
  let interiorMetadata;
  let interiorOccluders = [];
  let interiorCameraDistance;
  let outdoorOrbit;
  let insideVilla = false;
  const courtyards = new Map();
  let activeCourtyard;
  let courtyardPassage;
  const isInsideBuilding = () => insideVilla || !!activeCourtyard;
  let plannedPlot;
  let navigation;
  let player;
  let grass = [];
  let width = 1;
  let height = 1;
  let azimuth = 0.72;
  let elevation = 0.50;
  let distance = 155;
  let view = 'default';
  let mapView = false;
  let buildOrbit;
  let outdoorBounds;
  const buildRay = new THREE.Raycaster();
  const buildGround = new THREE.Plane(new THREE.Vector3(0, 1, 0));
  const buildHit = new THREE.Vector3();
  const buildPointer = new THREE.Vector2();
  let communityView;
  let communitySignature = '';
  let sharedNodes = new Map();
  let dirty = true;
  let disposed = false;

  function trackPlayer(force = false, dt = 0) {
    if (!player?.position) return;
    followPoint.copy(player.position);
    followPoint.y += player.height * (isInsideBuilding() ? INTERIOR_TARGET_HEIGHT : PLAYER_TARGET_HEIGHT);
    if (!force && target.distanceToSquared(followPoint) < 0.000004) return;
    if (force) target.copy(followPoint);
    else {
      target.lerp(followPoint, 1 - Math.exp(-13 * dt));
      if (insideVilla && interiorElevator?.carrying) target.y = followPoint.y;
    }
    dirty = true;
  }

  function focusCharacter() {
    if (disposed || buildOrbit || !player?.position) return false;
    mapView = false;
    if (view !== 'player') {
      view = 'player';
      azimuth = 0.76;
      elevation = 0.38;
      distance = PLAYER_DISTANCE;
    }
    fitAvatar();
    trackPlayer(true);
    return true;
  }

  function showCharacter(model) {
    if (disposed || !player || model === landscape || model === villa) throw new Error('请先加载庄园地形');
    const first = !player.position;
    player.show(model, azimuth);
    if (first && !mapView) focusCharacter();
    else if (view === 'player') {
      fitAvatar();
      trackPlayer(true);
    }
  }

  function setPlayerInput(x, y) {
    if (disposed || view !== 'player' || !player?.position || interiorElevator?.busy || courtyardPassage) return;
    player.setInput(x, y);
  }

  function getMapPlayerPosition() {
    const position = player?.position;
    return position ? { x: position.x, z: position.z } : null;
  }

  function placeCharacterAt(position, facing) {
    if (disposed || isInsideBuilding() || courtyardPassage || !player || !position) return false;
    if (player.place(position.x, position.z, facing, position.y)) return true;
    const nearest = navigation?.nearestWalkable?.(position.x, position.z, outdoorBounds, 24);
    return nearest ? player.place(nearest.x, nearest.z, facing, nearest.y) : false;
  }

  function getPlayerSyncState() {
    const position = player?.position;
    if (!position || isInsideBuilding() || courtyardPassage) return null;
    return {
      position3d: { x: position.x, z: position.z },
      moving: player.isMoving,
      running: player.isRunning,
      facing: player.facing
    };
  }

  function getPlayerCheckpoint() {
    const position = player?.position;
    if (!position) return null;
    if (activeCourtyard || (courtyardPassage && !courtyardPassage.committed)) return getCourtyardCheckpoint();
    const { x, y, z } = position;
    const facing = player.facing;
    if (!insideVilla) return { x, y, z, facing };

    const exterior = doorPoints()?.outside;
    if (interiorNavigation.sample(x, z, null, y) === null) {
      // Mid-ride positions belong to a moving cabin. Use its nearest landing.
      const landing = interiorElevator?.busy && interiorNavigation.elevator?.landings.reduce((nearest, point) =>
        Math.abs(point.y - y) < Math.abs(nearest.y - y) ? point : nearest);
      if (!landing) return null;
      return { x: landing.x, y: landing.y, z: landing.z, facing, interior: { kind: 'red' }, exterior };
    }
    return { x, y, z, facing, interior: { kind: 'red' }, exterior };
  }

  function restorePlayerPosition(saved) {
    if (disposed || isInsideBuilding() || courtyardPassage || !player?.position ||
        ![saved?.x, saved?.y, saved?.z, saved?.facing].every(finite)) return false;
    if (saved.interior?.kind === 'courtyard') return restoreCourtyardPosition(saved);
    if (saved.interior) return false;
    if (!placeCharacterAt(saved, saved.facing)) return false;
    focusCharacter();
    return true;
  }

  function clearCommunityView() {
    if (!communityView) return;
    scene.remove(communityView);
    for (const node of sharedNodes.values()) disposeSharedNode(node);
    sharedNodes = new Map();
    communityView = null;
    communitySignature = '';
  }

  function disposeSharedNode(node) {
    const geometries = new Set(), materials = new Set();
    node.group.traverse(child => {
      if (child.geometry) geometries.add(child.geometry);
      if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach(material => materials.add(material));
    });
    node.group.removeFromParent();
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
  }

  function manorPoint(x, z) {
    return {
      x: x / SHARED_SOURCE_WIDTH * SHARED_POSITION_WIDTH - config.width / 2,
      z: z / SHARED_SOURCE_DEPTH * SHARED_POSITION_DEPTH - config.depth / 2
    };
  }

  function sharedGround(x, z) {
    return navigation.sample(x, z) ?? config.ground;
  }

  function addSharedPlotDetail(root, building, plot) {
    if (!building || !Number.isFinite(building.x) || !Number.isFinite(building.z)) return;
    const type = String(building.type || building.buildingType || '');
    const category = String(building.category || building.buildingCategory || '');
    const tree = category === 'tree' || /^(?:tree|landscape)(?:_|$)/.test(type);
    // Keep supported tree decorations from the 2D catalog.
    if (!tree) return;
    const point = manorPoint(building.x, building.z);
    const y = navigation.sample(point.x, point.z, villaBounds);
    if (y === null) return;
    const width = Math.max(1.4, Math.min(30, (Number(building.width) || 7) * SHARED_POSITION_WIDTH / SHARED_SOURCE_WIDTH));
    const depth = Math.max(1.4, Math.min(30, (Number(building.depth) || 7) * SHARED_POSITION_DEPTH / SHARED_SOURCE_DEPTH));
    const group = new THREE.Group();
    group.name = 'Shared plot detail ' + (building.instanceId || building.id || type);
    group.userData = { ownerId: plot.ownerId || '', type, category, name: building.name || '' };
    group.position.set(point.x, y, point.z);

    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(.28, .4, 2.6, 7),
      new THREE.MeshStandardMaterial({ color: 0x826047, roughness: 1 }));
    trunk.position.y = 1.3;
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(Math.max(.9, Math.min(width, depth) * .4), 1),
      new THREE.MeshStandardMaterial({ color: 0x66876c, roughness: 1 }));
    crown.position.y = 3.1;
    group.add(trunk, crown);
    root.add(group);
  }

  function addSharedCharacter(root, record, ownPlayerId) {
    if (!record || record.id === ownPlayerId || record.manor3dOnline !== true) return;
    const position = record.position3d;
    if (!position || ![position.x, position.z].every(finite) ||
        Math.abs(position.x) > config.width / 2 + 2 || Math.abs(position.z) > config.depth / 2 + 2) return;
    const group = new THREE.Group();
    group.name = 'Shared character ' + record.id;
    group.userData = { ownerId: record.ownerId || '', name: record.name || '邻居', userTitle: record.userTitle || null };
    group.position.set(position.x, sharedGround(position.x, position.z), position.z);
    const color = record.characterType === 'girl' ? 0xc88783 : 0x708b87;
    const outfit = new THREE.Mesh(new THREE.CapsuleGeometry(.42, .8, 3, 7),
      new THREE.MeshStandardMaterial({ color, roughness: .88 }));
    outfit.position.y = .82;
    const head = new THREE.Mesh(new THREE.SphereGeometry(.34, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xe8c8a4, roughness: .96 }));
    head.position.y = 1.62;
    group.add(outfit, head);
    const facing = typeof record.manor3dFacing === 'number' ? record.manor3dFacing
      : typeof record.facing === 'number' ? record.facing : null;
    if (facing !== null && finite(facing)) group.rotation.y = facing;
    root.add(group);
    return {
      kind: 'presence',
      group,
      target: new THREE.Vector3(position.x, sharedGround(position.x, position.z), position.z),
      targetYaw: group.rotation.y
    };
  }

  function setSharedRecords(records, ownPlayerId) {
    if (disposed || !config || !Array.isArray(records)) return;
    if (!communityView) {
      communityView = new THREE.Group();
      communityView.name = 'Shared community scene';
      scene.add(communityView);
    }
    const received = new Set();
    for (const record of records) {
      if (!record?.id) continue;
      received.add(record.id);
      const current = sharedNodes.get(record.id);
      if (record.deleted) {
        if (current) {
          disposeSharedNode(current);
          sharedNodes.delete(record.id);
        }
        continue;
      }
      if (record.kind === 'plot') {
        // A present but empty placement list is authoritative. In particular,
        // the default residential plot type does not describe a 3D building.
        const buildings = Array.isArray(record.buildings) ? record.buildings.filter(Boolean) : [];
        const signature = JSON.stringify([
          record.ownerId, record.x, record.z, record.size, record.mine,
          buildings.map(building => [building.instanceId, building.id, building.type || building.buildingType,
            building.category || building.buildingCategory, building.name, building.width, building.depth, building.x, building.z])
        ]);
        if (current?.kind === 'plot' && current.signature === signature) continue;
        if (current) disposeSharedNode(current);
        const group = new THREE.Group();
        group.name = 'Shared plot ' + record.id;
        for (const building of buildings) addSharedPlotDetail(group, building, record);
        if (!group.children.length) {
          sharedNodes.delete(record.id);
          continue;
        }
        communityView.add(group);
        sharedNodes.set(record.id, { kind: 'plot', signature, group });
      } else if (record.kind === 'presence') {
        const hidden = record.id === ownPlayerId || record.online === false && record.manor3dOnline !== true;
        const position = record.position3d || (record.position && manorPoint(record.position.x, record.position.z));
        const characterType = record.manor3dCharacterType || record.characterType;
        const signature = JSON.stringify([characterType, record.appearance?.id || record.appearance?.assetId || '']);
        if (hidden || !position || ![position.x, position.z].every(finite) ||
            Math.abs(position.x) > config.width / 2 + 2 || Math.abs(position.z) > config.depth / 2 + 2) {
          if (current) {
            disposeSharedNode(current);
            sharedNodes.delete(record.id);
          }
          continue;
        }
        if (current?.kind === 'presence' && current.signature === signature) {
          current.target.set(position.x, sharedGround(position.x, position.z), position.z);
          const yaw = record.manor3dFacing ?? record.facing;
          if (finite(yaw)) current.targetYaw = yaw;
          current.record = record;
          continue;
        }
        if (current) disposeSharedNode(current);
        const group = new THREE.Group();
        group.name = 'Shared character ' + record.id;
        group.userData = { ownerId: record.ownerId || '', name: record.name || '邻居', userTitle: record.userTitle || null };
        const color = characterType === 'girl' ? 0xc88783 : 0x708b87;
        const outfit = new THREE.Mesh(new THREE.CapsuleGeometry(.42, .8, 3, 7),
          new THREE.MeshStandardMaterial({ color, roughness: .88 }));
        outfit.position.y = .82;
        const head = new THREE.Mesh(new THREE.SphereGeometry(.34, 10, 8),
          new THREE.MeshStandardMaterial({ color: 0xe8c8a4, roughness: .96 }));
        head.position.y = 1.62;
        group.add(outfit, head);
        group.position.set(position.x, sharedGround(position.x, position.z), position.z);
        const targetYaw = record.manor3dFacing ?? record.facing;
        if (finite(targetYaw)) group.rotation.y = targetYaw;
        communityView.add(group);
        sharedNodes.set(record.id, {
          kind: 'presence', signature, group,
          target: group.position.clone(), targetYaw: group.rotation.y,
          record
        });
      }
    }
    for (const [id, node] of sharedNodes) {
      if (received.has(id)) continue;
      disposeSharedNode(node);
      sharedNodes.delete(id);
    }
  }

  function maxDistance() {
    const diagonal = config ? Math.hypot(config.width, config.depth) : 1537;
    return clamp(diagonal * 1.65 / Math.max(0.37, Math.min(1, camera.aspect)), 160, 6000);
  }

  function cameraDirection() {
    const orbitElevation = Math.max(0, elevation);
    const horizontal = Math.cos(orbitElevation);
    return direction.set(Math.sin(azimuth) * horizontal, Math.sin(orbitElevation), Math.cos(azimuth) * horizontal);
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

  function enterMapView() {
    if (disposed || isInsideBuilding() || courtyardPassage || buildOrbit || !config) return;
    mapView = true;
    player?.setInput(0, 0);
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

  function exitMapView() {
    if (disposed || buildOrbit || !config || !mapView) return;
    if (focusCharacter()) return;
    mapView = false;
    view = 'default';
    defaultView();
  }

  function focusVilla() {
    if (disposed || isInsideBuilding() || courtyardPassage || buildOrbit || !villaBounds) return false;
    mapView = true;
    player?.setInput(0, 0);
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

  function resize(nextWidth, nextHeight) {
    if (disposed || !finite(nextWidth) || !finite(nextHeight) || nextWidth <= 0 || nextHeight <= 0) return;
    width = nextWidth;
    renderer.setSize(width, nextHeight, false);
    height = nextHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (view === 'default') defaultView();
    else if (view === 'villa') focusVilla();
    else if (view === 'overview') enterMapView();
    else if (view === 'player') {
      fitAvatar();
      trackPlayer(true);
    } else distance = clamp(distance, MIN_DISTANCE, maxDistance());
    dirty = true;
  }

  function flagShadows() {
    if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true;
  }

  function getBuildPlots() {
    const reserved = (villaPlot || plannedPlot)?.id;
    return config?.plots.filter(plot => plot.id !== 'M151' && plot.id !== reserved).map(plot => ({ ...plot })) || [];
  }

  function refreshOutdoorBounds(relocate = false) {
    outdoorBounds = villaBounds ? [villaBounds, ...buildings.collision] : buildings.collision;
    const position = player?.position;
    if (relocate && !isInsideBuilding() && !courtyardPassage && position && navigation.sample(position.x, position.z, outdoorBounds) === null) {
      const point = navigation.nearestWalkable(position.x, position.z, outdoorBounds, 24);
      if (point ? player.place(point.x, point.z, player.facing, point.y) : player.avoidVilla()) {
        if (view === 'player') trackPlayer(true);
      }
    }
    flagShadows();
    dirty = true;
  }

  function setBuildModel(id, group) {
    if (disposed || !config) throw new Error('请先加载庄园地形');
    if (buildings.setModel(id, group)) {
      refreshOutdoorBounds(true);
      refreshCourtyards();
    }
  }

  function setPlacedBuildings(records) {
    if (!disposed && config && buildings.setPlaced(records)) {
      refreshOutdoorBounds(true);
      refreshCourtyards();
    }
  }

  function setBuildPreview(selection) {
    if (disposed || !config || isInsideBuilding() || courtyardPassage) return false;
    if (!selection) {
      if (!buildOrbit) return false;
      buildings.showPreview(null);
      ({ mapView, view, azimuth, elevation, distance } = buildOrbit);
      target.copy(buildOrbit.target);
      buildOrbit = null;
      if (view === 'player' && player?.position) trackPlayer(true);
      dirty = true;
      return true;
    }
    const spec = Object.prototype.hasOwnProperty.call(visualSpecs, selection.buildingId) && visualSpecs[selection.buildingId];
    if (!spec) return false;
    const lots = getBuildPlots();
    let plot = config.plots.find(item => item.id === selection.plotId || (finite(selection.x) && finite(selection.z) &&
      Math.abs(item.x - selection.x) <= item.width / 2 && Math.abs(item.z - selection.z) <= item.depth / 2));
    const entering = !buildOrbit;
    if (entering) {
      buildOrbit = { mapView, view, azimuth, elevation, distance, target: target.clone() };
      mapView = true;
      view = 'build';
      azimuth = 0;
      elevation = MAX_ELEVATION;
      player?.setInput(0, 0);
    }
    // A new style can need a larger lot. Keep the camera steady while turning
    // or checking an already selected position.
    if (entering || (!plot && buildOrbit.buildingId !== selection.buildingId)) {
      const from = player?.position || config.bridge;
      const legal = new Set((selection.regions || []).map(region => region.plotId));
      const byDistance = (a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z);
      const nearest = lots.filter(item => !buildings.occupied.has(item.id)).sort(byDistance);
      plot ||= nearest.find(item => legal.has(item.id)) || nearest.find(item =>
        (item.width >= spec.width + 2 && item.depth >= spec.depth + 2) ||
        (item.width >= spec.depth + 2 && item.depth >= spec.width + 2));
      const center = plot || from;
      const x = finite(selection.x) ? selection.x : center.x;
      const z = finite(selection.z) ? selection.z : center.z;
      const y = plot?.y ?? config.ground;
      target.set(x, y, z);
      const halfWidth = Math.max(28, (plot?.width || 0) / 2 + 4);
      const halfDepth = Math.max(25, (plot?.depth || 0) / 2 + 4);
      fit([[x-halfWidth,y,z-halfDepth], [x-halfWidth,y,z+halfDepth],
        [x+halfWidth,y,z-halfDepth], [x+halfWidth,y,z+halfDepth]], MIN_DISTANCE);
    }
    buildOrbit.buildingId = selection.buildingId;
    buildings.showPreview({ ...selection, y: plot?.y ?? config.ground });
    dirty = true;
    return true;
  }

  function pickBuildGround(x, y, viewportWidth = width, viewportHeight = height) {
    if (!buildOrbit || ![x, y, viewportWidth, viewportHeight].every(finite) || viewportWidth <= 0 || viewportHeight <= 0 ||
        x < 0 || x > viewportWidth || y < 0 || y > viewportHeight) return null;
    if (dirty) updateCamera(0);
    camera.updateMatrixWorld();
    buildPointer.set(x / viewportWidth * 2 - 1, 1 - y / viewportHeight * 2);
    buildRay.setFromCamera(buildPointer, camera);
    // The authored lots are level; test their own elevations before the general ground.
    for (const plot of config.plots) {
      buildGround.constant = -plot.y;
      if (buildRay.ray.intersectPlane(buildGround, buildHit) && Math.abs(buildHit.x - plot.x) <= plot.width / 2 &&
          Math.abs(buildHit.z - plot.z) <= plot.depth / 2) return { x: buildHit.x, z: buildHit.z };
    }
    buildGround.constant = -config.ground;
    return buildRay.ray.intersectPlane(buildGround, buildHit) ? { x: buildHit.x, z: buildHit.z } : null;
  }

  function restoreOutdoorOrbit() {
    if (outdoorOrbit) ({ distance, elevation, azimuth } = outdoorOrbit);
    outdoorOrbit = null;
    interiorCameraDistance = undefined;
    camera.fov = CAMERA_FOV;
  }

  function removeVilla() {
    if (!villa && !interior) return;
    if (insideVilla && player && navigation) {
      player.setInput(0, 0);
      player.setNavigation(navigation, () => outdoorBounds);
      player.avoidVilla();
    }
    if (insideVilla) {
      insideVilla = false;
      restoreOutdoorOrbit();
      if (view === 'player') trackPlayer(true);
    }
    if (villaAnchor) scene.remove(villaAnchor);
    if (villa) buildings.forgetBorrowedModel(RED_VILLA, villa);
    if (villa) disposeModel(villa);
    if (interior && interior !== villa) disposeModel(interior);
    villa = villaAnchor = villaBounds = villaPlot = null;
    interior = null;
    interiorNavigation = null;
    interiorElevator = null;
    interiorMetadata = null;
    if (!activeCourtyard) interiorOccluders = [];
    insideVilla = false;
    refreshOutdoorBounds();
  }

  function showLandscape(group, layout) {
    if (disposed || !group || !group.isObject3D || group === villa) throw layoutError('庄园模型不可用');
    if (landscape === group) return config;
    const next = validateLayout(layout);
    const nextGrass = prepareLandscape(THREE, group, clock, next);
    const nextNavigation = createManorNavigation({ THREE, landscape: group, config: next });
    releaseCourtyards();
    player?.dispose();
    navigation = nextNavigation;
    player = createManorPlayer({ THREE, scene, navigation, getVillaBounds: () => outdoorBounds, disposeModel });
    removeVilla();
    clearCommunityView();
    if (landscape) {
      scene.remove(landscape);
      disposeModel(landscape);
    }
    config = next;
    grass = nextGrass;
    landscape = group;
    plannedPlot = next.plots.find(plot => plot.width >= 21 && plot.depth >= 13) || next.plots[0];
    buildOrbit = null;
    buildings.showPreview(null);
    buildings.setPlots(getBuildPlots(), true);
    refreshOutdoorBounds();
    scene.add(group);
    sun.target.position.set(next.bridge.x, next.ground, next.bridge.z);
    sun.position.copy(sun.target.position).add(new THREE.Vector3(135, 192, 55));
    flagShadows();
    mapView = false;
    communitySignature = '';
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
    clearCommunityView();
    buildings.setModel(RED_VILLA, group, bounds);
    anchor.add(group);
    scene.add(anchor);
    villa = group;
    villaAnchor = anchor;
    villaPlot = plot;
    villaBounds = bounds.translate(anchor.position);
    buildings.setPlots(getBuildPlots());
    refreshOutdoorBounds();
    refreshCourtyards();
    refreshCourtyards();
    interiorNavigation = createManorInteriorNavigation({ metadata: interiorMetadata, origin: anchor.position });
    insideVilla = false;
    if (!isInsideBuilding() && !courtyardPassage && player?.avoidVilla() && view === 'player') trackPlayer(true);
    flagShadows();
    if (view === 'default' && plot !== plannedPlot) defaultView();
    else if (view === 'villa') focusVilla();
    dirty = true;
    return plot;
  }

  function setVillaInteriorMetadata(metadata) {
    if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
      throw new Error('别墅室内元数据有误');
    }
    interiorMetadata = metadata || null;
    if (villaAnchor && !insideVilla) {
      interiorNavigation = buildInteriorNavigation(interior);
    }
    dirty = true;
    return interiorMetadata;
  }

  function buildInteriorNavigation(model) {
    return createManorInteriorNavigation({
      metadata: interiorMetadata,
      origin: villaAnchor.position,
      layout: model?.getObjectByName('VillaInterior')?.userData?.navigation
    });
  }

  function prepareInteriorCamera(model, courtyard = false) {
    interiorOccluders = [];
    model.updateWorldMatrix(true, true);
    model.traverse(mesh => {
      if (!mesh.isMesh || (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every(material => material.transparent)) return;
      for (let part = mesh; part && part !== model; part = part.parent) {
        if (courtyard ? ['Exterior', 'Walls', 'Structure', 'Roof'].includes(part.name) :
          part.userData.facadeIndex !== undefined || part.userData.floorSurfaceLevel === 2) {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          const bounds = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
          interiorOccluders.push({ mesh, bounds });
          break;
        }
      }
    });
  }

  function traceInterior(from, to, extra = 0) {
    const direction = cameraRay.ray.direction.subVectors(to, from);
    const length = direction.length();
    if (length < .05) return length + extra;
    direction.divideScalar(length);
    cameraRay.ray.origin.copy(from);
    cameraRay.near = 0.01;
    cameraRay.far = length + extra;
    for (const { mesh, bounds } of interiorOccluders) {
      if (!bounds.containsPoint(from) && (!cameraRay.ray.intersectBox(bounds, cameraHit) ||
        cameraHit.distanceToSquared(from) > cameraRay.far ** 2)) continue;
      cameraIntersections.length = 0;
      cameraRay.intersectObject(mesh, false, cameraIntersections);
      if (cameraIntersections.length) cameraRay.far = cameraIntersections[0].distance;
    }
    return cameraRay.far;
  }

  function keepCameraInside(dt) {
    const desired = cameraArm.subVectors(camera.position, target).length();
    if (desired < .05) return false;
    cameraArm.divideScalar(desired);
    let allowed = Math.max(.04, traceInterior(target, camera.position, INTERIOR_CAMERA_CLEARANCE) - INTERIOR_CAMERA_CLEARANCE);
    if (interiorElevator?.carrying && player?.position) {
      // A floor can obscure the avatar's head or feet even with a clear ray to its center.
      function canSeeRider(length) {
        cameraCandidate.copy(target).addScaledVector(cameraArm, length);
        for (const height of [.08, player.height * .94]) {
          avatarPoint.copy(player.position).y += height;
          // Trace from the camera to test the same face of the slab that it renders.
          if (traceInterior(cameraCandidate, avatarPoint) < cameraCandidate.distanceTo(avatarPoint) - .01) return false;
        }
        return true;
      }
      if (!canSeeRider(allowed)) {
        let near = .04, far = allowed;
        for (let step = 0; step < 6; step++) {
          const mid = (near + far) / 2;
          if (canSeeRider(mid)) near = mid;
          else far = mid;
        }
        allowed = Math.max(.04, near - .04);
      }
    }
    const last = interiorCameraDistance ?? allowed;
    const next = dt > 0 && last < allowed - .01 ? last + (allowed - last) * (1 - Math.exp(-14 * dt)) : allowed;
    interiorCameraDistance = next;
    camera.position.copy(target).addScaledVector(cameraArm, next);
    return allowed - next > .01;
  }

  function interiorCameraFov() {
    if (!player?.position || camera.position.distanceToSquared(target) >= distance * distance - .01) return CAMERA_FOV;
    camera.updateMatrixWorld();
    const { x, y, z } = player.position;
    const radius = player.radius;
    let tangent = Math.tan(CAMERA_FOV * Math.PI / 360);
    for (const height of [0, player.height]) {
      avatarPoint.set(x, y + height, z).applyMatrix4(camera.matrixWorldInverse);
      const depth = Math.max(.05, -avatarPoint.z);
      tangent = Math.max(tangent, Math.abs(avatarPoint.y) / (depth * .89));
    }
    avatarPoint.set(x, y + player.height / 2, z).applyMatrix4(camera.matrixWorldInverse);
    tangent = Math.max(tangent, (Math.abs(avatarPoint.x) + radius) / (Math.max(.05, -avatarPoint.z) * camera.aspect * .89));
    return Math.min(MAX_INTERIOR_FOV, Math.atan(tangent) * 360 / Math.PI);
  }

  function doorPoints() {
    if (!interiorNavigation || !villaAnchor) return null;
    const entry = interiorNavigation.entry();
    let distance = 3.1;
    let outside = interiorNavigation.outsideEntry(distance);
    // Keep the trigger outside the exterior villa's collision footprint. The
    // exported door marker is inside the porch, so a fixed short offset can
    // still land inside the exterior bounding box.
    while (navigation && villaBounds && navigation.sample(outside.x, outside.z, outdoorBounds) === null && distance < 8) {
      distance += .25;
      outside = interiorNavigation.outsideEntry(distance);
    }
    const ground = navigation?.sample(outside.x, outside.z, outdoorBounds);
    if (Number.isFinite(ground)) outside.y = ground;
    return { entry, outside, distance };
  }

  function getVillaEntryState() {
    const points = doorPoints();
    const position = player?.position;
    const nearDoor = !isInsideBuilding() && !courtyardPassage && !!points && !!position &&
      Math.hypot(position.x - points.outside.x, position.z - points.outside.z) <= 3.2;
    return { nearDoor, inside: insideVilla, available: !!villa && !!interiorNavigation, entry: points?.entry || null };
  }

  function releaseCourtyards() {
    if (activeCourtyard) {
      restoreOutdoorOrbit();
      interiorOccluders = [];
    }
    activeCourtyard = courtyardPassage = null;
    for (const building of courtyards.values()) building.interior.dispose();
    courtyards.clear();
  }

  function refreshCourtyards() {
    const placements = new Map(buildings.placedModels(COURTYARD).map(({ plotId, model }) => [plotId, model]));
    for (const [plotId, building] of courtyards) {
      if (placements.get(plotId) === building.model) continue;
      if (courtyardPassage?.building === building) {
        const { start, startFacing, entering, committed } = courtyardPassage;
        courtyardPassage = null;
        if (entering && !committed) leaveCourtyardAt(start, startFacing);
      }
      if (activeCourtyard?.building === building) leaveCourtyardAt(activeCourtyard.exterior, player?.facing);
      building.interior.dispose();
      courtyards.delete(plotId);
    }
    for (const [plotId, model] of placements) {
      if (courtyards.has(plotId)) continue;
      const interior = createCourtyardInterior({ THREE, model });
      if (interior) courtyards.set(plotId, { plotId, model, interior, doors: interior.getEntrances() });
    }
  }

  function courtyardExterior(door) {
    const { x, z } = door.outside;
    const y = navigation?.sample(x, z, outdoorBounds);
    return finite(y) ? new THREE.Vector3(x, y, z) : null;
  }

  function canReachCourtyardExterior(from, to, distance) {
    const steps = Math.ceil(distance / .28);
    let y = from.y;
    for (let step = 1; step <= steps; step++) {
      const f = step / steps;
      const next = navigation.sample(from.x + (to.x - from.x) * f, from.z + (to.z - from.z) * f, outdoorBounds);
      if (!finite(next) || Math.abs(next - y) > .33) return false;
      y = next;
    }
    return true;
  }

  function reachableCourtyardDoor() {
    const position = player?.position;
    if (!position || disposed || view !== 'player' || insideVilla || courtyardPassage) return null;
    const inside = Boolean(activeCourtyard);
    let nearest = null;
    for (const building of inside ? [activeCourtyard.building] : courtyards.values()) {
      for (const door of building.doors) {
        const approach = inside ? door.inside : door.outside;
        const distance = Math.hypot(position.x - approach.x, position.z - approach.z);
        if (distance > COURTYARD_DOOR_REACH || (nearest && nearest.distance <= distance)) continue;
        const outside = courtyardExterior(door);
        if (!outside) continue;
        if (inside) {
          if (Math.abs(position.y - door.inside.y) > .38 ||
              !finite(building.interior.navigation.sampleMove(door.inside.x, door.inside.z, position))) continue;
        } else if (!canReachCourtyardExterior(position, outside, distance)) continue;
        nearest = { building, door, outside, distance, inside };
      }
    }
    return nearest;
  }

  function getCourtyardDoor() {
    const candidate = reachableCourtyardDoor();
    if (!candidate) return null;
    const { building: { plotId }, door: { id: doorId, label }, distance, inside } = candidate;
    return { plotId, doorId, label, distance, inside };
  }

  function enterCourtyardAt(building, position, facing, exterior) {
    const nav = building.interior.navigation;
    player.setNavigation(nav, () => null);
    if (!player.place(position.x, position.z, facing, position.y)) {
      player.setNavigation(navigation, () => outdoorBounds);
      return false;
    }
    activeCourtyard = { building, exterior };
    outdoorOrbit = { distance, azimuth, elevation };
    mapView = false;
    view = 'player';
    distance = INTERIOR_PLAYER_DISTANCE;
    elevation = .38;
    azimuth = finite(facing) ? facing + Math.PI : .76;
    interiorCameraDistance = undefined;
    prepareInteriorCamera(building.model, true);
    fitAvatar();
    trackPlayer(true);
    return true;
  }

  function leaveCourtyardAt(position, facing) {
    const wasInside = Boolean(activeCourtyard);
    activeCourtyard = null;
    if (wasInside) {
      restoreOutdoorOrbit();
      interiorOccluders = [];
    }
    if (!navigation || !player?.position) return false;
    player.setNavigation(navigation, () => outdoorBounds);
    const point = (position && navigation.nearestWalkable(position.x, position.z, outdoorBounds, 24)) || navigation.spawn(outdoorBounds);
    const placed = !!point && player.place(point.x, point.z, facing, point.y);
    if (view === 'player') trackPlayer(true);
    return placed;
  }

  function interactCourtyardDoor(plotId, doorId) {
    const candidate = reachableCourtyardDoor();
    if (!candidate || candidate.building.plotId !== plotId || candidate.door.id !== doorId) return false;
    const { building, door, outside, inside } = candidate;
    // Split the shared facade geometry on demand. Only the placed clone is edited.
    if (!building.interior.setDoorProgress(door.id, .001)) return false;
    const start = player.position.clone();
    const points = inside ? [start, door.inside, door.threshold, outside] : [start, outside, door.threshold, door.inside];
    let length = 0;
    const segments = [];
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1], to = points[i];
      const step = from.distanceTo(to);
      if (step < .001) continue;
      segments.push({ from, to, length: step, end: length + step });
      length += step;
    }
    courtyardPassage = { building, door, outside, start, startFacing: player.facing, entering: !inside,
      elapsed: 0, duration: length / COURTYARD_DOOR_WALK_SPEED, segments, committed: false };
    player.setInput(0, 0);
    flagShadows();
    return true;
  }

  function updateCourtyardPassage(dt) {
    const passage = courtyardPassage;
    if (!passage) return false;
    if (!dt) return true;
    const { building, door, outside, start, startFacing, entering, duration, segments } = passage;
    const yaw = door.yaw + (entering ? 0 : Math.PI);
    const travel = (passage.elapsed += dt) - COURTYARD_DOOR_SWING_TIME;
    const closing = travel - duration;
    const progress = clamp(travel < 0 ? passage.elapsed / COURTYARD_DOOR_SWING_TIME :
      1 - Math.max(0, closing) / COURTYARD_DOOR_SWING_TIME, 0, 1);
    building.interior.setDoorProgress(door.id, progress * progress * (3 - 2 * progress));
    flagShadows();
    if (travel < 0) {
      player.updateTransport(dt, start.x, start.y, start.z, yaw);
    } else if (travel < duration) {
      const gone = travel * COURTYARD_DOOR_WALK_SPEED;
      const { from, to, length, end } = segments.find(segment => gone <= segment.end) || segments[segments.length - 1];
      const f = clamp(1 - (end - gone) / length, 0, 1);
      player.updateTransport(dt, from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f,
        from.z + (to.z - from.z) * f, Math.atan2(to.x - from.x, to.z - from.z), true);
    } else {
      if (!passage.committed) {
        if (entering) {
          if (!enterCourtyardAt(building, door.inside, yaw, outside)) leaveCourtyardAt(start, startFacing);
        } else leaveCourtyardAt(outside, yaw);
        passage.committed = true;
      }
      const { x, y, z } = player.position;
      player.updateTransport(dt, x, y, z, yaw);
    }
    if (closing >= COURTYARD_DOOR_SWING_TIME) {
      courtyardPassage = null;
      if (activeCourtyard) prepareInteriorCamera(activeCourtyard.building.model, true);
    }
    return true;
  }

  function getCourtyardCheckpoint() {
    const passage = courtyardPassage && !courtyardPassage.committed && courtyardPassage;
    if (!activeCourtyard && !courtyardPassage) return null;
    const point = passage ? passage.start : player?.position;
    if (!point) return null;
    const { x, y, z } = point;
    const facing = passage ? passage.startFacing : player.facing;
    if (!activeCourtyard) return { x, y, z, facing };
    const { building: { plotId }, exterior } = activeCourtyard;
    return { x, y, z, facing, interior: { kind: 'courtyard', plotId },
      ...(exterior ? { exterior: { x: exterior.x, y: exterior.y, z: exterior.z } } : {}) };
  }

  function restoreCourtyardPosition(saved) {
    const building = courtyards.get(saved.interior?.plotId);
    if (!building || !player?.position || ![saved.x, saved.y, saved.z, saved.facing].every(finite) ||
        !finite(building.interior.navigation.sample(saved.x, saved.z, null, saved.y))) return false;
    const exterior = building.doors.map(courtyardExterior).filter(Boolean).sort((a, b) => {
      const near = saved.exterior || saved;
      return Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z);
    })[0];
    return enterCourtyardAt(building, saved, saved.facing, exterior);
  }

  function enterInterior(model, metadata, saved) {
    if (disposed || buildOrbit || isInsideBuilding() || courtyardPassage || !villaAnchor || !villa ||
        !model?.isObject3D || model === landscape || model === villa) {
      throw new Error('无法进入别墅室内');
    }
    if (!player?.position || (!saved && !getVillaEntryState().nearDoor)) throw new Error('请先到达别墅门口再进入');
    if (model.parent && model.parent !== villaAnchor) throw new Error('别墅室内模型不可重复挂载');
    if (interior && interior !== model) throw new Error('已有别墅室内模型正在使用');
    if (metadata !== undefined) setVillaInteriorMetadata(metadata);
    const nextNavigation = buildInteriorNavigation(model);
    if (saved && (saved.interior?.kind !== 'red' || ![saved.x, saved.y, saved.z, saved.facing].every(finite))) return false;
    const spawn = saved ? { x: saved.x, y: saved.y, z: saved.z, yaw: saved.facing } : nextNavigation.spawn();
    if (!spawn) throw new Error('别墅内部没有可用的角色出生点');
    player.setNavigation(nextNavigation, () => null);
    if (!player.place(spawn.x, spawn.z, spawn.yaw, spawn.y)) {
      player.setNavigation(navigation, () => outdoorBounds);
      if (saved) return false;
      throw new Error('别墅内部出生点不可到达');
    }
    interior = model;
    interiorNavigation = nextNavigation;
    if (!interiorElevator) interiorElevator = createManorInteriorElevator(model, nextNavigation);
    interior.visible = true;
    model.traverse(mesh => {
      if (!mesh.isMesh) return;
      mesh.receiveShadow = true;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let moving = false;
      for (let part = mesh; part && part !== model; part = part.parent) {
        if (part.userData.elevatorRole === 'car' || part.userData.elevatorRole === 'door') { moving = true; break; }
      }
      mesh.castShadow = !moving && materials.every(material => !material.transparent);
    });
    villa.visible = false;
    if (interior.parent !== villaAnchor) villaAnchor.add(interior);
    flagShadows();
    prepareInteriorCamera(interior);
    outdoorOrbit = { distance, azimuth, elevation };
    interiorCameraDistance = undefined;
    insideVilla = true;
    mapView = false;
    view = 'player';
    if (player?.position) {
      distance = INTERIOR_PLAYER_DISTANCE;
      elevation = .38;
      azimuth = Number.isFinite(spawn?.yaw) ? spawn.yaw + (interiorOccluders.length ? -1.24 : Math.PI) : .76;
      fitAvatar();
      trackPlayer(true);
    }
    dirty = true;
    return true;
  }

  function exitInterior() {
    if (disposed || !insideVilla || interiorElevator?.busy) return false;
    const points = doorPoints();
    const ground = points && navigation?.sample(points.outside.x, points.outside.z, outdoorBounds);
    if (player?.position && (!points || !Number.isFinite(ground))) return false;
    player?.setInput(0, 0);
    if (player?.position) {
      player.setNavigation(navigation, () => outdoorBounds);
      const outwardYaw = Math.atan2(points.outside.x - points.entry.x, points.outside.z - points.entry.z);
      if (!player.place(points.outside.x, points.outside.z, outwardYaw, ground)) {
        player.setNavigation(interiorNavigation, () => null);
        return false;
      }
    }
    insideVilla = false;
    restoreOutdoorOrbit();
    if (interior) interior.visible = false;
    if (villa) villa.visible = true;
    flagShadows();
    if (view === 'player') trackPlayer(true);
    dirty = true;
    return true;
  }

  function getElevatorState() {
    return insideVilla ? interiorElevator?.state(player?.position) || null : null;
  }

  function useElevator() {
    return insideVilla && Boolean(interiorElevator?.start(player));
  }

  function fitAvatar() {
    const orbitElevation = Math.max(0, elevation);
    const sinEl = Math.sin(orbitElevation), cosEl = Math.cos(orbitElevation);
    const tanY = Math.tan(CAMERA_FOV * Math.PI / 360) * 0.9;
    const tanX = tanY * camera.aspect;
    const feet = -player.height * (isInsideBuilding() ? INTERIOR_TARGET_HEIGHT : PLAYER_TARGET_HEIGHT);
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
  }

  function pan(dx, dy) {
    if (disposed || !mapView || !finite(dx) || !finite(dy) || (!dx && !dy)) return;
    const scale = 2 * distance * Math.tan(camera.fov * Math.PI / 360) / height;
    const x = dx * scale;
    const z = dy * scale / Math.sin(Math.max(elevation, MIN_PAN_ELEVATION));
    const moveX = -x * Math.cos(azimuth) - z * Math.sin(azimuth);
    const moveZ = x * Math.sin(azimuth) - z * Math.cos(azimuth);
    target.x = clamp(target.x + moveX, -config.width / 2, config.width / 2);
    target.z = clamp(target.z + moveZ, -config.depth / 2, config.depth / 2);
    if (!buildOrbit) view = 'free';
    dirty = true;
  }

  function orbit(dx, dy) {
    if (disposed || !config || !finite(dx) || !finite(dy)) return;
    if (buildOrbit) return pan(dx, dy);
    const anglePerPixel = 3.5 / Math.max(150, height);
    azimuth = (azimuth - dx * anglePerPixel) % FULL_TURN;
    elevation = clamp(elevation + dy * anglePerPixel, MIN_ELEVATION, MAX_ELEVATION);
    if (view === 'player') fitAvatar();
    else view = 'free';
    dirty = true;
  }

  function zoom(factor) {
    if (disposed || !config || !finite(factor) || factor <= 0) return;
    if (view === 'player') {
      distance = clamp(distance / factor, PLAYER_ZOOM_MIN, PLAYER_ZOOM_MAX);
      fitAvatar();
    } else {
      distance = clamp(distance / factor, MIN_DISTANCE, maxDistance());
      if (!buildOrbit) view = 'free';
    }
    dirty = true;
  }

  function render(timeSeconds, deltaSeconds = 0) {
    if (disposed || !landscape) return;
    if (finite(timeSeconds)) clock.value = timeSeconds;
    const dt = finite(deltaSeconds) ? clamp(deltaSeconds, 0, 0.1) : 0;
    if (!updateCourtyardPassage(dt) && (!insideVilla || !interiorElevator?.update(dt))) player?.update(dt, azimuth);
    if (view === 'player' && dt > 0) trackPlayer(false, dt);
    if (communityView && dt > 0) {
      const fraction = 1 - Math.exp(-10 * dt);
      for (const node of sharedNodes.values()) {
        if (node.kind !== 'presence') continue;
        node.group.position.lerp(node.target, fraction);
        const difference = Math.atan2(Math.sin(node.targetYaw - node.group.rotation.y),
          Math.cos(node.targetYaw - node.group.rotation.y));
        node.group.rotation.y += difference * fraction;
      }
    }
    if (dirty) updateCamera(dt);
    renderer.render(scene, camera);
  }

  function updateCamera(dt) {
      camera.position.copy(target).addScaledVector(cameraDirection(), distance);
      const buildingNavigation = activeCourtyard?.building.interior.navigation || (insideVilla && interiorNavigation);
      const floor = buildingNavigation
        ? (buildingNavigation.sample(camera.position.x, camera.position.z, null, player?.position?.y) ?? player?.position?.y ?? config.ground)
        : (navigation.sample(camera.position.x, camera.position.z, outdoorBounds) ?? config.ground);
      camera.position.y = Math.max(camera.position.y, floor + CAMERA_GROUND_CLEARANCE);
      const releasingCamera = isInsideBuilding() && view === 'player' && interiorOccluders.length ? keepCameraInside(dt) : false;
      camera.lookAt(target);
      // Keep the orbit above ground while tilting the lens toward the sky.
      if (elevation < 0) {
        const floorPitch = Math.atan2(camera.position.y - target.y, distance);
        camera.rotateX(-elevation + floorPitch * elevation / MIN_ELEVATION);
      }
      camera.near = isInsideBuilding() ? 0.045 : clamp(distance / 125, 0.25, 25);
      camera.fov = isInsideBuilding() ? interiorCameraFov() : CAMERA_FOV;
      camera.updateProjectionMatrix();
      const fogOffset = Math.max(0, distance - 970);
      scene.fog.near = 1400 + fogOffset;
      scene.fog.far = 3700 + fogOffset;
      for (const tile of grass) {
        tile.mesh.visible = tile.sourceVisible && (!villaPlot || tile.plot !== villaPlot.id) && !buildings.occupied.has(tile.plot) &&
          camera.position.distanceToSquared(tile.center) <= tile.range2;
      }
      dirty = releasingCamera;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    releaseCourtyards();
    player?.dispose();
    player = null;
    buildings.dispose();
    removeVilla();
    clearCommunityView();
    if (landscape) disposeModel(landscape);
    landscape = config = plannedPlot = navigation = null;
    interior = interiorNavigation = interiorElevator = interiorMetadata = null;
    insideVilla = false;
    communitySignature = '';
    grass = [];
    scene.clear();
    sun.shadow.dispose();
  }

  return { resize, showLandscape, showCharacter, showVilla, setVillaInteriorMetadata, getVillaEntryState,
    enterInterior, exitInterior, getElevatorState, useElevator, setPlayerInput, pan, orbit, zoom,
    enterMapView, exitMapView, getMapPlayerPosition, getPlayerSyncState, placeCharacterAt,
    getPlayerCheckpoint, restorePlayerPosition,
    setSharedRecords, focusVilla, focusCharacter, render, dispose,
    getBuildPlots, setBuildModel, hasBuildModel: buildings.hasModel, setBuildPreview, pickBuildGround, setPlacedBuildings,
    getCourtyardDoor, interactCourtyardDoor,
    get isInsideCourtyard() { return Boolean(activeCourtyard) },
    get isCourtyardDoorBusy() { return Boolean(courtyardPassage) },
    get isInsideVilla() { return isInsideBuilding() } };
}

module.exports = { createManorScene };
