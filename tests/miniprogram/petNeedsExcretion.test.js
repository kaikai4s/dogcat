const test = require('node:test')
const assert = require('node:assert/strict')
const {
  NEEDS,
  sampleNeeds,
  settleNeeds,
  relieveWaste,
  needsView
} = require('../../miniprogram/packagePlayground/utils/pet-needs')
const {
  isOutsideYard,
  triggerRelief,
  updatePetExcretion,
  drawSingleDecal,
  drawVehicleStains
} = require('../../miniprogram/packagePlayground/utils/excretion-system')
const {
  EXCRETION_ASSETS,
  getExcretionAsset,
  setExcretionAsset
} = require('../../miniprogram/packagePlayground/utils/excretion-assets')
const { World2D } = require('../../miniprogram/packagePlayground/utils/world2d')

test('1. pet needs model correctly accumulates and relieves pee and poop values', () => {
  const stamp = 10000000
  const pet = {
    needs: {
      at: stamp,
      energy: 100,
      satiety: 100,
      hydration: 100,
      pee: 0,
      poop: 0
    }
  }

  // 1 hour later: pee should grow by 22.22, poop by 11.11
  const afterOneHour = sampleNeeds(pet, stamp + 3600000)
  assert.equal(Math.round(afterOneHour.pee), 22)
  assert.equal(Math.round(afterOneHour.poop), 11)

  // 4.5 hours later: pee should be around 100
  const afterPeeFull = sampleNeeds(pet, stamp + 4.5 * 3600000)
  assert.equal(Math.round(afterPeeFull.pee), 100)

  // 9 hours later: poop should reach 100
  const afterPoopFull = sampleNeeds(pet, stamp + 9 * 3600000)
  assert.equal(Math.round(afterPoopFull.poop), 100)

  // Test relief deductions: pee -20, poop -40
  settleNeeds(pet, stamp + 4.5 * 3600000)
  assert.equal(Math.round(pet.needs.pee), 100)
  relieveWaste(pet, 'pee', 20, stamp + 4.5 * 3600000)
  assert.equal(Math.round(pet.needs.pee), 80)

  relieveWaste(pet, 'poop', 40, stamp + 4.5 * 3600000)
  assert.ok(pet.needs.poop >= 0)

  // Verify needsView displays 5 items with correct urgent/low warnings
  const views = needsView(pet, stamp + 4.5 * 3600000)
  assert.equal(views.length, 5)
  const peeView = views.find((v) => v.key === 'pee')
  const poopView = views.find((v) => v.key === 'poop')
  assert.ok(peeView)
  assert.equal(peeView.label, '嘘嘘')
  assert.equal(peeView.low, true) // pee >= 80 triggers low warning
  assert.ok(poopView)
  assert.equal(poopView.label, '便便')
})

test('2. yard boundary correctly determines inside vs outside positions', () => {
  const plot = { x: 100, z: 100, size: 56 }
  // Inside the yard (center is 100, 100, radius is 28)
  assert.equal(isOutsideYard({ x: 100, z: 100 }, plot), false)
  assert.equal(isOutsideYard({ x: 120, z: 110 }, plot), false)
  // Outside the yard
  assert.equal(isOutsideYard({ x: 135, z: 100 }, plot), true)
  assert.equal(isOutsideYard({ x: 100, z: 65 }, plot), true)
  // When no plot is assigned, default to outside
  assert.equal(isOutsideYard({ x: 100, z: 100 }, null), true)
})

test('3. burst rule: pet relieves immediately when pee or poop reaches 100 even inside yard', () => {
  const plot = { x: 100, z: 100, size: 56 }
  const groundDecals = []
  const statuses = []
  const pet = {
    name: '旺财',
    position: { x: 100, z: 100 }, // Inside yard
    needs: { at: 1000, pee: 0, poop: 100 },
    moving: true,
    route: [{ x: 102, z: 100 }]
  }

  const context = {
    now: 1000,
    ownPlot: plot,
    vehicles: new Map(),
    groundDecals,
    onStatus: (msg) => statuses.push(msg)
  }

  updatePetExcretion(pet, 0.1, context)

  // Relief should trigger immediately
  assert.ok(pet.relieving)
  assert.equal(pet.relieving.type, 'poop')
  assert.equal(pet.relieving.until, 4000) // 3000ms standstill
  assert.equal(pet.moving, false)
  assert.equal(pet.route.length, 0)
  assert.equal(pet.needs.poop, 60) // Reduced by 40
  assert.equal(groundDecals.length, 1)
  assert.equal(groundDecals[0].type, 'poop')
  assert.ok(statuses[0].includes('憋不住了'))

  // During 3-second standstill, pet cannot move
  pet.moving = true
  pet.route = [{ x: 105, z: 100 }]
  updatePetExcretion(pet, 0.1, { ...context, now: 2500 })
  assert.equal(pet.moving, false)
  assert.equal(pet.route.length, 0)

  // After 3 seconds, relieving state is cleared
  updatePetExcretion(pet, 0.1, { ...context, now: 4001 })
  assert.equal(pet.relieving, null)
})

