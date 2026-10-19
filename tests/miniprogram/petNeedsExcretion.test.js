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

  setExcretionAsset('poop', 'cloud://my-env/assets/custom-poop.png')
  const poopAsset = getExcretionAsset('poop')
  assert.equal(poopAsset.fileID, 'cloud://my-env/assets/custom-poop.png')
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
  w.random = () => 0.9
  w.onStatus = (msg) => { statusMsg = msg }
  w.foodBowls = { cat: 50, dog: 50 }

  const pet = w.pets[0]
  pet.position = { x: 300, z: 330 }
  pet.needs = { satiety: 20, hydration: 90 } // Automatic care starts at 20
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
  assert.equal(pet.needs.satiety, 45) // 20 + 25
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
  w.random = () => 0.9
  w.onStatus = (msg) => { statusMsg = msg }
  w.foodBowls = { cat: 50, dog: 0 } // No food, but thirsty

  const pet = w.pets[0]
  pet.position = { x: 320, z: 330 }
  pet.needs = { satiety: 90, hydration: 20 } // Automatic care starts at 20
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
  assert.equal(pet.needs.hydration, 50) // 20 + 30
  assert.ok(pet.autonomousAction)
  assert.equal(pet.autonomousAction.type, 'drink')
  assert.ok(statusMsg.includes('正在喷泉边饮水'))

  const { petActivity } = require('../../miniprogram/packagePlayground/utils/life-world')
  const host = { elapsed: w.elapsed, serverOffset: 0 }
  const act = petActivity.call(host, pet)
  assert.equal(act, '正在喷泉饮水')
})

test('11. drawSingleDecal preserves aspect ratio and uses natural ground anchor', () => {
  const drawOps = []
  const mockCtx = {
    drawImage: (...args) => drawOps.push(args)
  }
  const customImg = { width: 100, height: 80 }
  // Test poop decal
  drawSingleDecal(mockCtx, { type: 'poop' }, { x: 50, y: 50 }, 10, customImg)
  assert.equal(drawOps.length, 1)
  const [img, dx, dy, dw, dh] = drawOps[0]
  assert.equal(dw, 10)
  assert.equal(dh, 8)
  assert.equal(dx, 45) // 50 - 10/2
  assert.equal(dy, 50 - 8 * 0.78)
})

test('12. empty food bowl does not restore satiety and informs user', async () => {
  const mine = { id: 'yard_1', x: 300, z: 300, size: 112, mine: true }
  let statusMsg = ''
  const page = { setData() {}, fetchRegion: async () => ({ plots: [] }) }
  const w = new World2D(page, () => {}, {
    world: { width: 1120, height: 1120 },
    plot: mine,
    pets: [{ _id: 'cat_1', name: '花花', species: 'cat' }]
  })
  w.buildWorld()
  w.onStatus = (msg) => { statusMsg = msg }
  w.foodBowls = { cat: 5, dog: 0 } // Less than 10
  const pet = w.pets[0]
  pet.position = { x: 300, z: 330 }
  pet.needs = { satiety: 30, hydration: 90 }
  pet.pendingAutonomousCare = 'eat'
  pet.moving = true
  pet.route = [{ x: pet.position.x + 0.001, z: pet.position.z }]

  w.update(0.1)

  // Satiety should NOT increase when bowl is empty/insufficient
  assert.equal(pet.needs.satiety, 30)
  assert.equal(w.foodBowls.cat, 5)
  assert.equal(pet.autonomousAction, undefined)
  assert.ok(statusMsg.includes('口粮吃光啦，等待添粮中'))
})

test('13. manual moveTo interrupts pending autonomous care and prevents ghost eating', async () => {
  const mine = { id: 'yard_1', x: 300, z: 300, size: 112, mine: true }
  let statusMsg = ''
  const page = { setData() {}, fetchRegion: async () => ({ plots: [] }) }
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
  pet.needs = { satiety: 30, hydration: 90 }
  pet.pendingAutonomousCare = 'eat'
  w.selectedPetId = pet.id

  // User manually moves pet to field
  await w.moveTo({ x: 350, z: 350 })
  assert.equal(pet.pendingAutonomousCare, null)

  // When arrival completes manual move, eating should not trigger
  pet.moving = true
  pet.route = [{ x: pet.position.x + 0.001, z: pet.position.z }]
  w.update(0.1)

  assert.equal(w.foodBowls.cat, 50)
  assert.equal(pet.needs.satiety, 30)
  assert.equal(pet.autonomousAction, undefined)
})

