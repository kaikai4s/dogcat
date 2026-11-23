const { cloneAvatarModel, disposeAvatarSkeletons } = require('./manor-avatar-clone')

const PET_TYPES = new Set(['dog', 'cat'])
const TAU = Math.PI * 2
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const MAX_ROAM_TRIES = 12
const ROAM_MIN = 5
const ROAM_MAX = 18
const DOG_SCALE = .86
const CAT_SCALE = .70
const WALK_SPEED = 1.35
const RUN_SPEED = 2.7
const PET_RENDER_RANGE = 320

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const finite = Number.isFinite

function normalizeType(value) {
  return value === 'cat' ? 'cat' : 'dog'
}

function clipKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function safePoint(position) {
  return position && finite(position.x) && finite(position.z)
    ? { x: position.x, y: finite(position.y) ? position.y : undefined, z: position.z }
    : null
}

function pointDistance(a, b) {
  return a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity
}

function motionSignature(motion) {
  if (!motion) return ''
  return JSON.stringify([motion.epoch, motion.approach, motion.patrol, motion.speed, motion.roamSpeed, motion.wait])
}

function createPetAnimator(THREE, model) {
  const mixer = new THREE.AnimationMixer(model)
  const clips = new Map()
  for (const clip of model.animations || []) {
    if (clip?.tracks?.length && finite(clip.duration) && clip.duration > 0) clips.set(clipKey(clip.name), clip)
  }
  const actions = new Map()
  const oneShot = new Set(['happy', 'sad', 'angry', 'poop', 'pee', 'eat', 'drink', 'sit', 'playful'])
  let active = ''
  let blend = null

  function resolve(name) {
    const aliases = {
      idle: ['idle', 'calm'],
      walk: ['walk'],
      run: ['run', 'walk'],
      happy: ['happy', 'playful'],
      sad: ['sad'],
      hungry: ['hungry', 'sad'],
      sleepy: ['sleepy', 'sleep', 'sit'],
      eat: ['eat'],
      drink: ['drink'],
      sleep: ['sleep', 'sleepy', 'sit'],
      sit: ['sit', 'sleepy', 'idle'],
      need_toilet: ['needtoilet', 'hungry'],
      poop: ['poop'],
      pee: ['pee']
    }
    const keys = aliases[name] || [name]
    for (const key of keys) {
      const clip = clips.get(clipKey(key))
      if (!clip) continue
      if (!actions.has(key)) {
        const action = mixer.clipAction(clip)
        action.setEffectiveWeight(0)
        if (oneShot.has(key)) {
          action.setLoop(THREE.LoopOnce, 1)
          action.clampWhenFinished = true
        }
        actions.set(key, action)
      }
      return { key, action: actions.get(key) }
    }
    return null
  }

  function play(name, { loop = true, speed = 1, fade = .18 } = {}) {
    const resolved = resolve(name) || resolve('idle')
    if (!resolved) return false
    const next = resolved.action
    if (resolved.key === active && next.getEffectiveWeight() > .98) {
      next.setEffectiveTimeScale(clamp(speed, .25, 2.2))
      return true
    }
    const previous = active ? actions.get(active) : null
    if (previous && previous !== next) {
      previous.fadeOut(fade)
      next.reset().fadeIn(fade)
    } else next.reset().setEffectiveWeight(1).play()
    if (loop && !oneShot.has(resolved.key)) next.setLoop(THREE.LoopRepeat, Infinity)
    if (!loop || oneShot.has(resolved.key)) {
      next.setLoop(THREE.LoopOnce, 1)
      next.clampWhenFinished = true
    }
    next.setEffectiveTimeScale(clamp(speed, .25, 2.2))
    next.play()
    active = resolved.key
    blend = { action: next, duration: fade, elapsed: 0 }
    return true
  }

  function update(dt) {
    if (blend) {
      blend.elapsed += dt
      const fraction = clamp(blend.elapsed / blend.duration, 0, 1)
      blend.action.setEffectiveWeight(fraction)
      if (fraction >= 1) blend = null
    }
    mixer.update(dt)
  }

  function has(name) { return Boolean(resolve(name)) }
  function dispose() { mixer.stopAllAction(); mixer.uncacheRoot(model) }

  return { play, update, has, dispose, get active() { return active } }
}