test('4. outside yard rules: poop triggers after 2 minutes when value >= 40', () => {
  const plot = { x: 100, z: 100, size: 56 }
  const groundDecals = []
  const pet = {
    name: '咪咪',
    position: { x: 200, z: 200 }, // Outside yard
    needs: { at: 1000, pee: 0, poop: 45 },
    moving: false,
    route: []
  }

  const context = {
    now: 1000,
    ownPlot: plot,
    vehicles: new Map(),
    groundDecals
  }

  // 1 minute outside (60 seconds): should NOT trigger yet
  updatePetExcretion(pet, 60, context)
  assert.ok(!pet.relieving)
  assert.equal(groundDecals.length, 0)

  // Another 60 seconds outside (total 120 seconds): triggers poop!
  updatePetExcretion(pet, 60, context)
  assert.ok(pet.relieving)
  assert.equal(pet.relieving.type, 'poop')
  assert.equal(pet.needs.poop, 5) // 45 - 40 = 5
  assert.equal(groundDecals.length, 1)
  assert.equal(pet.outsidePoopTimer, 0) // reset
})

test('5. outside yard rules: pee triggers randomly between 30 and 60 seconds when value >= 20', () => {
  const plot = { x: 100, z: 100, size: 56 }
  const groundDecals = []
  let mockRandomVal = 0.5 // 30 + 0.5 * 30 = 45 seconds cooldown
  const pet = {
    name: '阿黄',
    position: { x: 200, z: 200 }, // Outside yard
    needs: { at: 1000, pee: 30, poop: 0 },
    moving: false,
    route: []
  }

  const context = {
    now: 1000,
    ownPlot: plot,
    vehicles: new Map(),
    groundDecals,
    random: () => mockRandomVal
  }

  // First step initializes cooldown to 45s
  updatePetExcretion(pet, 10, context)
  assert.ok(!pet.relieving)
  assert.equal(Math.round(pet.nextPeeCooldown), 35)

  // Another 30s passes (elapsed 40s): still not triggered (5s remaining)
  updatePetExcretion(pet, 30, context)
  assert.ok(!pet.relieving)

  // Another 6s passes (elapsed 46s): triggers pee relief!
  updatePetExcretion(pet, 6, context)
  assert.ok(pet.relieving)
  assert.equal(pet.relieving.type, 'pee')
  assert.equal(pet.needs.pee, 10) // 30 - 20 = 10
  assert.equal(groundDecals.length, 1)
  assert.equal(groundDecals[0].type, 'pee')
})

test('6. relieving inside vehicle stains the car and cleanVehicle cleans it', () => {
  const car = {
    id: 'car_1',
    stains: [],
    soiled: false
  }
  const vehicles = new Map([['car_1', car]])
  const groundDecals = []
  const statuses = []
  const pet = {
    name: '可乐',
    position: { x: 200, z: 200 },
    ridingVehicleId: 'car_1',
    needs: { at: 1000, pee: 100, poop: 0 }
  }

  const context = {
    now: 1000,
    ownPlot: { x: 100, z: 100, size: 56 },
    vehicles,
    groundDecals,
    onStatus: (msg) => statuses.push(msg)
  }

  updatePetExcretion(pet, 0.1, context)

  // Stains should appear on the car, not on the ground
  assert.equal(groundDecals.length, 0)
  assert.equal(car.soiled, true)
  assert.equal(car.stains.length, 1)
  assert.equal(car.stains[0].type, 'pee')
  assert.ok(statuses[0].includes('车子脏了'))

  // Drawing vehicle stains works with canvas mock
  const drawOps = []
  const mockCtx = {
    save: () => drawOps.push('save'),
    restore: () => drawOps.push('restore'),
    translate: (x, y) => drawOps.push(`translate:${x},${y}`),
    beginPath: () => drawOps.push('beginPath'),
    ellipse: () => drawOps.push('ellipse'),
    arc: () => drawOps.push('arc'),
    fill: () => drawOps.push('fill'),
    drawImage: () => drawOps.push('drawImage')
  }
  drawVehicleStains(mockCtx, car.stains, 50, null)
  assert.ok(drawOps.includes('fill'))

  // Clean vehicle resets soiled state
  const { cleanVehicle } = require('../../miniprogram/packagePlayground/utils/vehicle-world')
  const host = {
    ownVehicle: () => car,
    onStatus: (msg) => statuses.push(msg),
    emitVehicleUi: () => {}
  }
  cleanVehicle.call(host)
  assert.equal(car.soiled, false)
  assert.equal(car.stains.length, 0)
})

test('7. excretion assets configuration and custom paths', () => {
  const peeAsset = getExcretionAsset('pee')
  assert.ok(peeAsset)
  assert.equal(peeAsset.key, 'pee')

  setExcretionAsset('pee', 'cloud://my-env/assets/my-pee.png')
  assert.equal(peeAsset.fileID, 'cloud://my-env/assets/my-pee.png')

  setExcretionAsset('poop', '/packagePlayground/assets/custom-poop.png')
  const poopAsset = getExcretionAsset('poop')
  assert.equal(poopAsset.localPath, '/packagePlayground/assets/custom-poop.png')
})