test('14. relief interruption clears pending autonomous care', () => {
  const pet = {
    name: '豆豆',
    position: { x: 300, z: 300 },
    needs: { pee: 100, poop: 10 },
    pendingAutonomousCare: 'eat'
  }
  const context = { now: 1000000 }
  triggerRelief(pet, 'pee', 20, context, 'burst')
  assert.equal(pet.pendingAutonomousCare, null)
  assert.ok(pet.relieving)
})

test('15. request drink navigates to fountain and completes drink action', async () => {
  const mine = { id: 'yard_1', x: 300, z: 300, size: 112, mine: true }
  let statusMsg = ''
  const page = { setData() {}, fetchRegion: async () => ({ plots: [] }) }
  const w = new World2D(page, () => {}, {
    world: { width: 1120, height: 1120 },
    plot: mine,
    pets: [{ _id: 'dog_1', name: '小白', species: 'dog' }]
  })
  w.buildWorld()
  w.onStatus = (msg) => { statusMsg = msg }
  const pet = w.pets[0]
  pet.position = { x: 300, z: 320 }
  pet.needs = { satiety: 90, hydration: 40 }
  w.selectedPetId = pet.id

  // Command to drink
  const requested = w.request('drink')
  assert.equal(requested, true)
  assert.equal(pet.pendingAutonomousCare, 'drink')

  // Simulate reaching fountain
  pet.moving = true
  pet.route = [{ x: pet.position.x + 0.001, z: pet.position.z }]
  w.update(0.1)

  assert.equal(pet.needs.hydration, 70) // 40 + 30
  assert.ok(pet.autonomousAction)
  assert.equal(pet.autonomousAction.type, 'drink')
  assert.ok(statusMsg.includes('正在喷泉边饮水'))
})

