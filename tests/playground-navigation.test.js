const test = require('node:test')
const assert = require('node:assert/strict')
const { createNavigation } = require('../miniprogram/packagePlayground/utils/navigation')
const { PetBehavior } = require('../miniprogram/packagePlayground/utils/pet-behavior')

test('navigation routes around blocked cottage', () => {
  const nav = createNavigation({ minX: -4, maxX: 4, minZ: -4, maxZ: 4 }, [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }], 0.4, 0.4)
  const route = nav.path({ x: -3, z: 0 }, { x: 3, z: 0 })
  assert.ok(route && route.length > 2)
  for (const p of route) {
    assert.ok(!(p.x >= -1.4 && p.x <= 1.4 && p.z >= -1.4 && p.z <= 1.4), `route point inside inflated obstacle: ${JSON.stringify(p)}`)
  }
})

test('pet moves to bowl before eating', () => {
  const nav = createNavigation({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, [], 0.5, 0.5)
  const station = { point: { x: 2, z: 1 }, heading: Math.PI }
  const pet = new PetBehavior(nav, { eat: station }, { x: -2, z: -1 })
  assert.equal(pet.request('eat'), true)
  assert.equal(pet.phase, 'moving')
  for (let i = 0; i < 120 && pet.phase === 'moving'; i += 1) pet.update(0.1)
  assert.equal(pet.phase, 'acting')
  assert.equal(pet.action, 'eat')
  assert.ok(Math.hypot(pet.position.x - 2, pet.position.z - 1) < 0.2)
})

test('unreachable target is rejected', () => {
  const nav = createNavigation({ minX: -2, maxX: 2, minZ: -2, maxZ: 2 }, [{ minX: 0.5, maxX: 1.5, minZ: 0.5, maxZ: 1.5 }], 0.5, 0.5)
  const pet = new PetBehavior(nav, { drink: { point: { x: 1, z: 1 }, heading: 0 } }, { x: -1, z: -1 })
  assert.equal(pet.request('drink'), false)
})

test('occupied station rejects another pet', () => {
  const nav = createNavigation({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, [], 0.5, 0.5)
  const station = { point: { x: 2, z: 1 }, heading: Math.PI }
  const first = new PetBehavior(nav, { eat: station }, { x: -2, z: -1 })
  const second = new PetBehavior(nav, { eat: station }, { x: -2, z: 1 })
  assert.equal(first.request('eat'), true)
  assert.equal(second.request('eat'), false)
  first.release()
  assert.equal(second.request('eat'), true)
})

test('pet rests after reaching sleep station', () => {
  const nav = createNavigation({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, [], 0.5, 0.5)
  const pet = new PetBehavior(nav, { rest: { point: { x: 1, z: 1 }, heading: 0 } }, { x: -1, z: -1 })
  pet.energy = 20
  assert.equal(pet.request('rest'), true)
  for (let i = 0; i < 120 && pet.phase === 'moving'; i += 1) pet.update(0.1)
  assert.equal(pet.phase, 'acting')
  assert.equal(pet.action, 'rest')
  const energy = pet.energy
  pet.update(1)
  assert.ok(pet.energy > energy)
})

test('bowl obstacle does not block approach point', () => {
  const nav = createNavigation({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, [{ minX: -0.55, maxX: 0.55, minZ: -0.55, maxZ: 0.55 }], 0.5, 0.5)
  const pet = new PetBehavior(nav, { eat: { point: { x: 0, z: 1.48 }, heading: Math.PI } }, { x: -3, z: 2 })
  assert.equal(pet.request('eat'), true)
})
