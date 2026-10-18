const test = require('node:test')
const assert = require('node:assert/strict')
const { World2D } = require('../../miniprogram/packagePlayground/utils/world2d')

function fixture() {
  const page = { data: { showYardOwners: true }, setData(value) { Object.assign(this.data, value) } }
  const scene = { playerId: 'me', hasAvatar: true, name: '小林', nameColor: '#a92e79', position: { x: 280, z: 280 } }
  const w = new World2D(page, null, { scene, pets: [] })
  w.buildWorld()
  w.project = () => ({ x: 150, y: 200 })
  const labels = [], outlines = []
  w.ctx = new Proxy({
    measureText: (text) => ({ width: text.length * 12 }),
    fillText(text) { labels.push({ text, color: this.fillStyle }) },
    strokeText(text) { outlines.push({ text, color: this.strokeStyle }) }
  }, { get: (target, key) => key in target ? target[key] : () => {} })
  return { w, scene, labels, outlines }
}

test('snapshot and incremental pet names keep owner colors, including while a local move is pending', async () => {
  const { w, labels, outlines } = fixture()
  const position = { x: 560, z: 280 }
  const pet = { id: 'pet', name: '豆豆', species: 'dog', modelScale: 1, motion: { epoch: Date.now(), approach: [position], patrol: [position] } }
  const resident = { kind: 'resident', id: 'resident', ownerId: 'neighbor', ownerName: '小王', nameColor: '#168c72', mine: false, pets: [pet] }
  const plot = { kind: 'plot', id: 'yard', ownerId: 'neighbor', ownerName: '小王', nameColor: resident.nameColor, x: 560, z: 280, size: 112 }
  await w.applySceneRecords([plot, resident])
  w.drawPetNames()
  w.drawYardOwners(w.bounds)
  assert.deepEqual(labels, [{ text: '豆豆', color: resident.nameColor }, { text: '小王', color: resident.nameColor }])
  assert.ok(outlines.every((outline) => outline.color === '#ffffff'))
  labels.length = 0
  w.pets[0].pendingMove = { token: 2 }
  await w.applySceneChanges([{ ...resident, nameColor: '#c34624' }])
  w.drawPetNames()
  assert.deepEqual(labels, [{ text: '豆豆', color: '#c34624' }])
})

test('character, courtyard and car labels use the assigned color even when selected or offline', () => {
  const { w, scene, labels, outlines } = fixture()
  w.assets.boy_idle_sw = { width: 256, height: 256 }
  w.ownPlot = { id: 'own', mine: true, ownerId: 'me', ownerName: scene.name, nameColor: scene.nameColor, x: 280, z: 280, size: 112 }
  w.drawCharacter(false)
  w.drawYardOwners(w.bounds)
  w.selectedVehicleId = 'car'
  w.drawVehicle({ id: 'car', ownerId: 'me', name: scene.name, state: 'outside', online: false, position: { x: 280, z: 340 } }, false)
  assert.deepEqual(labels, [
    { text: scene.name, color: scene.nameColor },
    { text: scene.name, color: scene.nameColor },
    { text: '小车', color: scene.nameColor }
  ])
  assert.ok(outlines.every((outline) => outline.color === '#ffffff'))
  labels.length = 0
  w.drawNeighbor({ id: 'neighbor', name: '小王', nameColor: '#168c72', online: false, position: { x: 560, z: 280 } }, false)
  assert.deepEqual(labels, [{ text: '小王', color: '#168c72' }])
})

test('own name color follows realtime actor changes when visiting without a local courtyard', async () => {
  const { w, scene } = fixture()
  await w.applySceneChanges([{ kind: 'presence', id: 'me', mine: true, name: '小林新名', nameColor: '#c34624' }])
  assert.equal(scene.name, '小林新名')
  assert.equal(w.ownerNameColor('me'), '#c34624')
  assert.notEqual(w.ownerNameColor('me', '#ffffff'), '#ffffff')
  assert.notEqual(w.ownerNameColor('me', '#000000'), '#000000')
})
