const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE } = require('../../miniprogram/packageManor3d/vendor/three-runtime')
const { createManorPetManager } = require('../../miniprogram/packageManor3d/utils/manor-pets')

function model() {
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, .7, 1), new THREE.MeshBasicMaterial())
  body.name = 'Body'
  const root = new THREE.Group().add(body)
  root.animations = ['idle', 'walk', 'run', 'happy', 'need_toilet', 'poop', 'pee', 'eat', 'drink', 'sleep'].map(name =>
    new THREE.AnimationClip(name, .4, [new THREE.NumberKeyframeTrack('Body.rotation[x]', [0, .4], [0, 0])]))
  return root
}

function fixture({ villaBounds, getVillaBounds } = {}) {
  const scene = new THREE.Scene()
  const bounds = villaBounds || new THREE.Box3(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 2, 3))
  const nav = {
    sample: (x, z) => ({ x, y: 0, z }) && 0,
    nearestWalkable: (x, z) => ({ x, y: 0, z }),
    spawn: () => ({ x: 0, y: 0, z: 0 })
  }
  const disposed = []
  const pets = createManorPetManager({ THREE, scene, getNavigation: () => nav,
    getOutdoorBounds: () => null, getVillaBounds: getVillaBounds || (() => bounds),
    disposeModel: value => disposed.push(value) })
  return { pets, disposed }
}

test('resident records create pets near the villa and expose UI state', () => {
  const { pets } = fixture()
  pets.setModel('dog', model())
  pets.setRecords([{ kind: 'resident', id: 'resident_1', ownerId: 'owner_1', mine: true,
    pets: [{ id: 'pet_1', name: '豆豆', species: 'dog', needs: { energy: 88, satiety: 70, hydration: 80 } }] }])
  const pet = pets.getPet('pet_1')
  assert.ok(pet)
  assert.equal(pet.group.userData.name, '豆豆')
  assert.ok(Math.abs(pet.group.position.x) > 0 || Math.abs(pet.group.position.z) > 0)
  assert.equal(pets.getPets().length, 1)
  pets.dispose()
})

test('follow and 3D motion records update the pet actor', () => {
  const { pets } = fixture()
  pets.setModel('cat', model())
  pets.setRecords([{ kind: 'resident', id: 'resident_2', ownerId: 'owner_2', mine: true,
    pets: [{ id: 'pet_2', name: '团团', species: 'cat', manor3dPosition: { x: 1, y: 0, z: 1 },
      manor3dMotion: { approach: [{ x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 1 }], speed: 1.2 } }] }])
  const pet = pets.getPet('pet_2')
  assert.equal(pet.group.position.x, 1)
  assert.equal(pet.moving, true)
  assert.equal(pets.command('pet_2', 'follow'), true)
  assert.equal(pet.following, true)
  pets.setPlayerPosition({ x: 4, y: 0, z: 4 })
  pets.update(.1)
  assert.ok(pet.group.position.distanceTo(new THREE.Vector3(1, 0, 1)) > 0)
  pets.dispose()
})

test('resident pets spawn beside their own villa even when 2D motion is present', () => {
  const villas = new Map([
    ['owner_1', new THREE.Box3(new THREE.Vector3(-43, 0, -3), new THREE.Vector3(-37, 2, 3))],
    ['owner_2', new THREE.Box3(new THREE.Vector3(37, 0, -3), new THREE.Vector3(43, 2, 3))]
  ])
  const { pets } = fixture({ getVillaBounds: ownerId => villas.get(ownerId) || null })
  pets.setModel('dog', model())
  pets.setRecords([
    { kind: 'resident', id: 'resident_1', ownerId: 'owner_1', mine: true,
      pets: [{ id: 'pet_1', species: 'dog', manor3dMotion: { approach: [{ x: 0, z: 0 }, { x: 5, z: 0 }], speed: 3 } }] },
    { kind: 'resident', id: 'resident_2', ownerId: 'owner_2', mine: false,
      pets: [{ id: 'pet_2', species: 'dog', manor3dMotion: { approach: [{ x: 0, z: 0 }, { x: 5, z: 0 }], speed: 3 } }] }
  ])
  assert.ok(pets.getPet('pet_1').group.position.x < -30)
  assert.ok(pets.getPet('pet_2').group.position.x > 30)
  pets.dispose()
})

