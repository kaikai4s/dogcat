const assert = require('node:assert/strict')
const test = require('node:test')
const { THREE } = require('../../miniprogram/packageManor3d/vendor/three-runtime')
const { createManorVehicle } = require('../../miniprogram/packageManor3d/utils/manor-vehicle')

function setup(sample = () => 0, saved) {
  const scene = new THREE.Scene()
  const model = new THREE.Group()
  for (const name of ['Door_L', 'Door_R', 'Spin_FL', 'Spin_FR', 'Spin_RL', 'Spin_RR',
    'Steer_FL', 'Steer_FR', 'Steering_Wheel']) {
    const node = new THREE.Group()
    node.name = name
    model.add(node)
  }
  const motions = []
  const player = {
    position: new THREE.Vector3(),
    height: 1.8,
    setInput() {},
    updateTransport(dt, x, y, z, yaw, motion) {
      this.position.set(x, y, z)
      motions.push(motion)
    }
  }
  let disposed
  const vehicle = createManorVehicle({
    THREE, model, scene, player, sample, spawn: { x: 0, y: 0, z: 0 }, saved,
    disposeModel: value => { disposed = value }, onMove() {}
  })
  const node = name => model.getObjectByName(name)
  const tick = frames => { for (let i = 0; i < frames; i++) vehicle.update(.04) }
  return { vehicle, node, model, player, motions, tick, wasDisposed: () => disposed === model }
}

test('Copper GT reserves the selected seat and uses the matching door through boarding and exit', () => {
  for (const [seat, door, other] of [['driver', 'Door_L', 'Door_R'], ['passenger', 'Door_R', 'Door_L']]) {
    const { vehicle, node, model, player, motions, tick, wasDisposed } = setup()
    assert.ok(vehicle.state().nearby)
    assert.ok(vehicle.enter(seat))
    assert.ok(!vehicle.enter(seat))
    assert.deepEqual(vehicle.state().seats.filter(value => value.occupied).map(value => value.id), [seat])
    let swing = 0
    for (let i = 0; i < 180; i++) {
      tick(1)
      swing = Math.max(swing, Math.abs(node(door).rotation.y))
      assert.equal(node(other).rotation.y, 0)
    }
    assert.ok(swing > 1)
    assert.equal(node(door).rotation.y, 0)
    assert.equal(vehicle.state().mode, seat)
    assert.ok(motions.some(motion => motion === true))
    assert.ok(motions.some(motion => motion?.action === 'board'))
    assert.ok(motions.some(motion => motion?.action === (seat === 'driver' ? 'drive' : 'seated')))
    assert.ok(vehicle.viewpoint(1.6).y > 1)
    assert.ok(vehicle.exit())
    tick(60)
    assert.equal(vehicle.state().mode, 'walking')
    assert.ok(vehicle.state().seats.every(value => !value.occupied))
    assert.ok(!vehicle.blocks(player.position.x, player.position.z))
    assert.ok(motions.some(motion => motion?.action === 'exit'))
    assert.equal(node(door).rotation.y, 0)
    vehicle.dispose()
    assert.equal(model.parent, null)
    assert.ok(wasDisposed())
  }
})

test('driver can steer and brake while the vehicle footprint stops at unwalkable ground', () => {
  const { vehicle, model, node, tick } = setup((x, z) => x < 10 && Math.abs(z) < 20 ? 0 : null)
  assert.ok(vehicle.enter('driver'))
  tick(180)
  const anchor = model.parent
  const start = anchor.position.clone()
  vehicle.setInput(.8, -1)
  tick(12)
  assert.ok(vehicle.state().speed > 0)
  assert.ok(anchor.position.distanceTo(start) > .3)
  assert.ok(node('Steer_FL').rotation.y < 0)
  assert.ok(node('Spin_FL').rotation.x !== 0)
  assert.equal(vehicle.exit(), false)
  vehicle.brake()
  tick(24)
  assert.equal(vehicle.state().speed, 0)
  vehicle.setInput(0, -1)
  tick(180)
  assert.equal(vehicle.state().speed, 0)
  assert.ok(anchor.position.x > start.x + 2 && anchor.position.x < 10)
})

test('the owner vehicle restores its saved coordinates and reports a syncable pose', () => {
  const saved = { position3d: { x: 42, y: 18, z: -36 }, yaw: 1.25 }
  const { vehicle, model } = setup(() => 4.1, saved)
  const anchor = model.parent
  let state = vehicle.syncState()
  assert.equal(state.position3d.x, 42)
  assert.ok(Math.abs(state.position3d.y - 4.1) < 1e-9)
  assert.equal(state.position3d.z, -36)
  assert.equal(state.yaw, 1.25)
  assert.equal(state.moving, false)

  assert.equal(vehicle.restore({ position3d: { x: 60, y: 2, z: -20 }, yaw: -0.5 }), true)
  state = vehicle.syncState()
  assert.equal(state.position3d.x, 60)
  assert.ok(Math.abs(state.position3d.y - 4.1) < 1e-9)
  assert.equal(state.position3d.z, -20)
  assert.equal(state.yaw, -0.5)
  assert.equal(state.moving, false)
  assert.equal(anchor.position.x, 60)
  vehicle.dispose()
})