test('8. poop pickup near interaction, ground removal, and farm warehouse inventory', async () => {
  const records = []
  const page = {
    setData(data) {},
    fetchRegion: async () => ({ plots: [] }),
    recordPoopPickup: async () => {
      records.push('picked')
    }
  }
  const w = new World2D(page, () => {}, {
    world: { width: 1120, height: 1120 },
    scene: { position: { x: 100, z: 100 }, serverTime: Date.now() },
    pets: []
  })
  w.buildWorld()
  w.character = { position: { x: 100, z: 100 } }
  await w.prepareCharacterArea()
  w.groundDecals = [
    { id: 'poop_1', type: 'poop', x: 102, z: 100 },
    { id: 'poop_far', type: 'poop', x: 120, z: 100 },
    { id: 'pee_1', type: 'pee', x: 101, z: 100 }
  ]

  // Nearby check detects poop_1 (distance 2 <= 3.8)
  const nearby = w.nearbyInteractions()
  assert.ok(nearby.poop)
  assert.equal(nearby.poop.id, 'poop_1')

  // Far pickup fails
  const farResult = await w.pickupPoop('poop_far')
  assert.equal(farResult, false)
  assert.equal(w.groundDecals.length, 3)

  // Near pickup succeeds
  const success = await w.pickupPoop('poop_1')
  assert.equal(success, true)
  assert.equal(w.groundDecals.find((d) => d.id === 'poop_1'), undefined)
  assert.equal(records.length, 1)
})

test('9. pets in yard autonomously eat from food bowl', async () => {
  const mine = { id: 'yard_1', x: 300, z: 300, size: 112, mine: true }
  let statusMsg = ''
  const page = {
    setData() {},
    fetchRegion: async () => ({ plots: [] })
  }
  const w = new World2D(page, () => {}, {
    world: { width: 1120, height: 1120 },
    plot: mine,
    pets: [{ _id: 'cat_1', name: '花花', species: 'cat' }]
  })
  w.buildWorld()
  w.onStatus = (msg) => { statusMsg = msg }
  w.foodBowls = { cat: 50, dog: 50 }

  const pet = w.pets[0]
  pet.position = { x: 300, z: 330 }
  pet.needs = { satiety: 40, hydration: 90 } // Hungry
  pet.lastCareActionAt = 0
  w.elapsed = 100

  // Plan roam triggers autonomous eating path
  await w.planRoam(pet)
  assert.equal(pet.pendingAutonomousCare, 'eat')
  assert.equal(pet.moving, true)
  assert.ok(pet.route.length > 0)

  // Simulate reaching destination
  pet.route = [{ x: pet.position.x + 0.001, z: pet.position.z }]
  w.update(0.1)

  // Reached! Bowl food consumed, satiety restored, autonomousAction set
  assert.equal(w.foodBowls.cat, 40) // 50 - 10
  assert.equal(pet.needs.satiety, 65) // 40 + 25
  assert.ok(pet.autonomousAction)
  assert.equal(pet.autonomousAction.type, 'eat')
  assert.ok(statusMsg.includes('正在碗边香喷喷地进食'))

  // life-world petActivity returns eating status
  const { petActivity } = require('../../miniprogram/packagePlayground/utils/life-world')
  const host = { elapsed: w.elapsed, serverOffset: 0 }
  const act = petActivity.call(host, pet)
  assert.equal(act, '正在碗边进食')
})

test('10. pets in yard autonomously drink from fountain when thirsty', async () => {
  const mine = { id: 'yard_1', x: 300, z: 300, size: 112, mine: true }
  let statusMsg = ''
  const page = {
    setData() {},
    fetchRegion: async () => ({ plots: [] })
  }
  const w = new World2D(page, () => {}, {
    world: { width: 1120, height: 1120 },
    plot: mine,
    pets: [{ _id: 'dog_1', name: '小白', species: 'dog' }]
  })
  w.buildWorld()
  w.onStatus = (msg) => { statusMsg = msg }
  w.foodBowls = { cat: 50, dog: 0 } // No food, but thirsty

  const pet = w.pets[0]
  pet.position = { x: 320, z: 330 }
  pet.needs = { satiety: 90, hydration: 50 } // Thirsty
  pet.lastCareActionAt = 0
  w.elapsed = 100

  // Plan roam triggers autonomous drinking path
  await w.planRoam(pet)
  assert.equal(pet.pendingAutonomousCare, 'drink')
  assert.equal(pet.moving, true)

  // Simulate reaching destination
  pet.route = [{ x: pet.position.x + 0.001, z: pet.position.z }]
  w.update(0.1)

  // Reached! hydration restored, autonomousAction set
  assert.equal(pet.needs.hydration, 80) // 50 + 30
  assert.ok(pet.autonomousAction)
  assert.equal(pet.autonomousAction.type, 'drink')
  assert.ok(statusMsg.includes('正在喷泉边饮水'))

  const { petActivity } = require('../../miniprogram/packagePlayground/utils/life-world')
  const host = { elapsed: w.elapsed, serverOffset: 0 }
  const act = petActivity.call(host, pet)
  assert.equal(act, '正在喷泉饮水')
})

