const DEAD_ZONE = 0.14
const RUN_ENTER = 0.78
const RUN_EXIT = 0.67
const WALK_MAX_TILT = (RUN_ENTER + RUN_EXIT) / 2
const WALK_SPEED = 1.7
const RUN_SPEED = 6.4
const MAX_STEP = 0.24
const MAX_RISE = 0.33
const ANIMATIONS = ['idle', 'walk', 'run']
const TAU = Math.PI * 2

function createManorPlayer({ THREE, scene, navigation, getVillaBounds, disposeModel }) {
  const anchor = new THREE.Group()
  anchor.name = 'Manor player'
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: 'varying vec2 vShadowUv; void main() { vShadowUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec2 vShadowUv; void main() { float a = 1.0 - smoothstep(0.04, 0.5, length(vShadowUv - 0.5)); gl_FragColor = vec4(0.08, 0.12, 0.09, a * 0.27); }'
  }))
  shadow.name = 'Player contact shadow'
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.025
  anchor.add(shadow)

  let current = null
  let currentNavigation = navigation
  let currentGetVillaBounds = getVillaBounds
  let inputX = 0, inputY = 0, inputMagnitude = 0, running = false
  let playerHeight = 1.6
  let playerRadius = .4

  function removeCharacter() {
    if (!current) return
    const { model, mixer } = current
    mixer.stopAllAction()
    mixer.uncacheRoot(model)
    anchor.remove(model)
    disposeModel(model)
    current = null
  }

  function spawn(yaw) {
    const point = currentNavigation.spawn(currentGetVillaBounds())
    if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) return false
    anchor.position.set(point.x, point.y, point.z)
    if (Number.isFinite(yaw)) anchor.rotation.y = yaw
    return true
  }

  function show(model, yaw) {
    if (model === current?.model) return
    if (!model?.isObject3D || model.parent) throw new Error('角色模型不可用')
    const clips = ANIMATIONS.map(name => model.animations?.find(clip =>
      typeof clip?.name === 'string' && clip.name.toLowerCase() === name && clip.duration > 0 && clip.tracks.length))
    if (clips.some(clip => !clip)) throw new Error('角色缺少待机、行走或奔跑动画')

    // Resolve the entire rig first. Computing individual mesh bounds before the
    // bones have valid world matrices gives the wrong foot height on these GLBs.
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model)
    const height = bounds.max.y - bounds.min.y
    const radius = Math.hypot(
      Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
      Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z))
    )
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(radius)) throw new Error('角色模型尺寸有误')
    if (!current && !spawn(yaw)) throw new Error('找不到角色出生点')

    const mixer = new THREE.AnimationMixer(model)
    const actions = clips.map((clip, i) => mixer.clipAction(clip).setEffectiveWeight(i === 0 ? 1 : 0).play())
    model.traverse(mesh => {
      // Their skinned bounds describe one pose. Keep limbs from disappearing
      // along the edge of the viewport during a stride.
      if (mesh.isSkinnedMesh) mesh.frustumCulled = false
    })
    model.position.y -= bounds.min.y
    mixer.update(0)
    removeCharacter()
    playerHeight = height
    playerRadius = radius
    current = { model, mixer, actions, active: 0, blend: null }
    anchor.add(model)
    if (!anchor.parent) scene.add(anchor)
  }

  function setInput(x, y) {
    inputX = Number.isFinite(x) ? x : 0
    inputY = Number.isFinite(y) ? y : 0
    inputMagnitude = Math.hypot(inputX, inputY)
    running = running ? inputMagnitude > RUN_EXIT : inputMagnitude >= RUN_ENTER
  }

  function setNavigation(nextNavigation, nextGetVillaBounds) {
    if (!nextNavigation || typeof nextNavigation.sample !== 'function' || typeof nextNavigation.spawn !== 'function') {
      throw new Error('角色导航不可用')
    }
    currentNavigation = nextNavigation
    if (typeof nextGetVillaBounds === 'function') currentGetVillaBounds = nextGetVillaBounds
    setInput(0, 0)
  }

  function place(x, z, yaw, preferredY) {
    if (!current || !Number.isFinite(x) || !Number.isFinite(z)) return false
    const y = currentNavigation.sample(x, z, currentGetVillaBounds(), preferredY)
    if (!Number.isFinite(y)) return false
    anchor.position.set(x, y, z)
    if (Number.isFinite(yaw)) anchor.rotation.y = yaw
    setInput(0, 0)
    return true
  }

  function avoidVilla() {
    if (!current || Number.isFinite(currentNavigation.sample(anchor.position.x, anchor.position.z, currentGetVillaBounds(), anchor.position.y))) return false
    return spawn()
  }

  function move(dx, dz) {
    const p = anchor.position
    const bounds = currentGetVillaBounds()
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / MAX_STEP))
    const moveTo = (x, z) => {
      const y = currentNavigation.sampleMove
        ? currentNavigation.sampleMove(x, z, p)
        : currentNavigation.sample(x, z, bounds, p.y)
      if (!Number.isFinite(y) || y - p.y > MAX_RISE) return false
      p.set(x, y, z)
      return true
    }
    dx /= steps
    dz /= steps
    for (let i = 0; i < steps; i++) {
      if (moveTo(p.x + dx, p.z + dz)) continue
      // Keep the component along a bank or wall when a diagonal step is blocked.
      if (dx) moveTo(p.x + dx, p.z)
      if (dz) moveTo(p.x, p.z + dz)
    }
  }

  function animate(index, speed, dt) {
    const { actions, mixer } = current
    if (index !== current.active) {
      const previous = actions[current.active]
      const next = actions[index]
      if (index && current.active) next.time = (previous.time / previous.getClip().duration) * next.getClip().duration
      else if (next.weight < .01) next.time = 0
      current.blend = { elapsed: 0, from: actions.map(action => action.weight) }
      current.active = index
    }
    if (current.blend) {
      current.blend.elapsed += dt
      const fraction = Math.min(1, current.blend.elapsed / .18)
      actions.forEach((action, i) => action.setEffectiveWeight(
        current.blend.from[i] * (1 - fraction) + (i === index ? fraction : 0)))
      if (fraction === 1) current.blend = null
    }
    if (index === 1) actions[index].setEffectiveTimeScale(.62 + speed * .38)
    if (index === 2) actions[index].setEffectiveTimeScale(.7 + speed * .6)
    mixer.update(dt)
  }

  function face(yaw, dt) {
    const angle = yaw - anchor.rotation.y
    const shortestTurn = Math.atan2(Math.sin(angle), Math.cos(angle))
    anchor.rotation.y = (anchor.rotation.y + shortestTurn * (1 - Math.exp(-18 * dt))) % TAU
  }

  function updateTransport(dt, x, y, z, yaw, walking = false) {
    if (!current) return
    anchor.position.set(x, y, z)
    if (Number.isFinite(yaw)) face(yaw, dt)
    animate(walking ? 1 : 0, 1, dt)
  }

  function update(dt, azimuth) {
    if (!current || !(dt > 0)) return
    let gait = 0, animationEffort = 0
    if (inputMagnitude > DEAD_ZONE) {
      const tilt = Math.min(inputMagnitude, 1)
      const walkEffort = Math.min(1, (tilt - DEAD_ZONE) / (WALK_MAX_TILT - DEAD_ZONE))
      const runEffort = Math.max(0, (tilt - WALK_MAX_TILT) / (1 - WALK_MAX_TILT))
      const speed = WALK_SPEED * walkEffort + (RUN_SPEED - WALK_SPEED) * runEffort
      const amount = speed * dt / inputMagnitude
      const sin = Math.sin(azimuth), cos = Math.cos(azimuth)
      const x = anchor.position.x, z = anchor.position.z
      move((inputX * cos + inputY * sin) * amount, (-inputX * sin + inputY * cos) * amount)
      const dx = anchor.position.x - x, dz = anchor.position.z - z
      if (Math.hypot(dx, dz) > .0001) {
        gait = running ? 2 : 1
        animationEffort = running ? runEffort : walkEffort
        face(Math.atan2(dx, dz), dt)
      }
    }
    animate(gait, animationEffort, dt)
  }

  function dispose() {
    removeCharacter()
    anchor.removeFromParent()
    shadow.geometry.dispose()
    shadow.material.dispose()
  }

  return {
    show, setInput, setNavigation, update, updateTransport, avoidVilla, place, dispose,
    get position() { return current ? anchor.position : null },
    get height() { return playerHeight },
    get radius() { return playerRadius },
    get isMoving() { return inputMagnitude > DEAD_ZONE },
    get isRunning() { return running },
    get facing() { return anchor.rotation.y }
  }
}

module.exports = { createManorPlayer }
