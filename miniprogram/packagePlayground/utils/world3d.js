const THREE = require('../libs/three/three')
const { loadModel } = require('./model-loader')
const { createNavigation } = require('./navigation')
const { PetBehavior } = require('./pet-behavior')

function disposeObject(root) {
  if (!root) return
  const geometries = new Set(); const materials = new Set(); const textures = new Set()
  root.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry)
    if (node.material) (Array.isArray(node.material) ? node.material : [node.material]).forEach((m) => materials.add(m))
  })
  materials.forEach((m) => {
    Object.keys(m).forEach((key) => { if (m[key] && m[key].isTexture) textures.add(m[key]) })
    m.dispose()
  })
  textures.forEach((t) => t.dispose())
  geometries.forEach((g) => g.dispose())
}

function grassTexture() {
  const size = 128
  const data = new Uint8Array(size * size * 3)
  let seed = 741
  for (let i = 0; i < size * size; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const n = (seed / 4294967296 - 0.5) * 22
    data[i * 3] = 123 + n
    data[i * 3 + 1] = 159 + n
    data[i * 3 + 2] = 85 + n
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBFormat)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(120, 90)
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

function normalizeModel(root, height) {
  root.updateMatrixWorld(true)
  let box = new THREE.Box3().setFromObject(root)
  root.scale.multiplyScalar(height / (box.max.y - box.min.y))
  root.updateMatrixWorld(true)
  box = new THREE.Box3().setFromObject(root)
  root.position.x -= (box.min.x + box.max.x) / 2
  root.position.z -= (box.min.z + box.max.z) / 2
  root.position.y -= box.min.y
  root.updateMatrixWorld(true)
}

function petLabel(pet) {
  return pet.name || (pet.species === 'cat' ? '猫咪' : '狗狗')
}

class World3D {
  constructor(page, onStatus, overview, onPetsChange) {
    this.page = page
    this.onStatus = onStatus
    this.overviewData = overview || {}
    this.onPetsChange = onPetsChange || (() => {})
    this.destroyed = false
    this.scene = new THREE.Scene()
    this.materials = new Map()
    this.target = new THREE.Vector3(0, 0.7, 0)
    this.yaw = 0.3
    this.pitch = 0.75
    this.distance = 45
    this.follow = true
    this.lastStatus = ''
    this.frame = null
    this.gesture = null
    this.pets = []
    this.selectedPetId = ''
  }

  async init() {
    const item = await new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this.page).select('#worldCanvas').fields({ node: true, size: true }).exec((res) => {
        if (!res[0] || !res[0].node) reject(new Error('无法获取全屏画布'))
        else resolve(res[0])
      })
    })
    if (this.destroyed) return this
    this.canvas = item.node
    this.canvas.addEventListener = this.canvas.addEventListener || (() => {})
    this.canvas.removeEventListener = this.canvas.removeEventListener || (() => {})
    this.canvas.style = this.canvas.style || {}
    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: true })
    if (!gl) throw new Error('当前设备没有可用的 WebGL 渲染环境')
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, context: gl, antialias: true })
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.renderer.setPixelRatio(Math.min(info.pixelRatio || 1, 2))
    this.renderer.outputEncoding = THREE.sRGBEncoding
    this.renderer.setClearColor(0xd7e7db, 1)
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 360)
    this.resize(item.width, item.height)
    this.scene.add(new THREE.HemisphereLight(0xfff9e9, 0x687e56, 0.85))
    const sun = new THREE.DirectionalLight(0xfff1d5, 1.1)
    sun.position.set(-6, 10, 5)
    this.scene.add(sun)
    this.scene.fog = new THREE.Fog(0xd7e7db, 210, 340)
    this.onStatus('加载庄园模型…')
    const house = await loadModel('house')
    if (this.destroyed) { disposeObject(house.scene); return this }
    this.house = house.scene
    this.scene.add(this.house)
    await this.buildWorld(house)
    this.updateCamera(1)
    this.start()
    return this
  }

  material(color) {
    if (!this.materials.has(color)) this.materials.set(color, new THREE.MeshLambertMaterial({ color }))
    return this.materials.get(color)
  }

  mesh(geometry, color, x, y, z) {
    const m = new THREE.Mesh(geometry, this.material(color))
    m.position.set(x, y, z)
    this.scene.add(m)
    return m
  }

  bowl(x, z, color, water) {
    const rim = this.mesh(new THREE.TorusBufferGeometry(0.62, 0.12, 10, 32), color, x, 0.32, z)
    rim.rotation.x = Math.PI / 2
    this.mesh(new THREE.CylinderBufferGeometry(0.66, 0.52, 0.26, 32), color, x, 0.15, z)
    this.mesh(new THREE.CylinderBufferGeometry(0.5, 0.5, 0.025, 32), water ? 0x70bad4 : 0x875329, x, 0.29, z)
    if (!water) for (let i = 0; i < 16; i += 1) {
      this.mesh(new THREE.IcosahedronBufferGeometry(0.075, 0), 0xa57040, x + Math.cos(i * 2.1) * 0.34, 0.38, z + Math.sin(i * 2.1) * 0.34)
    }
  }

  createStations(profiles, houseBox) {
    const stations = []
    const count = Math.max(1, profiles.length)
    const dining = new THREE.Mesh(new THREE.PlaneBufferGeometry(18, Math.max(10, count * 4.8 + 4)), this.material(0xd7c797))
    dining.rotation.x = -Math.PI / 2
    dining.position.set(30.5, 0.022, -10)
    this.scene.add(dining)
    for (let i = 0; i < count; i += 1) {
      const row = i - (count - 1) / 2
      const z = -10 + row * 4.6
      const restX = houseBox.max.x + 2 + (i % 3) * 2.2
      const restZ = houseBox.max.z + 2 + Math.floor(i / 3) * 2.2
      this.bowl(27.5, z, 0xcc895f, false)
      this.bowl(33.5, z, 0x93bec4, true)
      const mat = this.mesh(new THREE.CylinderBufferGeometry(1.05, 1.2, 0.08, 18), i % 2 ? 0xd8bea0 : 0xc9d6a9, restX, 0.04, restZ)
      mat.scale.set(1.4, 1, 0.82)
      stations.push({
        eat: { point: { x: 27.5, z: z + 1.48 }, bowl: { x: 27.5, z }, heading: Math.PI, owner: null },
        drink: { point: { x: 33.5, z: z + 1.48 }, bowl: { x: 33.5, z }, heading: Math.PI, owner: null },
        rest: { point: { x: restX, z: restZ }, heading: -Math.PI / 2, owner: null }
      })
    }
    return stations
  }

  async buildWorld(house) {
    const profiles = (this.overviewData.pets || []).filter((pet) => !pet.deletedAt).slice(0, 8)
    if (!profiles.length) throw new Error('请先添加宠物档案，再进入宠物乐园')
    const ground = new THREE.Mesh(new THREE.PlaneBufferGeometry(360, 290), new THREE.MeshLambertMaterial({ map: grassTexture(), color: 0xffffff }))
    ground.rotation.x = -Math.PI / 2
    this.scene.add(ground)
    normalizeModel(house.scene, 7.2)
    house.scene.position.x -= 7.5
    house.scene.position.z -= 8
    house.scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(house.scene)
    const obstacles = [{ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z }]
    const stone = new THREE.CylinderBufferGeometry(0.72, 0.82, 0.08, 8)
    for (let i = 0; i < 74; i += 1) {
      const p = this.mesh(stone, i % 2 ? 0xd8ccb1 : 0xc5bea4, 0.5 + Math.sin(i * 0.33) * 1.7, 0.035, -43 + i * 1.05)
      p.scale.set(1.25 + (i % 3) * 0.12, 1, 0.86); p.rotation.y = i * 0.7
    }
    for (let i = 0; i < 26; i += 1) {
      const p = this.mesh(stone, i % 2 ? 0xd4c49d : 0xc3b48e, 7 + i * 1.1, 0.035, -12.5 + Math.sin(i * 0.55) * 0.8)
      p.scale.set(1.15, 1, 0.78); p.rotation.y = 1.2 + i * 0.4
    }
    const stations = this.createStations(profiles, box)
    stations.forEach((station) => {
      obstacles.push({ minX: station.eat.bowl.x - 0.55, maxX: station.eat.bowl.x + 0.55, minZ: station.eat.bowl.z - 0.55, maxZ: station.eat.bowl.z + 0.55 })
      obstacles.push({ minX: station.drink.bowl.x - 0.55, maxX: station.drink.bowl.x + 0.55, minZ: station.drink.bowl.z - 0.55, maxZ: station.drink.bowl.z + 0.55 })
    })
    this.buildFenceAndPlants()
    this.navigation = createNavigation({ minX: -68, maxX: 68, minZ: -50, maxZ: 50 }, obstacles, 0.85, 1.5)
    this.onStatus('加载宠物模型…')
    for (let i = 0; i < profiles.length; i += 1) await this.createPet(profiles[i], i, stations[i])
    const first = this.pets.find((pet) => pet.available)
    if (first) {
      this.selectPet(first.petId)
      this.target.copy(this.petPosition(first)).add(new THREE.Vector3(0, 0.7, 0))
    } else {
      this.onStatus('当前宠物模型资源待接入')
    }
    this.emitPetList()
    this.distance = 20
  }

  buildFenceAndPlants() {
    const fencePost = new THREE.CylinderBufferGeometry(0.18, 0.22, 1.25, 8)
    const fenceRailX = new THREE.BoxBufferGeometry(8.2, 0.16, 0.16)
    const fenceRailZ = new THREE.BoxBufferGeometry(0.16, 0.16, 8.2)
    for (let x = -72; x <= 72; x += 8) {
      this.mesh(fencePost, 0xb58a5a, x, 0.62, -58)
      this.mesh(fencePost, 0xb58a5a, x, 0.62, 58)
      this.mesh(fenceRailX, 0xc69a66, x, 0.92, -58)
      this.mesh(fenceRailX, 0xc69a66, x, 0.92, 58)
    }
    for (let z = -50; z <= 50; z += 8) {
      this.mesh(fencePost, 0xb58a5a, -76, 0.62, z)
      this.mesh(fencePost, 0xb58a5a, 76, 0.62, z)
      this.mesh(fenceRailZ, 0xc69a66, -76, 0.92, z)
      this.mesh(fenceRailZ, 0xc69a66, 76, 0.92, z)
    }
    const shrub = new THREE.IcosahedronBufferGeometry(0.9, 1)
    ;[[-62, -46], [-44, -50], [-24, -47], [18, -50], [42, -46], [63, -42], [-64, 43], [-38, 48], [-8, 46], [24, 49], [55, 44], [-68, -20], [-70, 12], [69, -18], [70, 18]].forEach(([x, z], index) => {
      const m = this.mesh(shrub, index % 3 ? 0x648453 : 0x89a566, x, 0.38, z)
      m.scale.set(1.6, 0.85 + (index % 3) * 0.2, 1.25)
    })
    const treeTop = new THREE.IcosahedronBufferGeometry(1.55, 1)
    const treeTrunk = new THREE.CylinderBufferGeometry(0.22, 0.28, 1.75, 8)
    ;[[-52.5, -34], [51, -32], [-56, 32], [49, 36], [-29, 41], [34, 40.5], [-42, 6], [43, 9], [-14, -38], [18, -39], [-31, -22], [28, -28], [-36, 24], [36, 25], [-16, 31], [17, 30]].forEach(([x, z], index) => {
      this.mesh(treeTrunk, 0x8b5a32, x, 0.88, z)
      const top = this.mesh(treeTop, index % 2 ? 0x6f995f : 0x7ead69, x, 2.25, z)
      top.scale.set(1.05 + (index % 3) * 0.1, 1.28, 1.05)
    })
  }

  async createPet(profile, index, stations) {
    const petId = profile._id || `pet_${index}`
    const species = profile.species === 'cat' ? 'cat' : 'dog'
    const pet = { petId, name: petLabel(profile), species, available: false, profile, stationSet: stations }
    if (species === 'dog') {
      try {
        const dog = await loadModel('shiba')
        if (this.destroyed) { disposeObject(dog.scene); return }
        this.setupPetModel(pet, dog, index, 1.45)
      } catch (error) {
        console.warn('[world3d] 柴犬模型加载失败，使用占位宠物', error)
        this.setupPlaceholderPet(pet, index)
      }
    } else {
      try {
        const cat = await loadModel('cat')
        if (this.destroyed) { disposeObject(cat.scene); return }
        this.setupPetModel(pet, cat, index, 1.15)
      } catch (error) {
        console.warn('[world3d] 小猫云端模型加载失败，使用占位宠物', error)
        this.setupPlaceholderPet(pet, index)
      }
    }
    this.pets.push(pet)
  }

  setupPlaceholderPet(pet, index) {
    const starts = [{ x: -28, z: 22 }, { x: 18, z: 24 }, { x: -34, z: -18 }, { x: 42, z: -22 }, { x: -8, z: 34 }, { x: 36, z: 12 }, { x: -44, z: 8 }, { x: 12, z: -34 }]
    const start = starts[index % starts.length]
    pet.behavior = new PetBehavior(this.navigation, pet.stationSet, start)
    pet.behavior.remaining = 0
    pet.behavior.choose()
    pet.radius = pet.species === 'cat' ? 0.72 : 0.95
    pet.height = pet.species === 'cat' ? 1.15 : 1.45
    pet.available = true
    pet.placeholder = true
    pet.root = new THREE.Group()
    pet.placeholderRoot = this.createPetPlaceholder(pet, index)
    pet.root.add(pet.placeholderRoot)
    pet.selectionRing = new THREE.Mesh(new THREE.TorusBufferGeometry(1.08, 0.04, 8, 36), new THREE.MeshBasicMaterial({ color: 0xfff697 }))
    pet.selectionRing.rotation.x = Math.PI / 2
    pet.selectionRing.position.y = 0.08
    pet.selectionRing.visible = false
    pet.root.add(pet.selectionRing)
    pet.root.position.set(start.x, 0, start.z)
    pet.root.traverse((node) => { node.userData.petId = pet.petId })
    this.scene.add(pet.root)
  }

  createPetPlaceholder(pet, index) {
    const root = new THREE.Group()
    const palette = pet.species === 'cat'
      ? [0xf2c49b, 0xd9966b, 0xffffff, 0x6d4c41]
      : [0xd99a57, 0x8d5a35, 0xfff2d8, 0x4f3424]
    const accent = palette[index % 2]
    const dark = palette[3]
    const body = new THREE.Mesh(new THREE.SphereBufferGeometry(0.72, 24, 16), this.material(accent))
    body.position.set(0, 0.72, 0)
    body.scale.set(pet.species === 'cat' ? 1.18 : 1.35, pet.species === 'cat' ? 0.72 : 0.82, pet.species === 'cat' ? 0.68 : 0.78)
    root.add(body)
    const head = new THREE.Mesh(new THREE.SphereBufferGeometry(0.42, 24, 16), this.material(palette[2]))
    head.position.set(0, 1.2, 0.58)
    head.scale.set(1.05, 0.95, 0.95)
    root.add(head)
    const nose = new THREE.Mesh(new THREE.SphereBufferGeometry(0.08, 12, 8), this.material(dark))
    nose.position.set(0, 1.17, 0.96)
    root.add(nose)
    ;[-0.18, 0.18].forEach((x) => {
      const eye = new THREE.Mesh(new THREE.SphereBufferGeometry(0.045, 8, 6), this.material(0x1e2520))
      eye.position.set(x, 1.31, 0.91)
      root.add(eye)
    })
    ;[-0.28, 0.28].forEach((x) => {
      const ear = new THREE.Mesh(new THREE.ConeBufferGeometry(pet.species === 'cat' ? 0.18 : 0.2, pet.species === 'cat' ? 0.42 : 0.32, 12), this.material(accent))
      ear.position.set(x, pet.species === 'cat' ? 1.58 : 1.48, 0.45)
      ear.rotation.z = x < 0 ? 0.28 : -0.28
      root.add(ear)
    })
    ;[-0.42, 0.42].forEach((x) => {
      const leg = new THREE.Mesh(new THREE.CylinderBufferGeometry(0.12, 0.14, 0.58, 12), this.material(dark))
      leg.position.set(x, 0.3, pet.species === 'cat' ? 0.1 : 0.16)
      root.add(leg)
    })
    const tail = new THREE.Mesh(new THREE.CylinderBufferGeometry(0.07, 0.09, pet.species === 'cat' ? 0.95 : 0.72, 12), this.material(accent))
    tail.position.set(0, 0.92, -0.78)
    tail.rotation.x = pet.species === 'cat' ? 0.75 : 1.05
    root.add(tail)
    return root
  }

  setupPetModel(pet, gltf, index, height) {
    pet.root = new THREE.Group()
    normalizeModel(gltf.scene, height)
    pet.model = gltf.scene
    pet.restPose = 0
    pet.feedPose = 0
    pet.root.add(gltf.scene)
    this.scene.add(pet.root)
    pet.mixer = new THREE.AnimationMixer(gltf.scene)
    pet.actions = {}
    gltf.animations.forEach((clip) => { if (clip.tracks && clip.tracks.length) pet.actions[clip.name] = pet.mixer.clipAction(clip) })
    pet.idleActionName = pet.actions.Idle ? 'Idle' : Object.keys(pet.actions)[0] || ''
    pet.walkActionName = pet.actions.Walk ? 'Walk' : pet.idleActionName
    pet.runActionName = pet.actions.Gallop ? 'Gallop' : pet.walkActionName
    const starts = [{ x: -28, z: 22 }, { x: 18, z: 24 }, { x: -34, z: -18 }, { x: 42, z: -22 }, { x: -8, z: 34 }, { x: 36, z: 12 }, { x: -44, z: 8 }, { x: 12, z: -34 }]
    const start = starts[index % starts.length]
    pet.behavior = new PetBehavior(this.navigation, pet.stationSet, start)
    pet.behavior.remaining = 0
    pet.behavior.choose()
    pet.root.position.set(start.x, 0, start.z)
    pet.radius = pet.species === 'cat' ? 0.72 : 0.9
    pet.height = height
    pet.available = true
    pet.selectionRing = new THREE.Mesh(new THREE.TorusBufferGeometry(pet.species === 'cat' ? 0.88 : 1.08, 0.04, 8, 36), new THREE.MeshBasicMaterial({ color: 0xfff697 }))
    pet.selectionRing.rotation.x = Math.PI / 2
    pet.selectionRing.position.y = 0.08
    pet.selectionRing.visible = false
    pet.root.add(pet.selectionRing)
    pet.root.traverse((node) => { node.userData.petId = pet.petId })
    this.setAnimation(pet, pet.idleActionName)
  }

  petPosition(pet) {
    if (pet.root) return pet.root.position
    if (pet.behavior) return new THREE.Vector3(pet.behavior.position.x, 0, pet.behavior.position.z)
    return new THREE.Vector3()
  }

  emitPetList() {
    this.onPetsChange(this.pets.map((pet) => ({
      id: pet.petId,
      name: pet.name,
      species: pet.species,
      selected: pet.petId === this.selectedPetId,
      available: pet.available,
      status: pet.available ? '' : pet.status
    })))
  }

  selectedPet() { return this.pets.find((pet) => pet.petId === this.selectedPetId && pet.available) || this.pets.find((pet) => pet.available) }

  selectPet(petId) {
    const pet = this.pets.find((item) => item.petId === petId)
    if (!pet || !pet.available) return false
    this.selectedPetId = pet.petId
    this.follow = true
    this.pets.forEach((item) => { if (item.selectionRing) item.selectionRing.visible = item.petId === pet.petId })
    this.emitPetList()
    this.onStatus(`${pet.name} 已选中`)
    return true
  }

  setAnimation(pet, name) {
    const mapped = name === 'Eating' && !pet.actions.Eating ? 'Idle' : name === 'Sleep' && !pet.actions.Sleep ? 'Idle' : name
    if (pet.animation === mapped) return
    const next = pet.actions[mapped]
    if (!next) return
    next.reset().play()
    if (pet.animation && pet.actions[pet.animation]) { next.fadeIn(0.2); pet.actions[pet.animation].fadeOut(0.2) }
    pet.animation = mapped
  }

  resize(width, height) {
    if (!this.renderer) return
    this.width = width; this.height = height
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.maxDistance = Math.max(210, 160 / Math.tan(Math.atan(Math.tan(Math.PI / 8) * this.camera.aspect)))
  }

  overviewCameraBox() {
    const box = new THREE.Box3(new THREE.Vector3(-68, 0, -50), new THREE.Vector3(68, 0, 50))
    if (this.house) box.expandByObject(this.house)
    this.pets.forEach((pet) => { if (pet.available) box.expandByPoint(this.petPosition(pet)) })
    return box
  }

  overview() {
    this.follow = false
    const box = this.overviewCameraBox()
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    this.target.set(center.x, 0.8, center.z)
    this.yaw = 0.15; this.pitch = 1.05
    const radius = Math.max(size.x, size.z) * 0.52
    this.distance = Math.min(this.maxDistance, Math.max(95, radius / Math.tan(Math.PI / 8) * 0.72))
  }

  followPet(petId) {
    if (petId) this.selectPet(petId)
    const pet = this.selectedPet()
    if (!pet) return
    this.selectedPetId = pet.petId
    this.follow = true
    this.distance = 20
    this.pitch = 0.62
    this.emitPetList()
  }

  updateCamera(dt) {
    const pet = this.selectedPet()
    if (this.follow && pet) {
      const focus = this.petPosition(pet).clone().add(new THREE.Vector3(0, 0.7, 0))
      this.target.lerp(focus, 1 - Math.exp(-dt * 5))
    }
    const horizontal = this.distance * Math.cos(this.pitch)
    this.camera.position.set(this.target.x + Math.sin(this.yaw) * horizontal, this.target.y + Math.sin(this.pitch) * this.distance, this.target.z + Math.cos(this.yaw) * horizontal)
    this.camera.lookAt(this.target)
  }

  touchStart(touches) {
    const p = touches[0]
    if (!p) return
    this.gesture = { x: p.x, y: p.y, startX: p.x, startY: p.y, moved: false, two: touches.length > 1, distance: touches.length > 1 ? Math.hypot(p.x - touches[1].x, p.y - touches[1].y) : 0 }
  }

  touchMove(touches) {
    if (!this.gesture || !touches.length) return
    const g = this.gesture; const p = touches[0]
    if (touches.length > 1) {
      const distance = Math.hypot(p.x - touches[1].x, p.y - touches[1].y)
      if (g.distance > 0 && distance > 0) this.distance = Math.max(12, Math.min(this.maxDistance, this.distance * g.distance / distance))
      g.distance = distance; g.two = true; g.moved = true
    } else {
      this.yaw -= (p.x - g.x) * 0.008
      this.pitch = Math.max(0.25, Math.min(1.3, this.pitch + (p.y - g.y) * 0.005))
      if (Math.hypot(p.x - g.startX, p.y - g.startY) > 6) g.moved = true
    }
    g.x = p.x; g.y = p.y
  }

  touchEnd() {
    const g = this.gesture
    if (g && !g.moved && !g.two) {
      const ray = new THREE.Raycaster()
      ray.setFromCamera(new THREE.Vector2(g.x / this.width * 2 - 1, 1 - g.y / this.height * 2), this.camera)
      for (const pet of this.pets) {
        if (pet.available && pet.root && ray.intersectObject(pet.root, true).length) { this.followPet(pet.petId); break }
      }
    }
    this.gesture = null
  }

  request(action) {
    const pet = this.selectedPet()
    if (!pet) return false
    return pet.behavior.request(action === 'sleep' ? 'rest' : action)
  }

  resolvePetCollisions() {
    const live = this.pets.filter((pet) => pet.available)
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i]; const b = live[j]
        const dx = b.behavior.position.x - a.behavior.position.x
        const dz = b.behavior.position.z - a.behavior.position.z
        const distance = Math.max(0.0001, Math.hypot(dx, dz))
        const min = a.radius + b.radius
        if (distance < min) {
          const push = (min - distance) / 2
          const nx = dx / distance; const nz = dz / distance
          a.behavior.position.x -= nx * push; a.behavior.position.z -= nz * push
          b.behavior.position.x += nx * push; b.behavior.position.z += nz * push
        }
      }
    }
  }

  updatePets(dt) {
    this.pets.forEach((pet) => { if (pet.available) pet.behavior.update(dt) })
    this.resolvePetCollisions()
    this.pets.forEach((pet) => {
      if (!pet.available) return
      const b = pet.behavior
      const moving = b.moved > 0.0001
      const resting = !moving && b.phase === 'acting' && b.action === 'rest'
      if (pet.placeholder) {
        if (pet.root) {
          pet.root.position.set(b.position.x, 0, b.position.z)
          const diff = Math.atan2(Math.sin(b.heading - pet.root.rotation.y), Math.cos(b.heading - pet.root.rotation.y))
          pet.root.rotation.y += diff * Math.min(1, dt * 10)
          const bob = moving ? Math.sin(Date.now() * 0.018) * 0.08 : 0
          pet.root.scale.setScalar(resting ? 0.78 : 1)
          pet.root.position.y = resting ? 0.02 : bob
        }
        return
      }
      pet.root.position.set(b.position.x, 0, b.position.z)
      const diff = Math.atan2(Math.sin(b.heading - pet.root.rotation.y), Math.cos(b.heading - pet.root.rotation.y))
      pet.root.rotation.y += diff * Math.min(1, dt * 10)
      const animation = moving ? (b.action === 'run' ? pet.runActionName : pet.walkActionName) : ['eat', 'drink'].includes(b.action) && pet.actions.Eating ? 'Eating' : resting && pet.actions.Sleep ? 'Sleep' : pet.idleActionName
      this.setAnimation(pet, animation)
      const feeding = !moving && b.phase === 'acting' && ['eat', 'drink'].includes(b.action)
      const restTarget = resting && !pet.actions.Sleep ? 1 : 0
      const feedTarget = feeding ? 1 : 0
      pet.restPose += (restTarget - pet.restPose) * Math.min(1, dt * 5)
      pet.feedPose += (feedTarget - pet.feedPose) * Math.min(1, dt * 6)
      if (pet.model) {
        pet.model.rotation.x = 0.18 * pet.feedPose
        pet.model.rotation.z = -Math.PI / 2 * pet.restPose
        pet.model.position.y = 0.55 * pet.restPose - 0.03 * pet.feedPose
        pet.model.position.z = -0.24 * pet.feedPose
      }
      if (pet.actions[pet.animation]) pet.actions[pet.animation].timeScale = moving && dt > 0 ? (b.moved / dt) / (animation === 'Gallop' ? 2.4 : 1.2) : 1
      pet.mixer.update(dt)
    })
  }

  statusLabel() {
    const pet = this.selectedPet()
    if (!pet) return this.pets.some((item) => item.species === 'cat') ? '猫咪动作模型待接入，当前没有可控制模型' : '暂无可控制宠物'
    const b = pet.behavior
    const label = b.phase === 'moving' ? '正在走向目的地' : ({ eat: '正在碗边吃饭', drink: '正在碗边饮水', rest: '正在休息睡觉' }[b.action] || '正在观察庄园')
    return `${pet.name}${label}`
  }

  start() {
    let previous = Date.now()
    const tick = () => {
      if (this.destroyed) return
      try {
        const now = Date.now(); const dt = Math.min(0.05, (now - previous) / 1000)
        previous = now
        this.updatePets(dt)
        this.updateCamera(dt)
        this.renderer.render(this.scene, this.camera)
        const label = this.statusLabel()
        if (label !== this.lastStatus) { this.lastStatus = label; this.onStatus(label) }
        this.frame = this.canvas.requestAnimationFrame(tick)
      } catch (error) {
        this.onStatus(`渲染停止：${error.message || error.errMsg}`)
      }
    }
    tick()
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    if (this.frame !== null && this.canvas) this.canvas.cancelAnimationFrame(this.frame)
    this.pets.forEach((pet) => {
      if (pet.behavior) pet.behavior.release()
      if (pet.mixer) { pet.mixer.stopAllAction(); pet.mixer.uncacheRoot(pet.mixer.getRoot()) }
    })
    disposeObject(this.scene)
    if (this.renderer) this.renderer.dispose()
    this.onStatus = () => {}
    this.onPetsChange = () => {}
  }
}
module.exports = { World3D }