function createManorPetManager({ THREE, scene, navigation, getNavigation, getOutdoorBounds, getVillaBounds, disposeModel, mapPoint } = {}) {
  const root = new THREE.Group()
  root.name = 'Manor pets'
  scene.add(root)
  const templates = new Map()
  const pets = new Map()
  const residentRecords = new Map()
  const playerPosition = new THREE.Vector3()
  const scratch = new THREE.Vector3()
  const scratch2 = new THREE.Vector3()
  let hasPlayerPosition = false
  let disposed = false
  let seed = 1
  const currentNavigation = () => getNavigation?.() || navigation

  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }

  function sample(x, z) {
    const bounds = typeof getOutdoorBounds === 'function' ? getOutdoorBounds() : null
    const y = currentNavigation()?.sample?.(x, z, bounds)
    return finite(y) ? { x, y, z } : null
  }

  function nearest(x, z, maxDistance = 24) {
    const bounds = typeof getOutdoorBounds === 'function' ? getOutdoorBounds() : null
    return currentNavigation()?.nearestWalkable?.(x, z, bounds, maxDistance) || null
  }

  function clearRoute(pet) {
    pet.route = []
    pet.routeIndex = 0
    pet.wait = 0
    pet.moving = false
  }

  function setPosition(pet, position) {
    const point = safePoint(position)
    if (!point) return false
    const grounded = sample(point.x, point.z) || nearest(point.x, point.z)
    if (!grounded) return false
    pet.group.position.set(grounded.x, grounded.y, grounded.z)
    pet.target.copy(pet.group.position)
    pet.targetYaw = finite(position.facing) ? position.facing : pet.targetYaw
    pet.group.rotation.y = pet.targetYaw
    clearRoute(pet)
    return true
  }

  function spawnNearVilla(index, ownerId) {
    const bounds = typeof getVillaBounds === 'function' ? getVillaBounds(ownerId) : null
    if (!bounds?.isBox3 || bounds.isEmpty()) return null
    const center = bounds.getCenter(scratch)
    const size = bounds.getSize(scratch2)
    const angle = index * GOLDEN_ANGLE
    const radius = Math.max(size.x, size.z) * .5 + 2.5 + Math.floor(index / 4) * 1.2
    return nearest(center.x + Math.cos(angle) * radius, center.z + Math.sin(angle) * radius, 30)
  }

  function normalizeModel(source, species) {
    const model = cloneAvatarModel(source)
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model)
    const size = bounds.getSize(scratch)
    const max = Math.max(size.x, size.y, size.z, .01)
    const target = species === 'cat' ? CAT_SCALE : DOG_SCALE
    const placement = new THREE.Group()
    placement.name = 'Pet placement'
    placement.scale.setScalar(target / max)
    placement.position.set(-((bounds.min.x + bounds.max.x) / 2) * placement.scale.x,
      -bounds.min.y * placement.scale.y, -((bounds.min.z + bounds.max.z) / 2) * placement.scale.z)
    placement.add(model)
    return { placement, model }
  }

  function removePet(id) {
    const pet = pets.get(id)
    if (!pet) return
    pet.animator?.dispose()
    disposeAvatarSkeletons(pet.model)
    pet.group.removeFromParent()
    pets.delete(id)
  }

  function createPet(id, species, record) {
    const template = templates.get(species)
    if (!template) return null
    const group = new THREE.Group()
    group.name = 'Pet ' + id
    group.userData = { petId: id, species, name: record.name || '宠物', ownerId: record.ownerId || '' }
    const normalized = normalizeModel(template.source, species)
    group.add(normalized.placement)
    group.traverse(node => {
      if (!node.isMesh) return
      node.castShadow = true
      node.receiveShadow = true
      node.frustumCulled = false
    })
    const animator = createPetAnimator(THREE, normalized.model)
    const pet = {
      id, species, mine: record.mine === true, name: record.name || '宠物', group,
      model: normalized.model, animator, target: new THREE.Vector3(), targetYaw: 0,
      route: [], routeIndex: 0, wait: 0, moving: false, speed: WALK_SPEED,
      following: false, needs: null, care: null, relieving: null, record: null,
      scale: 1, action: 'idle', actionUntil: 0, forcedAction: '', forcedActionUntil: 0,
      roamIndex: 0, motionSignature: '', sharedPatrol: [], sharedPatrolIndex: 1,
      sharedPatrolWait: 3, sharedRoamSpeed: WALK_SPEED
    }
    root.add(group)
    pets.set(id, pet)
    const motion3d = record.manor3dMotion || null
    const hasSavedPosition = record.manor3dPosition || record.position3d
    const initial = record.manor3dPosition || record.position3d || motion3d?.position ||
      (motion3d?.approach && motion3d.approach[0]) ||
      (record.motion && record.motion.approach && mapPoint?.(record.motion.approach[0]))
    const villaSpawn = !hasSavedPosition && !record.following && !record.care &&
      spawnNearVilla(pets.size - 1, record.ownerId)
    if (villaSpawn && setPosition(pet, villaSpawn)) {
      pet.spawnedNearVilla = true
      pet.motionSignature = motionSignature(motion3d)
      createPatrol(pet)
    } else if (!setPosition(pet, initial)) {
      const spawn = currentNavigation()?.spawn?.(typeof getOutdoorBounds === 'function' ? getOutdoorBounds() : null)
      if (spawn) setPosition(pet, spawn)
    }
    applyRecord(pet, record)
    return pet
  }

  function setModel(species, source) {
    species = normalizeType(species)
    if (disposed || !source?.isObject3D) return false
    const previous = templates.get(species)
    if (previous?.source === source) return true
    templates.set(species, { source })
    for (const record of residentRecords.values()) {
      for (const pet of record.pets || []) if (normalizeType(pet.species) === species) {
        removePet(String(pet.id || pet._id))
        createPet(String(pet.id || pet._id), species, { ...pet, ownerId: record.ownerId, mine: record.mine })
      }
    }
    if (previous) {
      disposeAvatarSkeletons(previous.source)
      disposeModel(previous.source)
    }
    return true
  }

  function applyRecord(pet, record) {
    pet.record = record
    pet.mine = record.mine === true
    pet.name = record.name || pet.name
    pet.species = normalizeType(record.species || pet.species)
    pet.following = record.following === true
    pet.needs = record.needs || pet.needs
    pet.care = record.care || null
    pet.relieving = record.relieving || null
    pet.scale = clamp(Number(record.modelScale) || 1, .5, 2)
    pet.group.userData.name = pet.name
    pet.group.userData.ownerId = record.ownerId || pet.group.userData.ownerId || ''
    pet.group.scale.setScalar(pet.scale)
    const position = record.manor3dPosition || record.position3d || (record.position && mapPoint?.(record.position))
    if (position && pointDistance(position, pet.group.position) > 3) setPosition(pet, position)
    const motion = record.manor3dMotion
    const signature = motionSignature(motion)
    if (motion && signature !== pet.motionSignature && !(pet.mine && pet.following) && Array.isArray(motion.approach)) {
      pet.motionSignature = signature
      setSharedPatrol(pet, motion)
      const route = motion.approach.map(safePoint).filter(Boolean)
      if (route.length > 1) {
        pet.route = route
        pet.routeIndex = route.reduce((nearestIndex, point, index) =>
          pointDistance(point, pet.group.position) < pointDistance(route[nearestIndex], pet.group.position) ? index : nearestIndex, 0)
        pet.speed = finite(motion.speed) ? clamp(motion.speed, .5, RUN_SPEED * 2) : WALK_SPEED
        pet.moving = true
      }
    } else if (signature) {
      pet.motionSignature = signature
    }
    return pet
  }

  function setSharedPatrol(pet, motion) {
    pet.sharedPatrol = Array.isArray(motion?.patrol) ? motion.patrol.map(safePoint).filter(Boolean) : []
    pet.sharedPatrolIndex = 1
    pet.sharedPatrolWait = finite(motion?.wait) ? Math.max(0, motion.wait) : 3
    pet.sharedRoamSpeed = finite(motion?.roamSpeed) ? clamp(motion.roamSpeed, .5, RUN_SPEED * 2) : WALK_SPEED
  }

  function createPatrol(pet) {
    let localSeed = 0
    for (const character of pet.id) localSeed = (Math.imul(localSeed, 31) + character.charCodeAt(0)) >>> 0
    const nextRandom = () => {
      localSeed = (Math.imul(localSeed, 1664525) + 1013904223) >>> 0
      return localSeed / 4294967296
    }
    const start = { x: pet.group.position.x, z: pet.group.position.z }
    const points = [start]
    let previous = start
    for (let attempt = 0; attempt < 10 && points.length < 6; attempt++) {
      const angle = nextRandom() * TAU
      const radius = 5 + nextRandom() * 9
      const point = nearest(start.x + Math.cos(angle) * radius, start.z + Math.sin(angle) * radius, 20)
      if (point && segmentClear(previous, point) && segmentClear(point, start)) {
        points.push(point)
        previous = point
      }
    }
    if (points.length > 1) points.push(start)
    pet.sharedPatrol = points
    pet.sharedPatrolIndex = 1
    pet.sharedPatrolWait = 2
    pet.sharedRoamSpeed = WALK_SPEED
  }

  function applyRecordById(id, record) {
    const pet = getPet(id)
    if (!pet || !record) return false
    applyRecord(pet, { ...record, id: pet.id, species: record.species || pet.species,
      mine: pet.mine, ownerId: pet.record?.ownerId || '' })
    return true
  }

  function setRecords(records, { replace = true } = {}) {
    if (disposed || !Array.isArray(records)) return
    const received = replace ? new Set() : null
    for (const record of records) {
      if (!record?.id) continue
      received?.add(record.id)
      if (record.deleted) {
        const previous = residentRecords.get(record.id)
        residentRecords.delete(record.id)
        const ownerId = record.ownerId || previous?.ownerId
        for (const pet of pets.values()) if (ownerId && pet.record?.ownerId === ownerId) removePet(pet.id)
        continue
      }
      if (record.kind !== 'resident') continue
      residentRecords.set(record.id, record)
      const next = new Set()
      for (const raw of Array.isArray(record.pets) ? record.pets : []) {
        const id = String(raw.id || raw._id || '')
        if (!id || !PET_TYPES.has(raw.species)) continue
        next.add(id)
        const payload = { ...raw, ownerId: record.ownerId, mine: record.mine === true }
        const existing = pets.get(id)
        if (existing && existing.species === normalizeType(raw.species)) applyRecord(existing, payload)
        else {
          if (existing) removePet(id)
          createPet(id, normalizeType(raw.species), payload)
        }
      }
      for (const pet of pets.values()) if (pet.record?.ownerId === record.ownerId && !next.has(pet.id)) removePet(pet.id)
    }
    if (received) for (const id of residentRecords.keys()) if (!received.has(id)) {
      const record = residentRecords.get(id)
      residentRecords.delete(id)
      for (const pet of pets.values()) if (pet.record?.ownerId === record.ownerId) removePet(pet.id)
    }
  }

  function setPlayerPosition(position) {
    const point = safePoint(position)
    if (!point) return
    const y = finite(point.y) ? point.y : currentNavigation()?.sample?.(point.x, point.z,
      typeof getOutdoorBounds === 'function' ? getOutdoorBounds() : null)
    playerPosition.set(point.x, finite(y) ? y : 0, point.z)
    hasPlayerPosition = true
  }

  function repositionNearVilla() {
    let index = 0
    for (const pet of pets.values()) {
      if (pet.spawnedNearVilla || pet.record?.manor3dPosition || pet.record?.position3d) {
        index += 1
        continue
      }
      const point = spawnNearVilla(index++, pet.record?.ownerId)
      if (point && setPosition(pet, point)) {
        pet.spawnedNearVilla = true
        pet.motionSignature = motionSignature(pet.record?.manor3dMotion)
        createPatrol(pet)
      }
    }
  }

  function repositionBlocked() {
    for (const pet of pets.values()) {
      const { x, z } = pet.group.position
      if (sample(x, z)) continue
      const point = nearest(x, z) || currentNavigation()?.spawn?.(getOutdoorBounds?.())
      if (point && setPosition(pet, point)) createPatrol(pet)
    }
  }

  function segmentClear(from, to) {
    const length = Math.hypot(to.x - from.x, to.z - from.z)
    const steps = Math.max(2, Math.ceil(length / .75))
    for (let i = 1; i <= steps; i++) {
      const f = i / steps
      if (!sample(from.x + (to.x - from.x) * f, from.z + (to.z - from.z) * f)) return false
    }
    return true
  }

  function chooseRoam(pet) {
    const start = pet.group.position
    for (let attempt = 0; attempt < MAX_ROAM_TRIES; attempt++) {
      const angle = random() * TAU
      const radius = ROAM_MIN + random() * (ROAM_MAX - ROAM_MIN)
      const target = { x: start.x + Math.cos(angle) * radius, z: start.z + Math.sin(angle) * radius }
      if (!segmentClear(start, target)) continue
      const point = sample(target.x, target.z)
      if (!point) continue
      pet.route = [point]
      pet.routeIndex = 0
      pet.speed = random() < .18 ? RUN_SPEED : WALK_SPEED
      pet.wait = 0
      pet.moving = true
      return true
    }
    pet.wait = 1.5 + random() * 2
    pet.moving = false
    return false
  }

  function chooseFollow(pet, index) {
    if (!hasPlayerPosition) return false
    const angle = index * GOLDEN_ANGLE
    const radius = 2.5 + Math.floor(index / 4) * .8
    const desired = { x: playerPosition.x + Math.cos(angle) * radius, z: playerPosition.z + Math.sin(angle) * radius }
    const point = nearest(desired.x, desired.z, 18)
    if (!point || !segmentClear(pet.group.position, point)) return false
    pet.route = [point]
    pet.routeIndex = 0
    pet.speed = pointDistance(pet.group.position, point) > 5 ? RUN_SPEED : WALK_SPEED
    pet.moving = true
    pet.wait = 0
    return true
  }

  function chooseAction(pet) {
    const needs = pet.needs || {}
    const care = pet.care && (!finite(pet.care.startsAt) || Date.now() >= pet.care.startsAt) ? pet.care : null
    if (pet.relieving?.type) return pet.relieving.type
    if (care?.type) return care.type
    if (Number(needs.poop) >= 80 || Number(needs.pee) >= 80) return 'need_toilet'
    if (Number(needs.satiety) <= 20) return 'hungry'
    if (Number(needs.energy) <= 20) return 'sleepy'
    return 'idle'
  }

  function playState(pet, dt) {
    const state = chooseAction(pet)
    let action = pet.forcedAction && Date.now() < pet.forcedActionUntil ? pet.forcedAction : state
    let speed = pet.speed / WALK_SPEED
    if (pet.moving) action = pet.speed > 2 ? 'run' : 'walk'
    if (pet.relieving?.type) action = pet.relieving.type
    if (pet.care?.type && (!finite(pet.care.startsAt) || Date.now() >= pet.care.startsAt)) action = pet.care.type
    if (pet.action !== action) {
      pet.action = action
      pet.actionUntil = oneShotDuration(pet, action)
      pet.animator.play(action, { loop: !isOneShot(action), speed })
    }
    if (pet.actionUntil > 0) pet.actionUntil -= dt
    if (pet.actionUntil <= 0 && isOneShot(action)) {
      pet.action = ''
      pet.animator.play('idle')
    }
  }

  function isOneShot(action) {
    return ['happy', 'sad', 'poop', 'pee', 'eat', 'drink', 'sit', 'playful'].includes(action)
  }

  function oneShotDuration(pet, action) {
    const clips = pet.model.animations || []
    const clip = clips.find(item => clipKey(item.name) === clipKey(action))
    return clip?.duration || 1.2
  }

  function movePet(pet, dt) {
    if (pet.relieving && finite(pet.relieving.until) && Date.now() < pet.relieving.until) {
      pet.moving = false
      return
    }
    if (pet.care?.type && finite(pet.care.startsAt) && Date.now() >= pet.care.startsAt) {
      clearRoute(pet)
      return
    }
    if (!pet.moving || !pet.route.length) return
    const target = pet.route[pet.routeIndex]
    const dx = target.x - pet.group.position.x
    const dz = target.z - pet.group.position.z
    const distance = Math.hypot(dx, dz)
    if (distance < .04) {
      pet.routeIndex += 1
      if (pet.routeIndex >= pet.route.length) {
        pet.route = []
        pet.routeIndex = 0
        pet.moving = false
        pet.wait = !pet.mine && pet.sharedPatrol.length > 1 ? pet.sharedPatrolWait : 1.5 + random() * 3
      }
      return
    }
    const step = Math.min(distance, pet.speed * dt)
    const x = pet.group.position.x + dx / distance * step
    const z = pet.group.position.z + dz / distance * step
    const y = currentNavigation()?.sample?.(x, z, typeof getOutdoorBounds === 'function' ? getOutdoorBounds() : null)
    if (!finite(y)) {
      clearRoute(pet)
      return
    }
    pet.group.position.set(x, y, z)
    pet.target.set(x, y, z)
    const yaw = Math.atan2(dx, dz)
    const angle = Math.atan2(Math.sin(yaw - pet.group.rotation.y), Math.cos(yaw - pet.group.rotation.y))
    pet.group.rotation.y += angle * (1 - Math.exp(-14 * dt))
  }

  function update(dt) {
    if (disposed || !finite(dt) || dt <= 0) return
    let index = 0
    for (const pet of pets.values()) {
      const distance = hasPlayerPosition ? pet.group.position.distanceTo(playerPosition) : 0
      pet.group.visible = distance <= PET_RENDER_RANGE || pet.mine
      if (!pet.group.visible) continue
      if (pet.following) {
        if (pet.mine && !pet.relieving && ((!pet.moving && pet.wait <= 0) || pointDistance(pet.route[pet.routeIndex], playerPosition) > 4)) {
          chooseFollow(pet, index)
        }
      } else if (!pet.moving && !pet.care) {
        pet.wait -= dt
        if (pet.wait <= 0 && pet.sharedPatrol.length > 1) {
          const target = pet.sharedPatrol[pet.sharedPatrolIndex]
          if (pointDistance(target, pet.group.position) < .2) {
            pet.sharedPatrolIndex = (pet.sharedPatrolIndex + 1) % pet.sharedPatrol.length
          }
          const next = pet.sharedPatrol[pet.sharedPatrolIndex]
          if (next) {
            pet.route = [next]
            pet.routeIndex = 0
            pet.speed = pet.sharedRoamSpeed
            pet.moving = true
          }
        } else if (pet.wait <= 0) chooseRoam(pet)
      }
      movePet(pet, dt)
      playState(pet, dt)
      pet.animator.update(dt)
      index += 1
    }
  }

  function getPet(id) { return pets.get(String(id)) || null }
  function getPets() { return Array.from(pets.values()) }
  function command(id, operation) {
    const pet = getPet(id)
    if (!pet || typeof operation !== 'string') return false
    if (operation === 'follow') {
      pet.following = true
      pet.wait = 0
      return true
    }
    if (operation === 'stay') {
      pet.following = false
      pet.wait = 0
      clearRoute(pet)
      return true
    }
    if (['eat', 'drink', 'sleep', 'feed'].includes(operation)) {
      pet.care = { type: operation === 'feed' ? 'eat' : operation, startsAt: Date.now(), endsAt: Date.now() + 3000 }
      pet.action = ''
      return true
    }
    return false
  }

  function interact(id) {
    const pet = getPet(id)
    if (!pet) return false
    pet.forcedAction = 'happy'
    pet.forcedActionUntil = Date.now() + 1100
    pet.animator.play('happy', { loop: false })
    pet.wait = 2.5
    clearRoute(pet)
    return true
  }

  function relief(id, type) {
    const pet = getPet(id)
    if (!pet || (type !== 'poop' && type !== 'pee')) return false
    pet.forcedAction = type
    pet.forcedActionUntil = Date.now() + (type === 'poop' ? 2400 : 1800)
    pet.animator.play(type, { loop: false })
    pet.relieving = { type, until: pet.forcedActionUntil }
    clearRoute(pet)
    return true
  }

  function clearWaste(id, wasteId) {
    const pet = getPet(id)
    if (!pet || !wasteId || !Array.isArray(pet.record?.waste)) return false
    const waste = pet.record.waste
    const retained = waste.filter(item => item?.id !== wasteId)
    if (retained.length === waste.length) return false
    pet.record.waste = retained
    return true
  }

  function clearSelection() {
    return true
  }
  function dispose() {
    if (disposed) return
    disposed = true
    for (const pet of pets.values()) {
      pet.animator.dispose()
      disposeAvatarSkeletons(pet.model)
      pet.group.removeFromParent()
    }
    pets.clear()
    residentRecords.clear()
    root.removeFromParent()
    for (const { source } of templates.values()) {
      disposeAvatarSkeletons(source)
      disposeModel(source)
    }
    templates.clear()
  }

  return {
    setModel, setRecords, setPlayerPosition, repositionNearVilla, repositionBlocked, applyRecordById, command, interact, relief, clearWaste, clearSelection, update, getPet, getPets, dispose,
    get root() { return root }
  }
}

module.exports = { createManorPetManager }
