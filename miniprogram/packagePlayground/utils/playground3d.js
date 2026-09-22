const THREE = require('../libs/three/three')

const PARK_RADIUS_X = 11.5
const PARK_RADIUS_Z = 8.6
const FOOD_POINT = new THREE.Vector3(-5.4, 0, -1.8)
const WATER_POINT = new THREE.Vector3(-4.1, 0, -1.8)
const PLAY_POINT = new THREE.Vector3(5.4, 0, 1.9)
const CAT_PLAY_POINT = new THREE.Vector3(4.4, 0, 3.7)
const REST_POINT = new THREE.Vector3(0, 0, 4.8)

function toVec3(position = {}) {
  return new THREE.Vector3(Number(position.x || 0), Number(position.y || 0), Number(position.z || 0))
}

function material(color) {
  return new THREE.MeshLambertMaterial({ color })
}

function disposeObject(root) {
  if (!root || typeof root.traverse !== 'function') return
  const geometries = new Set()
  const materials = new Set()
  const textures = new Set()
  root.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry)
    if (node.material) {
      ;(Array.isArray(node.material) ? node.material : [node.material]).forEach((item) => materials.add(item))
    }
  })
  materials.forEach((item) => {
    Object.keys(item).forEach((key) => {
      if (item[key] && item[key].isTexture) textures.add(item[key])
    })
    if (typeof item.dispose === 'function') item.dispose()
  })
  textures.forEach((item) => {
    if (typeof item.dispose === 'function') item.dispose()
  })
  geometries.forEach((item) => {
    if (typeof item.dispose === 'function') item.dispose()
  })
}

function makeSphere(scale, color, width = 24, height = 16) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, width, height), material(color))
  mesh.scale.set(scale.x, scale.y, scale.z)
  return mesh
}

function makeBox(size, color) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material(color))
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function makeCylinder(radiusTop, radiusBottom, height, color, segments = 24) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), material(color))
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function addPairEyes(root, x, y, z, spread = 0.14) {
  const eyeA = makeSphere({ x: 0.045, y: 0.06, z: 0.045 }, 0x2f241f, 12, 8)
  eyeA.position.set(x, y, z + spread)
  const eyeB = eyeA.clone()
  eyeB.position.z = z - spread
  const nose = makeSphere({ x: 0.045, y: 0.035, z: 0.04 }, 0x2f241f, 12, 8)
  nose.position.set(x + 0.12, y - 0.09, z)
  root.add(eyeA, eyeB, nose)
}

function createDogModel(name) {
  const root = new THREE.Group()
  root.name = name || 'dog'
  const fur = 0xd99a52
  const dark = 0x6e4428
  const cream = 0xf7d59b
  const body = makeSphere({ x: 0.92, y: 0.5, z: 0.46 }, fur)
  body.position.y = 0.62
  const chest = makeSphere({ x: 0.36, y: 0.3, z: 0.32 }, cream)
  chest.position.set(0.38, 0.62, 0)
  const head = makeSphere({ x: 0.46, y: 0.42, z: 0.4 }, fur)
  head.position.set(0.72, 1.06, 0)
  const snout = makeSphere({ x: 0.28, y: 0.18, z: 0.2 }, cream)
  snout.position.set(1.08, 1, 0)
  const earA = makeSphere({ x: 0.15, y: 0.33, z: 0.11 }, dark)
  earA.position.set(0.52, 1.22, 0.27)
  const earB = earA.clone()
  earB.position.z = -0.27
  const tail = makeSphere({ x: 0.14, y: 0.14, z: 0.54 }, dark)
  tail.position.set(-0.86, 0.82, 0)
  tail.rotation.z = Math.PI / 5
  root.add(body, chest, head, snout, earA, earB, tail)
  addPairEyes(root, 1.05, 1.13, 0, 0.14)
  ;[-0.42, 0.42].forEach((x) => {
    ;[-0.22, 0.22].forEach((z) => {
      const leg = makeSphere({ x: 0.13, y: 0.36, z: 0.13 }, dark)
      leg.position.set(x, 0.24, z)
      root.add(leg)
    })
  })
  root.userData.tail = tail
  root.userData.head = head
  return root
}

