const DEAD_ZONE = 0.14
const RUN_ENTER = 0.78
const RUN_EXIT = 0.67
const WALK_MAX_TILT = (RUN_ENTER + RUN_EXIT) / 2
const WALK_SPEED = 1.7
const RUN_SPEED = 6.4
const MAX_STEP = 0.24
const MAX_RISE = 0.33
const ANIMATIONS = ['idle', 'walk', 'run']
const POSE_NAMES = {
  jump: ['jump'], sit_down: ['sit_down'], sit_idle: ['sit', 'sit_idle'], stand_up: ['stand_up'],
  lie_down: ['lie_down'], lie_idle: ['lie', 'lie_idle'], wake_up: ['wake_up'],
  car_sit: ['car_sit'], car_sit_rear: ['car_sit_rear'], drive_idle: ['drive', 'drive_idle']
}
const REVERSE_POSES = { stand_up: 'sit_down', wake_up: 'lie_down' }
const ONE_SHOTS = new Set(['jump', 'sit_down', 'stand_up', 'lie_down', 'wake_up'])
const TAU = Math.PI * 2

function createAvatarAnimator(THREE, model) {
  const clipKey = name => name.toLowerCase().replace(/[^a-z0-9]/g, '')
  const clips = new Map((model.animations || []).filter(clip =>
    typeof clip?.name === 'string' && Number.isFinite(clip.duration) && clip.duration > 0 && clip.tracks?.length
  ).map(clip => [clipKey(clip.name), clip]))
  if (ANIMATIONS.some(name => !clips.has(name))) throw new Error('角色缺少待机、行走或奔跑动画')

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
  const mixer = new THREE.AnimationMixer(model)
  const resolvedClips = new Map(ANIMATIONS.map(name => [name, clips.get(name)]))
  for (const [pose, aliases] of Object.entries(POSE_NAMES)) {
    const clip = aliases.map(alias => clips.get(clipKey(alias))).find(Boolean)
    if (clip) resolvedClips.set(pose, clip)
  }
  const names = [...resolvedClips.keys()]
  const actions = names.map((name, index) => {
    const action = mixer.clipAction(resolvedClips.get(name)).setEffectiveWeight(index === 0 ? 1 : 0).play()
    if (ONE_SHOTS.has(name)) {
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
      action.paused = true
    }
    return action
  })
  model.traverse(mesh => {
    // Their skinned bounds describe one pose. Keep limbs from disappearing
    // along the edge of the viewport during a stride.
    if (mesh.isSkinnedMesh) {
      mesh.frustumCulled = false
      mesh.receiveShadow = true
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        const texture = material?.map
        if (texture?.generateMipmaps && texture.anisotropy < 4) {
          texture.anisotropy = 4
          texture.needsUpdate = true
        }
      }
    }
  })
  const authoredY = model.position.y
  const standingY = authoredY - bounds.min.y
  model.position.y = standingY
  mixer.update(0)

  let active = 0, blend = null, seatWeight = 0

  function animate(index, speed, dt, progress, fade = .18) {
    if (index !== active) {
      const previous = actions[active]
      const next = actions[index]
      if (index > 0 && index <= 2 && active > 0 && active <= 2) {
        next.time = (previous.time / previous.getClip().duration) * next.getClip().duration
      } else if (next.weight < .01) next.time = 0
      blend = { elapsed: 0, duration: fade, from: actions.map(action => action.weight) }
      active = index
    }
    if (blend) {
      blend.elapsed += dt
      const fraction = fade === 0 ? 1 : Math.min(1, blend.elapsed / blend.duration)
      actions.forEach((action, i) => action.setEffectiveWeight(
        blend.from[i] * (1 - fraction) + (i === index ? fraction : 0)))
      if (fraction === 1) blend = null
    }
    if (index === 1) actions[index].setEffectiveTimeScale(THREE.MathUtils.clamp(speed / 1.65, .35, 1.65))
    if (index === 2) {
      const clip = actions[index].getClip()
      const distancePerCycle = clip.userData?.distancePerCycle
      const cadence = Number.isFinite(distancePerCycle) && distancePerCycle > 0
        ? speed * clip.duration / distancePerCycle : speed / 3.65
      actions[index].setEffectiveTimeScale(THREE.MathUtils.clamp(cadence, .3, 1.85))
    }
    const action = actions[index]
    if (Number.isFinite(progress)) {
      // Pause the action clock while advancing the mixer's other actions. This
      // samples the requested frame exactly, including a clip's last frame.
      action.paused = true
      action.time = THREE.MathUtils.clamp(progress, 0, 1) * action.getClip().duration
    } else if (!ONE_SHOTS.has(names[index])) action.paused = false
    mixer.update(dt)
  }

  function poseIndex(name) {
    const index = names.indexOf(name)
    return index >= 0 ? index : names.indexOf(REVERSE_POSES[name])
  }

  function hasPose(name) { return poseIndex(name) >= 0 }

  function poseDuration(name) { return actions[poseIndex(name)]?.getClip().duration || 0 }

  function playPose(name, progress, dt, fade) {
    const index = poseIndex(name)
    const reverse = index >= 0 && names[index] !== name
    animate(Math.max(0, index), 0, dt, reverse ? 1 - (progress || 0) : progress, fade)
  }

  function blendSeat(name, weight, dt) {
    const index = poseIndex(name)
    if (index < 0) return animate(0, 0, dt)
    const action = actions[index]
    if (active !== index && action.weight < .01) action.time = 0
    active = index
    blend = null
    actions[0].paused = false
    action.paused = false
    actions.forEach((item, i) => item.setEffectiveWeight(i === index ? weight : i === 0 ? 1 - weight : 0))
    mixer.update(dt)
  }

  function setSeatWeight(weight) {
    if (weight === seatWeight) return
    model.position.y = standingY + (authoredY - standingY) * weight
    seatWeight = weight
  }

  function updateGait(dt, gait, speed) {
    const index = ANIMATIONS.indexOf(gait)
    animate(index < 0 ? 0 : index, Number.isFinite(speed) ? speed : 0, dt)
  }

  function updatePose(dt, pose) {
    playPose(pose === 'sit' ? 'sit_idle' : pose === 'lie' ? 'lie_idle' : 'idle', undefined, dt)
  }

  function dispose() {
    mixer.stopAllAction()
    mixer.uncacheRoot(model)
  }

  return { height, radius, animate, playPose, hasPose, poseDuration, blendSeat, setSeatWeight, updateGait, updatePose, dispose,
    runSpeed: RUN_SPEED,
    get activeWeight() { return actions[active].weight } }
}

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
  let jumpElapsed = null, jumpStartY = 0
  let playerHeight = 1.6
  let playerRadius = .4
  const handTarget = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)

  function removeCharacter() {
    if (!current) return
    jumpElapsed = null
    const { model, animator } = current
    animator.dispose()
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
    const animator = createAvatarAnimator(THREE, model)
    if (!current && !spawn(yaw)) {
      animator.dispose()
      throw new Error('找不到角色出生点')
    }

    removeCharacter()
    playerHeight = animator.height
    playerRadius = animator.radius
    // The girl lifts her pelvis below a stationary rig root. The boy's pelvis follows his moving root.
    const jumpRoot = ['Hips', 'Root'].map(name => model.getObjectByName(name)).find(node => node?.isBone)
    current = { model, animator, arms: getVehicleArms(model), jumpRoot }
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
    cancelJump()
    setInput(0, 0)
  }

  function place(x, z, yaw, preferredY) {
    if (!current || !Number.isFinite(x) || !Number.isFinite(z)) return false
    const y = currentNavigation.sample(x, z, currentGetVillaBounds(), preferredY)
    if (!Number.isFinite(y)) return false
    cancelJump()
    anchor.position.set(x, y, z)
    if (Number.isFinite(yaw)) anchor.rotation.y = yaw
    setInput(0, 0)
    return true
  }

  function avoidVilla() {
    if (!current || Number.isFinite(currentNavigation.sample(anchor.position.x, anchor.position.z, currentGetVillaBounds(), anchor.position.y))) return false
    cancelJump()
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
    current.arms.forEach(arm => arm.restore())
    current.animator.animate(index, speed, dt)
  }

  function animatePose(name, progress, dt, fade) {
    if (!current) return
    current.arms.forEach(arm => arm.restore())
    current.animator.playPose(name, progress, dt, fade)
  }

  function hasPose(name) { return current?.animator.hasPose(name) || false }

  function poseDuration(name) { return current?.animator.poseDuration(name) || 0 }

  const jumpPoint = new THREE.Vector3()
  function jumpRootY() {
    return current?.jumpRoot ? current.jumpRoot.getWorldPosition(jumpPoint).y - anchor.position.y : 0
  }

  function jump() {
    if (jumpElapsed !== null || !hasPose('jump')) return false
    jumpStartY = jumpRootY()
    jumpElapsed = 0
    animatePose('jump', 0, 0)
    return true
  }

  function cancelJump() {
    if (jumpElapsed === null) return
    jumpElapsed = null
    animatePose('idle', undefined, 0, 0)
  }

  function poseAt(x, y, z, yaw) {
    if (!current || ![x, y, z, yaw].every(Number.isFinite)) return false
    cancelJump()
    anchor.position.set(x, y, z)
    anchor.rotation.y = yaw
    return true
  }

  function face(yaw, dt) {
    const angle = yaw - anchor.rotation.y
    const shortestTurn = Math.atan2(Math.sin(angle), Math.cos(angle))
    anchor.rotation.y = (anchor.rotation.y + shortestTurn * (1 - Math.exp(-18 * dt))) % TAU
  }

  function getVehicleArms(model) {
    const getBone = (part, side) => model.getObjectByName(part + '_' + side) ||
      model.getObjectByName(part + side) || model.getObjectByName(part + '.' + side)
    return ['L', 'R'].flatMap((side, index) => {
      const upper = getBone('UpperArm', side)
      const forearm = getBone('Forearm', side)
      const hand = getBone('Hand', side)
      if (!upper?.isBone || forearm?.parent !== upper || hand?.parent !== forearm) return []
      const sign = Math.sign(model.worldToLocal(upper.getWorldPosition(new THREE.Vector3())).x) || (index === 0 ? 1 : -1)
      const shoulder = new THREE.Vector3()
      const elbow = new THREE.Vector3()
      const wrist = new THREE.Vector3()
      const direction = new THREE.Vector3()
      const bend = new THREE.Vector3()
      const desiredElbow = new THREE.Vector3()
      const desiredWrist = new THREE.Vector3()
      const from = new THREE.Vector3()
      const to = new THREE.Vector3()
      const delta = new THREE.Quaternion()
      const parent = new THREE.Quaternion()
      const parentInverse = new THREE.Quaternion()
      const restUpper = new THREE.Quaternion()
      const restForearm = new THREE.Quaternion()
      let modified = false

      function aimBone(bone, origin, before, after) {
        from.subVectors(before, origin).normalize()
        to.subVectors(after, origin).normalize()
        delta.setFromUnitVectors(from, to)
        bone.parent.getWorldQuaternion(parent)
        bone.quaternion.premultiply(parentInverse.copy(parent).invert().multiply(delta).multiply(parent))
      }

      function aim(target, weight) {
        upper.getWorldPosition(shoulder)
        forearm.getWorldPosition(elbow)
        hand.getWorldPosition(wrist)
        const a = shoulder.distanceTo(elbow), b = elbow.distanceTo(wrist)
        const d = direction.subVectors(target, shoulder).length()
        if (Math.min(a, b, d) < .001) return
        direction.divideScalar(d)
        const reach = THREE.MathUtils.clamp(d, Math.abs(a - b) + .001, a + b - .001)
        // Use a low, outward elbow bend so wrist alignment keeps the arm natural.
        bend.set(sign * .6, -1, -.25).applyAxisAngle(up, anchor.rotation.y)
        bend.addScaledVector(direction, -bend.dot(direction)).normalize()
        const along = (a * a - b * b + reach * reach) / (2 * reach)
        const across = Math.sqrt(Math.max(0, a * a - along * along))
        desiredElbow.copy(shoulder).addScaledVector(direction, along).addScaledVector(bend, across)
        desiredWrist.copy(shoulder).addScaledVector(direction, reach)
        restUpper.copy(upper.quaternion)
        restForearm.copy(forearm.quaternion)
        aimBone(upper, shoulder, elbow, desiredElbow)
        forearm.getWorldPosition(elbow)
        hand.getWorldPosition(wrist)
        aimBone(forearm, elbow, wrist, desiredWrist)
        upper.quaternion.slerp(restUpper, 1 - weight)
        forearm.quaternion.slerp(restForearm, 1 - weight)
        modified = true
      }

      function restore() {
        if (!modified) return
        upper.quaternion.copy(restUpper)
        forearm.quaternion.copy(restForearm)
        modified = false
      }

      return [{ sign, aim, restore }]
    })
  }

  function updateVehicleHands(motion, progress) {
    const { action, side, handle, wheel, seated } = motion
    if (action === 'reach' || handle) {
      const weight = THREE.MathUtils.smoothstep(progress, 0, .23) * (1 - THREE.MathUtils.smoothstep(progress, .75, 1))
      if (weight <= 0) return
      const arm = current.arms.find(arm => arm.sign === (side < 0 ? -1 : 1))
      if (!arm) return
      if (handle && [handle.x, handle.y, handle.z].every(Number.isFinite)) handTarget.copy(handle)
      else anchor.localToWorld(handTarget.set(arm.sign * (seated ? .4 : .2), seated ? .67 : .86, seated ? .2 : .44))
      arm.aim(handTarget, weight)
    } else if (action === 'drive' && wheel?.isObject3D) {
      current.arms.forEach(arm => {
        wheel.localToWorld(handTarget.set(arm.sign * .145, 0, .035))
        arm.aim(handTarget, current.animator.activeWeight)
      })
    }
  }

  function updateTransport(dt, x, y, z, yaw, motion = false) {
    if (!current) return
    cancelJump()
    const groundSpeed = dt > 0 ? Math.hypot(x - anchor.position.x, z - anchor.position.z) / dt : 0
    anchor.position.set(x, y, z)
    if (!motion || typeof motion !== 'object') {
      if (Number.isFinite(yaw)) face(yaw, dt)
      current.animator.setSeatWeight(0)
      shadow.visible = true
      animate(motion ? 1 : 0, groundSpeed, dt)
      return
    }
    const action = motion.action === 'reach' && motion.seated ? 'seated' : motion.action
    const progress = THREE.MathUtils.clamp(motion.progress || 0, 0, 1)
    const carPose = motion.rear && hasPose('car_sit_rear') ? 'car_sit_rear' : 'car_sit'
    const hasCarPose = hasPose(carPose)
    const seated = action === 'seated' || action === 'drive'
    const seatWeight = hasCarPose && Number.isFinite(motion.seatBlend) ? THREE.MathUtils.clamp(motion.seatBlend, 0, 1) : 0
    current.animator.setSeatWeight(seatWeight)
    if (Number.isFinite(yaw)) {
      if (seated && seatWeight === 1) anchor.rotation.y = yaw
      else face(yaw, dt)
    }
    shadow.visible = (action === 'reach' || action === 'walk' || action === 'idle') && !motion.seated
    if (hasCarPose && (action === 'board' || action === 'exit')) {
      current.arms.forEach(arm => arm.restore())
      const blend = THREE.MathUtils.smoothstep(progress, 0, 1)
      current.animator.blendSeat(carPose, action === 'board' ? blend : 1 - blend, dt)
    } else if (seated) {
      const pose = action === 'drive' && hasPose('drive_idle') ? 'drive_idle' : hasCarPose ? carPose : 'sit_idle'
      animatePose(pose, undefined, dt)
    } else if (action === 'board' || action === 'exit' || action === 'reach') {
      animatePose(action === 'exit' ? 'stand_up' : 'sit_down',
        action === 'reach' ? .40 * Math.sin(progress * Math.PI) : progress, dt)
    } else animate(action === 'walk' ? 1 : 0, groundSpeed, dt)
    updateVehicleHands(motion, progress)
  }

  function update(dt, azimuth) {
    if (!current || !(dt > 0)) return
    current.animator.setSeatWeight(0)
    shadow.visible = true
    let gait = 0, groundSpeed = 0
    if (inputMagnitude > DEAD_ZONE) {
      const tilt = Math.min(inputMagnitude, 1)
      const walkEffort = Math.min(1, (tilt - DEAD_ZONE) / (WALK_MAX_TILT - DEAD_ZONE))
      const runEffort = Math.max(0, (tilt - WALK_MAX_TILT) / (1 - WALK_MAX_TILT))
      const speed = WALK_SPEED * walkEffort + (current.animator.runSpeed - WALK_SPEED) * runEffort
      const amount = speed * dt / inputMagnitude
      const sin = Math.sin(azimuth), cos = Math.cos(azimuth)
      const x = anchor.position.x, z = anchor.position.z
      move((inputX * cos + inputY * sin) * amount, (-inputX * sin + inputY * cos) * amount)
      const dx = anchor.position.x - x, dz = anchor.position.z - z
      if (Math.hypot(dx, dz) > .0001) {
        gait = running ? 2 : 1
        groundSpeed = Math.hypot(dx, dz) / dt
        face(Math.atan2(dx, dz), dt)
      }
    }
    if (jumpElapsed !== null) {
      // Keep the navigation position on the floor while the jump clip raises the model.
      const duration = poseDuration('jump')
      jumpElapsed = Math.min(duration, jumpElapsed + dt)
      animatePose('jump', jumpElapsed / duration, dt)
      if (jumpElapsed >= duration) jumpElapsed = null
    } else {
      animate(gait, groundSpeed, dt)
    }
  }

  function dispose() {
    removeCharacter()
    anchor.removeFromParent()
    shadow.geometry.dispose()
    shadow.material.dispose()
  }

  function setVisible(visible) {
    anchor.visible = visible
  }

  return {
    show, setInput, setNavigation, update, updateTransport, animatePose, poseAt, avoidVilla, place, setVisible, dispose,
    jump, cancelJump, hasPose, poseDuration,
    get canJump() { return jumpElapsed === null && hasPose('jump') },
    get isJumping() { return jumpElapsed !== null },
    get jumpHeight() { return jumpElapsed === null ? 0 : Math.max(0, (jumpRootY()) - jumpStartY) },
    get position() { return current ? anchor.position : null },
    get height() { return playerHeight },
    get radius() { return playerRadius },
    get isMoving() { return inputMagnitude > DEAD_ZONE },
    get isRunning() { return running },
    get facing() { return anchor.rotation.y }
  }
}

module.exports = { createManorPlayer, createAvatarAnimator }
