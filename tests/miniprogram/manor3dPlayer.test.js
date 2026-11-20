const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE } = require('../../miniprogram/packageManor3d/vendor/three-runtime')
const { createManorPlayer } = require('../../miniprogram/packageManor3d/utils/manor-player')

function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-5, actual + ' should be near ' + expected) }

function fixture({ legacy = false } = {}) {
  const model = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(.5, 1.6, .4), new THREE.MeshBasicMaterial())
  body.position.y = .7
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  model.add(body, hips)
  const clip = (name, duration, values) => new THREE.AnimationClip(name, duration, [
    new THREE.VectorKeyframeTrack('Hips.position', values.map((value, i) => i * duration / (values.length - 1)),
      values.flatMap(([y, z = 0]) => [0, y, z]))
  ])
  model.animations = [
    clip('Idle', 1, [[.8], [.8]]), clip('Walk', 1, [[.78], [.78]]), clip('Run', 1, [[.75], [.75]]),
    clip('Sit_Down', 1.05, [[.8, .19], [.48]]), clip(legacy ? 'sit_idle' : 'Sit', 2, [[.48], [.48]]),
    clip('Lie_Down', 1.82, [[.8], [.17, -.148]]), clip(legacy ? 'lie_idle' : 'Lie', 2, [[.17, -.148], [.17, -.148]])
  ]
  if (legacy) model.animations.push(clip('stand_up', 1.4, [[.48], [.88]]), clip('drive_idle', 2, [[.59], [.59]]))
  else model.animations.push(
    clip('Jump', 1.22, [[.8], [1.15, -.04], [.8]]), clip('Car_Sit', 2, [[.65], [.65]]),
    clip('Car_Sit_Rear', 2, [[.71], [.71]]), clip('Drive', 2.4, [[.63], [.63]])
  )
  const navigation = {
    spawn: () => ({ x: 0, y: 4.1, z: 0 }),
    sample: (x, z) => z <= .25 ? 4.1 : null
  }
  const player = createManorPlayer({ THREE, scene: new THREE.Scene(), navigation,
    getVillaBounds: () => null, disposeModel() {} })
  player.show(model, 0)
  return { player, model, hips, navigation }
}

test('new rest clips sample exact transition frames and reverse to get up', () => {
  const { player, hips } = fixture()
  near(player.poseDuration('stand_up'), 1.05)
  near(player.poseDuration('wake_up'), 1.82)
  player.animatePose('sit_down', .25, .3)
  near(hips.position.y, .72)
  near(hips.position.z, .1425)
  player.animatePose('sit_down', 1, .3)
  near(hips.position.y, .48)
  player.animatePose('sit_idle', undefined, .3)
  near(hips.position.y, .48)
  player.animatePose('stand_up', .5, .3)
  near(hips.position.y, .64)
  player.animatePose('stand_up', 1, .3)
  near(hips.position.y, .8)
  near(hips.position.z, .19)
  player.animatePose('lie_down', 1, .3)
  near(hips.position.z, -.148)
  player.animatePose('lie_idle', undefined, .3)
  near(hips.position.y, .17)
  player.animatePose('wake_up', 1, .3)
  near(hips.position.y, .8)
  near(hips.position.z, 0)
})

test('jump plays and lands in place, can be cancelled and never changes the saved floor position', () => {
  const { player, hips, navigation } = fixture()
  const original = player.position.clone()
  player.setInput(0, 1)
  assert.equal(player.canJump, true)
  assert.equal(player.jump(), true)
  assert.equal(player.jump(), false)
  player.update(.61, 0)
  near(hips.position.y, 1.15)
  near(player.jumpHeight, .35)
  assert.ok(player.position.equals(original))
  assert.equal(player.isJumping, true)
  player.update(.61, 0)
  near(hips.position.y, .8)
  assert.ok(player.position.equals(original))
  assert.equal(player.isJumping, false)
  player.update(.5, 0)
  assert.ok(player.position.z <= .25)
  assert.equal(player.jump(), true)
  player.update(.61, 0)
  player.setNavigation(navigation)
  assert.equal(player.isJumping, false)
  assert.equal(player.jumpHeight, 0)
  near(hips.position.y, .8)
})

test('fitted car uses its seat and driving clips with the authored model offset', () => {
  const { player, model, hips } = fixture()
  const transport = (action, opts) => player.updateTransport(.3, 0, 0, 0, 1, { action, ...opts })
  near(model.position.y, .1)
  transport('board', { progress: .5, seatBlend: .5 })
  near(hips.position.y, .725)
  near(model.position.y, .05)
  transport('seated', { seatBlend: 1, rear: true, seated: true })
  near(hips.position.y, .71)
  near(model.position.y, 0)
  near(player.facing, 1)
  transport('drive', { seatBlend: 1, seated: true })
  near(hips.position.y, .63)
  transport('exit', { progress: 1, seatBlend: 0 })
  near(hips.position.y, .8)
  near(model.position.y, .1)
})

test('legacy clips keep their explicit standing transition and have no jump', () => {
  const { player, model, hips } = fixture({ legacy: true })
  assert.equal(player.canJump, false)
  assert.equal(player.jump(), false)
  near(player.poseDuration('stand_up'), 1.4)
  player.animatePose('stand_up', 1, .3)
  near(hips.position.y, .88)
  player.updateTransport(.3, 0, 0, 0, 0, { action: 'drive', seatBlend: 1, seated: true })
  near(hips.position.y, .59)
  near(model.position.y, .1)
})