test('a neighbor pet follows its owner route instead of the viewer', () => {
  const { pets } = fixture()
  pets.setModel('dog', model())
  pets.setRecords([{ kind: 'resident', id: 'resident_2', ownerId: 'owner_2', mine: false,
    pets: [{ id: 'pet_2', species: 'dog', following: true, manor3dPosition: { x: 0, y: 0, z: 0 },
      manor3dMotion: { epoch: Date.now(), approach: [{ x: 0, z: 0 }, { x: 4, z: 0 }], speed: 1 } }] }])
  pets.setPlayerPosition({ x: 40, y: 0, z: 40 })
  for (let frame = 0; frame < 50; frame++) pets.update(.1)
  assert.ok(pets.getPet('pet_2').group.position.x < 10)
  assert.ok(pets.getPet('pet_2').group.position.z < 2)
  pets.dispose()
})

test('unchanged server routes do not reset local progress and care starts only on arrival', () => {
  const { pets } = fixture()
  pets.setModel('dog', model())
  const record = { kind: 'resident', id: 'resident_1', ownerId: 'owner_1', mine: true,
    pets: [{ id: 'pet_1', species: 'dog', manor3dPosition: { x: 0, y: 0, z: 0 },
      care: { type: 'eat', startsAt: Date.now() + 5000, endsAt: Date.now() + 10000 },
      manor3dMotion: { epoch: Date.now(), approach: [{ x: 0, z: 0 }, { x: 8, z: 0 }], speed: 1 } }] }
  pets.setRecords([record])
  const pet = pets.getPet('pet_1')
  pets.update(.1)
  const progressed = pet.group.position.x
  assert.equal(pet.action, 'walk')
  pets.setRecords([record], { replace: false })
  pets.update(.1)
  assert.ok(pet.group.position.x > progressed)
  pet.care.startsAt = Date.now() - 1
  pets.update(.1)
  assert.equal(pet.moving, false)
  assert.equal(pet.action, 'eat')
  pets.dispose()
})

test('clearing one pet waste event preserves its other events', () => {
  const { pets } = fixture()
  pets.setModel('dog', model())
  pets.setRecords([{ kind: 'resident', id: 'resident_1', ownerId: 'owner_1', mine: true,
    pets: [{ id: 'pet_1', species: 'dog', waste: [
      { id: 'poop_1', type: 'poop' }, { id: 'pee_1', type: 'pee' }, { id: 'poop_2', type: 'poop' }
    ] }] }])

  assert.equal(pets.clearWaste('pet_1', 'poop_1'), true)
  assert.deepEqual(pets.getPet('pet_1').record.waste.map(item => item.id), ['pee_1', 'poop_2'])
  assert.equal(pets.clearWaste('pet_1', 'missing'), false)
  pets.dispose()
})

test('a care command preserves the current route until the server confirms arrival timing', () => {
  const { pets } = fixture()
  pets.setModel('dog', model())
  pets.setRecords([{ kind: 'resident', id: 'resident_1', ownerId: 'owner_1', mine: true,
    pets: [{ id: 'pet_1', species: 'dog', manor3dPosition: { x: 0, y: 0, z: 0 },
      manor3dMotion: { epoch: Date.now(), approach: [{ x: 0, z: 0 }, { x: 10, z: 0 }], speed: 1 } }] }])
  const pet = pets.getPet('pet_1')
  assert.equal(pet.moving, true)

  pets.command('pet_1', 'eat')
  assert.equal(pet.moving, true)
  assert.deepEqual(pet.route.map(point => point.x), [0, 10])
  pets.dispose()
})