function createCatModel(name) {
  const root = new THREE.Group()
  root.name = name || 'cat'
  const fur = 0xbfc8d8
  const dark = 0x53627a
  const pink = 0xffb4bd
  const body = makeSphere({ x: 0.7, y: 0.44, z: 0.4 }, fur)
  body.position.y = 0.56
  const belly = makeSphere({ x: 0.34, y: 0.22, z: 0.28 }, 0xe9edf5)
  belly.position.set(0.25, 0.52, 0)
  const head = makeSphere({ x: 0.42, y: 0.38, z: 0.36 }, fur)
  head.position.set(0.55, 0.96, 0)
  const earGeom = new THREE.ConeGeometry(0.14, 0.38, 3)
  const earA = new THREE.Mesh(earGeom, material(dark))
  earA.position.set(0.43, 1.3, 0.23)
  earA.rotation.z = -0.2
  const earB = earA.clone()
  earB.position.z = -0.23
  const nose = makeSphere({ x: 0.04, y: 0.03, z: 0.04 }, pink, 12, 8)
  nose.position.set(0.91, 0.94, 0)
  const tail = makeSphere({ x: 0.11, y: 0.11, z: 0.68 }, dark)
  tail.position.set(-0.68, 0.78, 0)
  tail.rotation.y = Math.PI / 5
  root.add(body, belly, head, earA, earB, nose, tail)
  addPairEyes(root, 0.84, 1.03, 0, 0.12)
  ;[-0.28, 0.28].forEach((x) => {
    ;[-0.18, 0.18].forEach((z) => {
      const leg = makeSphere({ x: 0.09, y: 0.28, z: 0.09 }, dark)
      leg.position.set(x, 0.2, z)
      root.add(leg)
    })
  })
  root.userData.tail = tail
  root.userData.head = head
  return root
}

function createDogHouse(style) {
  const root = new THREE.Group()
  const baseColor = style === 'blue' ? 0x8bb8ff : style === 'cream' ? 0xf4dfb4 : style === 'forest' ? 0x96c87b : 0xc47a44
  const platform = makeBox({ x: 1.8, y: 0.18, z: 1.55 }, 0xe7c38d)
  platform.position.y = 0.09
  const base = makeBox({ x: 1.45, y: 0.95, z: 1.18 }, baseColor)
  base.position.y = 0.64
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.08, 0.62, 4), material(0x9f4c3a))
  roof.position.y = 1.38
  roof.rotation.y = Math.PI / 4
  const door = makeBox({ x: 0.45, y: 0.62, z: 0.07 }, 0x5c3a26)
  door.position.set(0.01, 0.44, 0.63)
  const trim = makeBox({ x: 1.62, y: 0.12, z: 0.12 }, 0xfff1d6)
  trim.position.set(0, 1.05, 0.64)
  const bone = makeBox({ x: 0.45, y: 0.09, z: 0.08 }, 0xfff7e8)
  bone.position.set(0, 1.08, 0.72)
  root.add(platform, base, roof, door, trim, bone)
  root.scale.setScalar(1.12)
  return root
}

function createCatNest(style) {
  const root = new THREE.Group()
  const color = style === 'pink' ? 0xffa9c8 : style === 'blue' ? 0xa9ceff : style === 'forest' ? 0x9bd18a : 0xf4d9a4
  const mat = material(color)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.64, 0.18, 12, 36), mat)
  ring.rotation.x = Math.PI / 2
  ring.position.set(-0.25, 0.2, 0)
  const cushion = makeSphere({ x: 0.5, y: 0.1, z: 0.5 }, 0xfff3dc)
  cushion.position.set(-0.25, 0.18, 0)
  const pole = makeCylinder(0.09, 0.09, 1.0, 0xb98a5e, 16)
  pole.position.set(0.55, 0.5, 0)
  const platform = makeCylinder(0.42, 0.42, 0.1, color, 24)
  platform.position.set(0.55, 1.02, 0)
  const topNest = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.1, 10, 24), mat)
  topNest.rotation.x = Math.PI / 2
  topNest.position.set(0.55, 1.13, 0)
  root.add(ring, cushion, pole, platform, topNest)
  root.scale.setScalar(1.08)
  return root
}