test('16. pickupPoop is blocked while driving and rolls back decals on record failure', async () => {
  let statusMsg = ''
  let shouldFail = false
  const page = {
    setData() {},
    fetchRegion: async () => ({ plots: [] }),
    recordPoopPickup: async () => {
      if (shouldFail) throw new Error('network timeout')
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
  w.onStatus = (msg) => { statusMsg = msg }
  w.groundDecals = [{ id: 'poop_1', type: 'poop', x: 101, z: 100 }]

  // 1. Blocked when driving
  w.drivingVehicleId = 'car_1'
  const drivePickup = await w.pickupPoop('poop_1')
  assert.equal(drivePickup, false)
  assert.equal(w.groundDecals.length, 1)
  assert.ok(statusMsg.includes('请先下车'))

  // 2. Rollback when recordPoopPickup throws
  w.drivingVehicleId = null
  shouldFail = true
  let thrown = false
  try {
    await w.pickupPoop('poop_1')
  } catch (err) {
    thrown = true
  }
  assert.equal(thrown, true)
  assert.equal(w.groundDecals.length, 1)
  assert.equal(w.groundDecals[0].id, 'poop_1')
})

test('17. isOutsideYard uses 112 standard yard size by default', () => {
  const plotWithoutSize = { x: 100, z: 100 }
  // At offset 40 (inside 56m half extent of 112m yard)
  const insidePos = { x: 140, z: 100 }
  assert.equal(isOutsideYard(insidePos, plotWithoutSize), false)

  // At offset 60 (outside 56m half extent)
  const outsidePos = { x: 160, z: 100 }
  assert.equal(isOutsideYard(outsidePos, plotWithoutSize), true)
})

test('18. frontend poop pickup concurrency lock prevents duplicate pickup of the same poop', async () => {
  let statusMsg = ''
  let pickupCalls = 0
  const page = {
    setData() {},
    fetchRegion: async () => ({ plots: [] }),
    recordPoopPickup: async () => {
      pickupCalls++
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
  w.onStatus = (msg) => { statusMsg = msg }
  w.groundDecals = [{ id: 'poop_unique_1', type: 'poop', x: 101, z: 100 }]

  // First pickup succeeds
  const first = await w.pickupPoop('poop_unique_1')
  assert.equal(first, true)
  assert.equal(pickupCalls, 1)

  // Concurrent/second pickup attempt with same id fails
  const second = await w.pickupPoop('poop_unique_1')
  assert.equal(second, false)
  assert.equal(pickupCalls, 1) // Did not trigger second backend call
})

test('19. relieved pet needs with fresher timestamp are preserved against stale remote needs', () => {
  const w = new World2D({ setData() {}, fetchRegion: async () => ({ plots: [] }) }, () => {}, {
    world: { width: 1120, height: 1120 },
    pets: [{ _id: 'cat_1', name: '花花', species: 'cat' }]
  })
  w.buildWorld()
  const pet = w.pets[0]
  pet.mine = true

  // Simulate local waste relief at t = 2000, poop reduced to 5
  pet.needs = { at: 2000, poop: 5, pee: 10, energy: 100, satiety: 100, hydration: 100 }

  // Stale remote packet arrives with t = 1000 and old poop = 80
  const staleRemotePet = {
    id: 'cat_1',
    name: '花花',
    species: 'cat',
    needs: { at: 1000, poop: 80, pee: 40, energy: 100, satiety: 100, hydration: 100 }
  }
  w.applySharedPet(staleRemotePet, true, '我', 'my_id')

  // Local fresh needs should NOT be overwritten by stale remote needs
  assert.equal(pet.needs.at, 2000)
  assert.equal(pet.needs.poop, 5)
})

test('20. pet care expiration automatically releases single-station sharedMotion back to roaming', () => {
  const w = new World2D({ setData() {}, fetchRegion: async () => ({ plots: [] }) }, () => {}, {
    world: { width: 1120, height: 1120 },
    pets: [{ _id: 'dog_1', name: '小白', species: 'dog' }]
  })
  w.buildWorld()
  const pet = w.pets[0]
  pet.mine = true
  pet.position = { x: 300, z: 300 }
  // Pet was drinking at fountain with single-station patrol
  pet.care = { type: 'drink', startsAt: 1000, endsAt: 2000 }
  pet.sharedMotion = { epoch: 1000, approach: [{ x: 300, z: 300 }], patrol: [{ x: 300, z: 300 }], speed: 7 }

  // At t = 1500 (still drinking)
  w.serverOffset = 1500 - Date.now()
  w.update(0.1)
  assert.ok(pet.sharedMotion)
  assert.ok(pet.care)

  // At t = 2500 (care expired)
  w.serverOffset = 2500 - Date.now()
  w.update(0.1)
  // SharedMotion released and pet returned to roaming state
  assert.equal(pet.sharedMotion, null)
  assert.equal(pet.care, null)
  assert.equal(pet.planning || pet.moving || pet.mode === 'roaming' || pet.idleSeconds === 0, true)
})

test('21. onRelief callback triggers when excretion occurs to notify backend', () => {
  const reliefs = []
  const pet = {
    id: 'dog_1',
    name: '旺财',
    position: { x: 100, z: 100 },
    needs: { at: 1000, pee: 0, poop: 100 }
  }
  const context = {
    now: 1000,
    ownPlot: { x: 100, z: 100, size: 56 },
    groundDecals: [],
    onRelief: (p, type, amount) => {
      reliefs.push({ id: p.id, type, amount })
    }
  }
  updatePetExcretion(pet, 0.1, context)
  assert.equal(reliefs.length, 1)
  assert.equal(reliefs[0].id, 'dog_1')
  assert.equal(reliefs[0].type, 'poop')
  assert.equal(reliefs[0].amount, 40)
})

test('22. newer remote packet without excretion relief does not overwrite lower local relieved values', () => {
  const w = new World2D({ setData() {}, fetchRegion: async () => ({ plots: [] }) }, () => {}, {
    world: { width: 1120, height: 1120 },
    pets: [{ _id: 'cat_1', name: '花花', species: 'cat' }]
  })
  w.buildWorld()
  const pet = w.pets[0]
  pet.mine = true

  // Local pet relieved poop at t = 1000, poop reduced to 60
  pet.needs = { at: 1000, poop: 60, pee: 20, energy: 80, satiety: 80, hydration: 80 }

  // Remote packet arrives at t = 1010 (10 seconds later, e.g. after remote drinking action)
  // Remote packet did not know about local poop relief and has poop = 100, hydration = 100
  const newerRemotePet = {
    id: 'cat_1',
    name: '花花',
    species: 'cat',
    needs: { at: 1010, poop: 100, pee: 50, energy: 80, satiety: 80, hydration: 100 }
  }
  w.applySharedPet(newerRemotePet, true, '我', 'my_id')

  // Remote hydration should be updated to 100
  assert.equal(pet.needs.hydration, 100)
  // But poop should remain around 60 (60 + tiny 10s increment), NOT reset to 100!
  assert.ok(pet.needs.poop < 65)
  assert.ok(pet.needs.poop >= 60)
})




