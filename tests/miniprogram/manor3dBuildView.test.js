const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE } = require('../../miniprogram/packageManor3d/vendor/three-runtime')
const { createManorBuildView, RED_VILLA } = require('../../miniprogram/packageManor3d/utils/manor-build-view')
const sourcePlots = require('../../cloudfunctions/api/services/playground-shared/manor3d-building-plots.json')

test('placed villa bounds remain addressable by their owner for pet spawning', () => {
  const scene = new THREE.Scene()
  const view = createManorBuildView({ THREE, scene, disposeModel() {} })
  view.setPlots(sourcePlots.map(([id, x, z, width, depth]) => ({ id, x, z, y: 0, width, depth })))
  view.setModel(RED_VILLA, new THREE.Group().add(
    new THREE.Mesh(new THREE.BoxGeometry(18.63, 8, 10.851), new THREE.MeshBasicMaterial())))
  view.setPlaced([
    { id: 'villa-a', ownerId: 'owner-a', buildingId: RED_VILLA, plotId: 'M150', x: -106, z: 88, rotation: 0 },
    { id: 'villa-b', ownerId: 'owner-b', buildingId: RED_VILLA, plotId: 'M149', x: -266, z: 88, rotation: 0 }
  ])

  const first = view.buildingBounds('owner-a', RED_VILLA).getCenter(new THREE.Vector3())
  const second = view.buildingBounds('owner-b', RED_VILLA).getCenter(new THREE.Vector3())
  assert.equal(Math.round(first.x), -106)
  assert.equal(Math.round(second.x), -266)
  assert.equal(view.buildingBounds('missing-owner', RED_VILLA), null)
  view.dispose()
})