function createTree(x, z, scale = 1) {
  const root = new THREE.Group()
  const trunk = makeBox({ x: 0.24, y: 0.95, z: 0.24 }, 0x9b6a42)
  trunk.position.y = 0.47
  const crown = makeSphere({ x: 0.7, y: 0.7, z: 0.7 }, 0x72c47a)
  crown.position.y = 1.18
  const crown2 = makeSphere({ x: 0.46, y: 0.46, z: 0.46 }, 0x8bdc88)
  crown2.position.set(0.28, 1.52, -0.16)
  root.add(trunk, crown, crown2)
  root.position.set(x, 0, z)
  root.scale.setScalar(scale)
  return root
}

function createFlowerPatch(x, z, color) {
  const root = new THREE.Group()
  const soil = makeCylinder(0.55, 0.62, 0.08, 0x9b6a42, 24)
  soil.position.y = 0.04
  root.add(soil)
  ;[-0.28, 0, 0.28].forEach((dx, index) => {
    const flower = makeSphere({ x: 0.11, y: 0.11, z: 0.11 }, index % 2 ? 0xffd45f : color, 12, 8)
    flower.position.set(dx, 0.18, index === 1 ? 0.16 : -0.08)
    root.add(flower)
  })
  root.position.set(x, 0, z)
  return root
}

function createPath(start, end, width = 0.56) {
  const mid = start.clone().add(end).multiplyScalar(0.5)
  const length = start.distanceTo(end)
  const path = makeBox({ x: width, y: 0.035, z: length }, 0xf4d79d)
  path.position.set(mid.x, 0.025, mid.z)
  path.rotation.y = Math.atan2(end.x - start.x, end.z - start.z)
  return path
}

function createFence() {
  const root = new THREE.Group()
  const postColor = 0xd6a45f
  const railColor = 0xf0c27b
  for (let i = 0; i < 18; i += 1) {
    const t = (i / 18) * Math.PI * 2
    const x = Math.cos(t) * PARK_RADIUS_X
    const z = Math.sin(t) * PARK_RADIUS_Z
    const post = makeBox({ x: 0.18, y: 0.62, z: 0.18 }, postColor)
    post.position.set(x, 0.31, z)
    post.rotation.y = -t
    root.add(post)
  }
  for (let i = 0; i < 18; i += 1) {
    const t = ((i + 0.5) / 18) * Math.PI * 2
    const rail = makeBox({ x: 1.05, y: 0.12, z: 0.12 }, railColor)
    rail.position.set(Math.cos(t) * PARK_RADIUS_X, 0.42, Math.sin(t) * PARK_RADIUS_Z)
    rail.rotation.y = -t
    root.add(rail)
  }
  return root
}

function createDiningStation() {
  const root = new THREE.Group()
  const mat = makeBox({ x: 3.3, y: 0.04, z: 1.75 }, 0xffe0b9)
  mat.position.set(-4.7, 0.03, -1.9)
  const shadeA = makeBox({ x: 0.12, y: 1.15, z: 0.12 }, 0xb9834a)
  shadeA.position.set(-6.25, 0.58, -2.55)
  const shadeB = shadeA.clone()
  shadeB.position.x = -3.15
  const roof = makeBox({ x: 3.45, y: 0.12, z: 1.85 }, 0xffc66d)
  roof.position.set(-4.7, 1.24, -2.0)
  root.add(mat, shadeA, shadeB, roof)

  const foodBowl = makeCylinder(0.34, 0.45, 0.18, 0xff8f65, 24)
  foodBowl.position.copy(FOOD_POINT).add(new THREE.Vector3(0, 0.09, 0))
  const food = makeSphere({ x: 0.25, y: 0.07, z: 0.25 }, 0x8b5a2b, 16, 8)
  food.position.copy(FOOD_POINT).add(new THREE.Vector3(0, 0.22, 0))
  const waterBowl = makeCylinder(0.34, 0.45, 0.18, 0x6bb7ff, 24)
  waterBowl.position.copy(WATER_POINT).add(new THREE.Vector3(0, 0.09, 0))
  const water = makeSphere({ x: 0.26, y: 0.04, z: 0.26 }, 0x9be6ff, 16, 8)
  water.position.copy(WATER_POINT).add(new THREE.Vector3(0, 0.2, 0))
  root.add(foodBowl, food, waterBowl, water)
  return root
}

