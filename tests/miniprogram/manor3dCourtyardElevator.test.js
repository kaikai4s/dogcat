const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE } = require('../../miniprogram/packageManor3d/utils/model-runtime')
const { createCourtyardElevator } = require('../../miniprogram/packageManor3d/utils/manor-courtyard-elevator')

function fixture() {
  const model = new THREE.Group(), plot = new THREE.Group(), car = new THREE.Group()
  plot.position.set(34, .62, -17)
  plot.scale.set(.9, 1.2, .9)
  plot.rotation.y = Math.PI / 2
  plot.add(model)
  model.position.set(-8, 0, -10.5)
  car.name = 'LiftCar'
  car.position.set(9.75, .22, 1.5)
  model.add(car)
  const track = (node, from, to, duration) => new THREE.VectorKeyframeTrack(node.name + '.position',
    [0, duration / 2, duration], [...from, ...from.map((value, i) => value + (to[i] - value) * .3), ...to])
  const elevations = [.22, 3.82, 7.12]
  const doors = elevations.map((y, i) => {
    const closed = [.966, 1.531], open = [.379, 2.118]
    const leaves = closed.map((z, j) => {
      const node = new THREE.Group()
      node.name = 'E' + (i + 1) + '_Slide_' + (j + 1)
      node.position.set(8.67, y, z)
      model.add(node)
      return node
    })
    for (const [action, from, to] of [['Open', closed, open], ['Close', open, closed]]) {
      model.animations.push(new THREE.AnimationClip('E' + (i + 1) + '_' + action, 1,
        leaves.map((node, j) => track(node, [8.67, y, from[j]], [8.67, y, to[j]], 1))))
    }
    return { leaves, closed, open }
  })
  for (let from = 0; from < elevations.length; from++) {
    for (let to = 0; to < elevations.length; to++) {
      if (from === to) continue
      model.animations.push(new THREE.AnimationClip('Lift_F' + (from + 1) + '_to_F' + (to + 1), 2,
        [track(car, [9.75, elevations[from], 1.5], [9.75, elevations[to], 1.5], 2)]))
    }
  }
  const point = (x, y, z) => model.localToWorld(new THREE.Vector3(x, y, z))
  const landings = elevations.map((y, i) => ({ level: i + 1, approach: point(8.12, y, 1.525),
    cabin: point(9.7, y, 1.525), yaw: Math.PI }))
  const local = new THREE.Vector3()
  function sample(x, z, _bounds, y) {
    model.worldToLocal(local.set(x, y, z))
    if (local.x >= 8.45) return null
    const floor = landings.find(landing => Math.abs(landing.approach.y - y) < .2)
    return floor?.approach.y ?? null
  }
  const navigation = { sample, sampleMove: (x, z, from) => sample(x, z, null, from.y) }
  const player = { position: landings[0].approach.clone(), setInput(x, y) { this.input = [x, y] },
    updateTransport(_dt, x, y, z) { this.position.set(x, y, z) } }
  const elevator = createCourtyardElevator({ THREE, model, navigation, landings })
  return { model, car, doors, landings, player, elevator, navigation, point }
}

const near = (a, b) => Math.abs(a - b) < 1e-6

test('the courtyard lift moves a rider between every pair of floors in a rotated plot', () => {
  const { model, car, doors, landings, player, elevator, navigation } = fixture()
  const neighbor = model.clone(true).getObjectByName('LiftCar')
  const offset = landings[0].cabin.clone().sub(car.getWorldPosition(new THREE.Vector3()))
  const worldCar = new THREE.Vector3()
  let floor = 1
  for (const to of [3, 1, 2, 3, 2, 1]) {
    const from = floor
    assert.deepEqual(elevator.state(player.position), { phase: 'ready', floor: from,
      targetFloor: from === 3 ? 2 : from + 1, destinations: [1, 2, 3].filter(i => i !== from), busy: false })
    assert.equal(elevator.start(player, from), false)
    assert.equal(elevator.start(player, 4), false)
    assert.equal(elevator.start(player, to), true)
    assert.equal(elevator.start(player, to), false)
    assert.deepEqual(player.input, [0, 0])
    const opened = new Set(), heights = new Set()
    for (let frame = 0; frame < 200 && elevator.busy; frame++) {
      elevator.update(.05)
      const state = elevator.state(player.position)
      doors.forEach(({ leaves, closed, open }, i) => {
        if (leaves.every((leaf, j) => near(leaf.position.z, open[j]))) opened.add(i + 1)
        if (state?.phase === 'riding' || ![from, to].includes(i + 1)) {
          assert.ok(leaves.every((leaf, j) => near(leaf.position.z, closed[j])), 'other floors stay closed')
        }
      })
      if (elevator.carrying) {
        car.getWorldPosition(worldCar).add(offset)
        assert.ok(player.position.distanceTo(worldCar) < 1e-6, 'the rider follows the animated car')
        const safe = elevator.checkpoint(player.position)
        assert.equal(navigation.sample(safe.x, safe.z, null, safe.y), safe.y)
        assert.ok([from, to].some(i => safe.y === landings[i - 1].approach.y))
        heights.add(player.position.y)
      }
    }
    assert.equal(elevator.busy, false)
    assert.ok(heights.size > 10)
    assert.deepEqual([...opened], [from, to])
    assert.ok(player.position.distanceTo(landings[to - 1].approach) < 1e-8)
    assert.equal(elevator.checkpoint(player.position), null)
    assert.equal(neighbor.position.y, .22, 'another courtyard keeps its own cabin position')
    floor = to
  }
})

test('calling an empty lift keeps the player on the landing and removing it restores the model', () => {
  const { car, doors, landings, player, elevator, point } = fixture()
  const upper = landings[2].approach
  player.position.copy(point(6.2, 7.12, 1.525))
  assert.equal(elevator.state(player.position), null)
  assert.equal(elevator.start(player, 2), false)
  player.position.copy(upper)
  assert.deepEqual(elevator.state(player.position), { phase: 'call', floor: 3,
    targetFloor: 2, destinations: [1, 2], busy: false })
  assert.equal(elevator.start(player, 2), true)
  elevator.update(.8)
  assert.equal(elevator.state(player.position).phase, 'calling')
  assert.ok(car.position.y > .22)
  assert.deepEqual(player.position, upper)
  assert.deepEqual(elevator.checkpoint(player.position), { x: upper.x, y: upper.y, z: upper.z })
  elevator.update(1.6)
  assert.equal(elevator.state(player.position).phase, 'boarding')
  assert.ok(near(car.position.y, 7.12))
  assert.notEqual(doors[2].leaves[0].position.z, doors[2].closed[0])
  elevator.dispose()
  assert.equal(elevator.busy, false)
  assert.equal(elevator.state(player.position), null)
  assert.equal(elevator.start(player, 2), false)
  assert.equal(car.position.y, .22)
  assert.deepEqual(doors[2].leaves.map(leaf => leaf.position.z), doors[2].closed)
})
