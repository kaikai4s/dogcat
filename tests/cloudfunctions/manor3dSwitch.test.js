const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function fixture() {
  const community = { name: '晴溪社区', address: '1号' }
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active', residentialCommunity: community }
    ],
    pets: [{ _id: 'pet_1', openid: 'client', name: '豆包', species: 'dog' }],
    platform_configs: [],
    admin_operation_logs: []
  })
  return {
    db,
    admin: loadCloudFunction('api', db, 'admin'),
    client: loadCloudFunction('api', db, 'client')
  }
}

test('3D manor switch defaults to enabled, persists via saveSystemSettings and savePlaygroundSettings, and survives partial saves', async () => {
  const { db, admin, client } = fixture()

  const initial = await client.main({ module: 'system', action: 'getSettings' })
  assert.equal(initial.ok, true)
  assert.equal(initial.data.enableManor3d, true)

  const disabledViaSystem = await admin.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: { enableManor3d: false }
  })
  assert.equal(disabledViaSystem.ok, true, disabledViaSystem.message)
  assert.equal(disabledViaSystem.data.enableManor3d, false)

  // Unrelated partial saves must not reset enableManor3d back to true
  const partialSave = await admin.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: { maintenance: { booking: true } }
  })
  assert.equal(partialSave.ok, true, partialSave.message)
  assert.equal(partialSave.data.enableManor3d, false)

  const afterPartial = await client.main({ module: 'system', action: 'getSettings' })
  assert.equal(afterPartial.data.enableManor3d, false)

  // Re-enabling via savePlaygroundSettings updates settings and writes audit log
  const currentAdminSettings = await admin.main({ module: 'admin', action: 'getSystemSettings' })
  assert.equal(currentAdminSettings.data.enableManor3d, false)

  const reEnabled = await admin.main({
    module: 'admin',
    action: 'savePlaygroundSettings',
    data: {
      enableManor3d: true,
      playground: currentAdminSettings.data.playground,
      playgroundGroupBuy: currentAdminSettings.data.playgroundGroupBuy,
      playgroundCare: currentAdminSettings.data.playgroundCare
    }
  })
  assert.equal(reEnabled.ok, true, reEnabled.message)
  assert.equal(reEnabled.data.enableManor3d, true)

  const playgroundLogs = db.state.admin_operation_logs.filter((row) => row.action === 'savePlaygroundSettings')
  assert.equal(playgroundLogs.length, 1)
  assert.equal(playgroundLogs[0].detail.enableManor3d, true)
})

test('disabling 3D manor blocks 3D playground endpoints while keeping 2D playground fully available', async () => {
  const { admin, client } = fixture()

  // Initially enabled: 3D scene entry succeeds
  const overviewOpen = await client.main({ module: 'playground', action: 'getOverview' })
  assert.equal(overviewOpen.ok, true)
  assert.equal(overviewOpen.data.enableManor3d, true)

  const entered3d = await client.main({ module: 'playground', action: 'enterScene', data: { manor3d: true, solo: true } })
  assert.equal(entered3d.ok, true, entered3d.message)
  const { sceneId, session } = entered3d.data.scene

  // Turn off 3D manor
  const current = await admin.main({ module: 'admin', action: 'getSystemSettings' })
  const saved = await admin.main({
    module: 'admin',
    action: 'savePlaygroundSettings',
    data: {
      enableManor3d: false,
      playground: current.data.playground,
      playgroundGroupBuy: current.data.playgroundGroupBuy,
      playgroundCare: current.data.playgroundCare
    }
  })
  assert.equal(saved.ok, true, saved.message)

  // Overview stays available for 2D manor and reports enableManor3d: false
  const overviewClosed = await client.main({ module: 'playground', action: 'getOverview' })
  assert.equal(overviewClosed.ok, true)
  assert.equal(overviewClosed.data.enableManor3d, false)
  assert.equal(overviewClosed.data.pets.length, 1)

  // All 3D endpoints reject with MANOR3D_DISABLED
  const blockedActions = [
    ['enterScene', { manor3d: true, solo: true }],
    ['getScene', { sceneId, session, manor3d: true }],
    ['syncManor3d', { sceneId, session, seq: 1, position3d: { x: 0, z: 0 }, moving: false, running: false, facing: 0 }],
    ['syncManor3dVehicle', { sceneId, session, seq: 1, position3d: { x: 0, y: 0, z: 0 }, yaw: 0, moving: false }],
    ['listManor3dHomes', {}],
    ['placeManor3dBuilding', { sceneId, session, buildingId: 'songying_courtyard', plotId: 'M86', x: 14, z: 172, rotation: 90 }],
    ['movePet', { sceneId, session, petId: 'pet_1', manor3dPosition: { x: 1, y: 0, z: 2 } }],
    ['interactPet', { sceneId, session, petId: 'pet_1', actionKey: 'touch', manor3dPosition: { x: 1, y: 0, z: 2 } }],
    ['petAction', { sceneId, session, petId: 'pet_1', actionKey: 'rest', manor3dPosition: { x: 1, y: 0, z: 2 } }]
  ]
  for (const [action, data] of blockedActions) {
    const res = await client.main({ module: 'playground', action, data })
    assert.equal(res.ok, false, `expected ${action} to be rejected`)
    assert.equal(res.code, 'MANOR3D_DISABLED', action)
    assert.match(res.message, /3D 庄园暂未开放/)
  }

  // 2D playground scene entry and snapshot still work normally
  const entered2d = await client.main({ module: 'playground', action: 'enterScene', data: {} })
  assert.equal(entered2d.ok, true, entered2d.message)
  const snapshot2d = await client.main({
    module: 'playground',
    action: 'getScene',
    data: { sceneId: entered2d.data.scene.sceneId, session: entered2d.data.scene.session }
  })
  assert.equal(snapshot2d.ok, true, snapshot2d.message)
})