function createPlayZone() {
  const root = new THREE.Group()
  const mat = makeBox({ x: 3.8, y: 0.04, z: 2.6 }, 0xd7f3b6)
  mat.position.set(5.1, 0.035, 2.5)
  const ball = makeSphere({ x: 0.32, y: 0.32, z: 0.32 }, 0xff6b6b, 18, 12)
  ball.position.copy(PLAY_POINT).add(new THREE.Vector3(0.25, 0.32, -0.35))
  const tunnel = makeCylinder(0.52, 0.52, 1.4, 0x8fc8ff, 24)
  tunnel.rotation.z = Math.PI / 2
  tunnel.position.set(5.9, 0.52, 3.25)
  const scratchPole = makeCylinder(0.12, 0.12, 1.05, 0xb98a5e, 16)
  scratchPole.position.copy(CAT_PLAY_POINT).add(new THREE.Vector3(-0.4, 0.52, -0.35))
  const platform = makeCylinder(0.42, 0.42, 0.1, 0xffd58a, 24)
  platform.position.set(4, 1.05, 3.35)
  const bone = makeBox({ x: 0.7, y: 0.12, z: 0.14 }, 0xfff4d8)
  bone.position.set(4.55, 0.16, 1.45)
  root.add(mat, ball, tunnel, scratchPole, platform, bone)
  return root
}

function createMainHouse() {
  const house = new THREE.Group()
  const base = makeBox({ x: 3.4, y: 1.65, z: 2.1 }, 0xffd7a1)
  base.position.y = 0.82
  const wingA = makeBox({ x: 1.2, y: 1.1, z: 1.6 }, 0xffe4bb)
  wingA.position.set(-2.2, 0.55, 0.18)
  const wingB = wingA.clone()
  wingB.position.x = 2.2
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.25, 0.9, 4), material(0xf08a71))
  roof.position.y = 2.05
  roof.rotation.y = Math.PI / 4
  const door = makeBox({ x: 0.58, y: 0.92, z: 0.08 }, 0x7a4d2a)
  door.position.set(0, 0.5, 1.1)
  const sign = makeBox({ x: 1.35, y: 0.28, z: 0.08 }, 0xfff2d0)
  sign.position.set(0, 1.36, 1.14)
  const step = makeBox({ x: 1.3, y: 0.16, z: 0.55 }, 0xd9b17e)
  step.position.set(0, 0.08, 1.42)
  ;[-0.95, 0.95].forEach((x) => {
    const win = makeBox({ x: 0.42, y: 0.42, z: 0.08 }, 0xaee6ff)
    win.position.set(x, 0.92, 1.12)
    house.add(win)
  })
  house.add(base, wingA, wingB, roof, door, sign, step)
  house.position.set(0, 0, -6.25)
  return house
}

function createLabelSprite() {
  return null
}

function getPixelRatio() {
  if (wx.getWindowInfo) return wx.getWindowInfo().pixelRatio || 1
  if (wx.getSystemInfoSync) return wx.getSystemInfoSync().pixelRatio || 1
  return 1
}

function patchMiniProgramWebGL(gl) {
  return gl
}

function clampParkTarget(vec) {
  const x = Math.max(-8.8, Math.min(8.8, vec.x))
  const z = Math.max(-6.2, Math.min(5.8, vec.z))
  return new THREE.Vector3(x, 0, z)
}

class Playground3D {
  constructor(page, selector, overview) {
    this.page = page
    this.selector = selector
    this.overview = overview || {}
    this.petStates = []
    this.animationId = null
    this.destroyed = false
    this.clockStart = Date.now()
  }

  init() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this.page).select(this.selector).fields({ node: true, size: true }).exec((res) => {
        const item = res && res[0]
        if (!item || !item.node) {
          reject(new Error('3D 画布初始化失败'))
          return
        }
        try {
          this.canvas = item.node
          this.width = item.width || 320
          this.height = item.height || 520
          this.setupRenderer()
          this.createScene()
          this.start()
          resolve(this)
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  setupRenderer() {
    const canvas = this.canvas
    const pixelRatio = getPixelRatio()
    canvas.width = this.width * pixelRatio
    canvas.height = this.height * pixelRatio
    if (!canvas.addEventListener) canvas.addEventListener = () => {}
    if (!canvas.removeEventListener) canvas.removeEventListener = () => {}
    if (!canvas.style) canvas.style = {}
    const contextOptions = { alpha: true, antialias: true, preserveDrawingBuffer: true }
    const gl = patchMiniProgramWebGL(canvas.getContext('webgl', contextOptions))
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true, webglVersion: 1 })
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(this.width, this.height, false)
    this.renderer.setClearColor(0xbfe9ff, 1)
  }

  createScene() {
    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0xbfe9ff, 16, 42)
    this.camera = new THREE.PerspectiveCamera(38, this.width / this.height, 0.1, 90)
    this.camera.position.set(0, 12.8, 15.8)
    this.camera.lookAt(0, 0, -0.8)

    const hemi = new THREE.HemisphereLight(0xffffff, 0x91c982, 1.35)
    const sun = new THREE.DirectionalLight(0xffffff, 1.25)
    sun.position.set(7, 12, 8)
    this.scene.add(hemi, sun)

    const grass = new THREE.Mesh(new THREE.CircleGeometry(1, 96), material(0x8add78))
    grass.scale.set(PARK_RADIUS_X, PARK_RADIUS_Z, 1)
    grass.rotation.x = -Math.PI / 2
    grass.receiveShadow = true
    this.scene.add(grass)

    const innerGrass = new THREE.Mesh(new THREE.CircleGeometry(1, 72), material(0x9ee68a))
    innerGrass.scale.set(7.8, 5.1, 1)
    innerGrass.rotation.x = -Math.PI / 2
    innerGrass.position.y = 0.012
    this.scene.add(innerGrass)

    this.scene.add(
      createPath(new THREE.Vector3(0, 0, -5.2), new THREE.Vector3(0, 0, 4.8), 0.68),
      createPath(new THREE.Vector3(-0.2, 0, -1.4), FOOD_POINT, 0.58),
      createPath(new THREE.Vector3(0.4, 0, 0.6), PLAY_POINT, 0.58),
      createFence(),
      createMainHouse(),
      createDiningStation(),
      createPlayZone()
    )

    this.scene.add(
      createTree(-9.2, -5.5, 1.2), createTree(9.1, -4.8, 1.05), createTree(-8.8, 5.1, 1.05), createTree(8.6, 5.4, 1.15),
      createTree(-6.5, 6.4, 0.72), createTree(6.3, -6.7, 0.74),
      createFlowerPatch(-7.1, -1.2, 0xff9ac1), createFlowerPatch(7.2, -1.1, 0xff9ac1),
      createFlowerPatch(-2.6, 5.9, 0xb68cff), createFlowerPatch(2.4, 5.8, 0xb68cff)
    )

    this.createHomesAndPets()
  }

  createHomesAndPets() {
    const pets = this.overview.pets || []
    const homeMap = {}
    ;(this.overview.homes || []).forEach((home) => { homeMap[home.petId] = home })
    const entityMap = {}
    ;(this.overview.entities || []).forEach((entity) => { entityMap[entity.petId] = entity })

    pets.forEach((pet, index) => {
      const home = homeMap[pet._id] || {}
      const entity = entityMap[pet._id] || {}
      const homeObj = pet.species === 'cat' ? createCatNest(home.style) : createDogHouse(home.style)
      const homePos = this.getHomePosition(home.position, index)
      homeObj.position.copy(homePos)
      homeObj.rotation.y = homePos.x > 0 ? -0.45 : 0.45
      this.scene.add(homeObj)

      const model = pet.species === 'cat' ? createCatModel(pet.name) : createDogModel(pet.name)
      const modelPos = this.getEntityPosition(entity.position, index)
      model.position.copy(modelPos)
      model.scale.setScalar(Number(entity.scale || (pet.species === 'cat' ? 0.9 : 1)))
      this.scene.add(model)

      const label = createLabelSprite(pet.name)
      if (label) {
        label.position.set(0, 1.75, 0)
        model.add(label)
      }

      this.petStates.push({
        pet,
        model,
        homePosition: homePos.clone(),
        target: model.position.clone(),
        action: 'idle',
        activityPoint: '',
        nextActionAt: Date.now() + 900 + index * 750 + Math.random() * 1800,
        speed: pet.species === 'dog' ? 0.038 : 0.024,
        bobSeed: Math.random() * Math.PI * 2,
        hunger: 35 + Math.random() * 35,
        thirst: 30 + Math.random() * 40,
        energy: 50 + Math.random() * 35
      })
    })
  }

  getHomePosition(position, index) {
    const current = toVec3(position)
    if (Math.abs(current.x) + Math.abs(current.z) > 7) return clampParkTarget(current)
    const angle = (index / Math.max(4, (this.overview.pets || []).length)) * Math.PI * 2 + 0.5
    return new THREE.Vector3(Math.cos(angle) * 7.8, 0, Math.sin(angle) * 5.4 + 0.4)
  }

  getEntityPosition(position, index) {
    const current = toVec3(position)
    if (Math.abs(current.x) + Math.abs(current.z) > 4.8) return clampParkTarget(current)
    const angle = (index / Math.max(4, (this.overview.pets || []).length)) * Math.PI * 2 + 1.1
    return new THREE.Vector3(Math.cos(angle) * 4.6, 0, Math.sin(angle) * 3.4 + 0.2)
  }

  randomExploreTarget(state) {
    const angle = Math.random() * Math.PI * 2
    const radiusX = 2.4 + Math.random() * 5.8
    const radiusZ = 1.8 + Math.random() * 3.9
    const base = state.pet.species === 'cat' && Math.random() > 0.55 ? CAT_PLAY_POINT : new THREE.Vector3(0, 0, 0)
    return clampParkTarget(new THREE.Vector3(base.x + Math.cos(angle) * radiusX, 0, base.z + Math.sin(angle) * radiusZ))
  }

  chooseAction(state) {
    state.hunger = Math.min(100, state.hunger + 8 + Math.random() * 10)
    state.thirst = Math.min(100, state.thirst + 10 + Math.random() * 10)
    state.energy = Math.max(0, Math.min(100, state.energy + (state.action === 'rest' || state.action === 'go_home' ? 22 : -8)))

    if (state.thirst > 72) {
      state.action = 'drink'
      state.activityPoint = 'water'
      state.target = WATER_POINT.clone().add(new THREE.Vector3(Math.random() * 0.25, 0, Math.random() * 0.25))
    } else if (state.hunger > 76) {
      state.action = 'eat'
      state.activityPoint = 'food'
      state.target = FOOD_POINT.clone().add(new THREE.Vector3(Math.random() * 0.25, 0, Math.random() * 0.25))
    } else if (state.energy < 28) {
      state.action = Math.random() > 0.45 ? 'go_home' : 'rest'
      state.activityPoint = 'home'
      state.target = state.homePosition.clone().add(new THREE.Vector3(0.45, 0, 0.35))
    } else if (state.pet.species === 'dog' && Math.random() > 0.45) {
      state.action = Math.random() > 0.45 ? 'run' : 'play'
      state.activityPoint = 'play'
      state.target = PLAY_POINT.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.5, 0, (Math.random() - 0.5) * 1.1))
    } else if (state.pet.species === 'cat' && Math.random() > 0.55) {
      state.action = Math.random() > 0.5 ? 'play' : 'explore'
      state.activityPoint = 'cat_play'
      state.target = CAT_PLAY_POINT.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.6, 0, (Math.random() - 0.5) * 1.3))
    } else {
      state.action = Math.random() > 0.72 ? 'idle' : 'explore'
      state.activityPoint = 'garden'
      state.target = state.action === 'idle' ? state.model.position.clone() : this.randomExploreTarget(state)
    }

    const duration = state.action === 'eat' || state.action === 'drink' ? 5200 : state.action === 'run' ? 3200 : 3800 + Math.random() * 5200
    state.nextActionAt = Date.now() + duration
  }

  updatePets() {
    const now = Date.now()
    this.petStates.forEach((state) => {
      if (now >= state.nextActionAt) this.chooseAction(state)
      const model = state.model
      const delta = state.target.clone().sub(model.position)
      delta.y = 0
      const distance = delta.length()
      if (distance > 0.05) {
        delta.normalize()
        const speed = state.action === 'run' ? state.speed * 2.2 : state.action === 'play' ? state.speed * 1.45 : state.speed
        model.position.add(delta.multiplyScalar(speed))
        model.rotation.y = Math.atan2(delta.x, delta.z)
      } else if (state.action === 'eat') {
        state.hunger = Math.max(0, state.hunger - 0.55)
        model.rotation.y = -Math.PI / 2
      } else if (state.action === 'drink') {
        state.thirst = Math.max(0, state.thirst - 0.65)
        model.rotation.y = -Math.PI / 2
      } else if (state.action === 'rest' || state.action === 'go_home') {
        state.energy = Math.min(100, state.energy + 0.22)
      }

      const moving = distance > 0.05
      const eating = state.action === 'eat' || state.action === 'drink'
      const resting = state.action === 'rest' || state.action === 'go_home'
      const bob = Math.sin(now / 200 + state.bobSeed) * (moving ? 0.04 : eating ? 0.018 : 0.01)
      model.position.y = resting && !moving ? 0.02 : Math.max(0, bob)
      model.rotation.z = resting && !moving ? 0.08 : Math.sin(now / 360 + state.bobSeed) * (moving ? 0.035 : 0.012)
      model.rotation.x = eating && !moving ? 0.16 + Math.sin(now / 180 + state.bobSeed) * 0.04 : 0
      if (model.userData.tail) model.userData.tail.rotation.x = Math.sin(now / 220 + state.bobSeed) * (moving ? 0.45 : 0.18)
      if (model.userData.head) model.userData.head.rotation.z = eating && !moving ? -0.18 : 0
    })
  }

  start() {
    const tick = () => {
      if (this.destroyed) return
      this.updatePets()
      this.renderer.render(this.scene, this.camera)
      const raf = this.canvas.requestAnimationFrame || ((fn) => setTimeout(fn, 16))
      this.animationId = raf.call(this.canvas, tick)
    }
    tick()
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    if (this.animationId) {
      const caf = this.canvas && this.canvas.cancelAnimationFrame
      if (caf) caf.call(this.canvas, this.animationId)
      else clearTimeout(this.animationId)
      this.animationId = null
    }
    disposeObject(this.scene)
    if (this.renderer) this.renderer.dispose()
    this.scene = null
    this.renderer = null
    this.canvas = null
    this.petStates = []
  }
}

function createPlayground3D(page, selector, overview) {
  const playground = new Playground3D(page, selector, overview)
  return playground.init()
}

module.exports = { createPlayground3D }
