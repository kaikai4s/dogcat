const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const world = require('../../cloudfunctions/api/services/playground-world')
const { publicUserTitle } = require('../../cloudfunctions/api/services/userTitles')
const id = 'map_community_' + 'c'.repeat(24)
const managed = (extra = {}) => ({ _id: id, key: 'service_community', name: '阳光小区', city: '上海市', cityKey: '上海', district: '浦东新区',
  latitude: 31.2, longitude: 121.5, enabled: true, revision: 1, editVersion: 1, matchRadiusKm: 1, aliases: [], ...extra })
function fixture(rows = []) {
  const db = createCollectionStore({ users: ['a', 'b', 'admin'].map(openid => ({ _id: 'u_' + openid, openid, nickname: openid,
    roles: openid === 'admin' ? ['admin'] : ['client'], status: 'active' })), platform_configs: rows }, { cloudObjectUpdates: true })
  const context = createContext({ db, cloud: { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } } } })
  const map = require('../../cloudfunctions/api/handlers/communityMap')(context)
  const playground = require('../../cloudfunctions/api/handlers/playground')(context)
  const admin = data => context.runAdminRequest('communityMap', 'saveAdmin', data, () => map('admin', 'saveAdmin', data))
  return { db, context, map, playground, admin, user: openid => db.state.users.find(item => item.openid === openid) }
}
const application = { name: '阳光小区', city: '上海市', district: '浦东新区' }
const approval = appId => ({ ...application, latitude: 31.2, longitude: 121.5, enabled: true, confirmPublic: true, applicationIds: [appId], requestId: 'founder-approval-0001' })

test('enabled maintained communities with no residents are immediately selectable and ignore forged client metadata', async () => {
  const f = fixture([managed(), managed({ _id: 'map_community_' + 'd'.repeat(24), enabled: false })])
  const list = await f.playground('a', 'listCommunities', { city: '上海市' })
  assert.equal(list.list.length, 1)
  assert.equal(list.list[0].residentCount, 0)
  assert.equal(list.list[0].community.serviceCommunityId, id)
  assert.equal(list.list[0].maintained, true)
  const result = await f.playground('a', 'saveCommunity', { community: { serviceCommunityId: id, name: 'FORGED', address: 'PRIVATE', latitude: 1 } })
  assert.equal(result.residentialCommunity.name, '阳光小区')
  assert.equal(result.residentialCommunity.latitude, 31.2)
  assert.equal(f.user('a').residentialCommunity.serviceCommunityId, id)
  const before = world.communityId(f.user('a'))
  f.db.state.platform_configs[0].name = '阳光花园'
  const selected = await f.playground('a', 'getCommunityInfo', { community: { serviceCommunityId: id } })
  assert.equal(selected.id, before, 'Renaming a maintained community cannot move its world')
  assert.equal(selected.community.name, '阳光花园')
  f.db.state.platform_configs[0].enabled = false
  await assert.rejects(() => f.playground('a', 'saveCommunity', { community: { serviceCommunityId: id, name: 'fake' } }), /停用/)
})

test('first applicant is recorded by the server and receives one title only when a new community is approved', async () => {
  const f = fixture()
  const first = await f.map('a', 'applyCommunity', { ...application, firstApplicantOpenid: 'b' })
  assert.equal(first.outcome, 'created')
  assert.equal(first.message, '申请成功，请等待管理员处理')
  const self = await f.map('a', 'applyCommunity', application)
  assert.equal(self.outcome, 'self_duplicate')
  const duplicate = await f.map('b', 'applyCommunity', application)
  assert.equal(duplicate.outcome, 'other_duplicate')
  assert.equal(JSON.stringify(duplicate).includes('firstApplicantOpenid'), false)
  assert.equal(first.applicationId, duplicate.applicationId)
  const pending = f.db.state.platform_configs.find(item => item._id === first.applicationId)
  assert.equal(pending.firstApplicantOpenid, 'a')
  assert.equal(f.user('a').userTitleInventory, undefined)
  assert.equal((await f.playground('a', 'listCommunities')).list.length, 0)
  const saved = await f.admin(approval(first.applicationId))
  assert.equal(f.user('a').userTitleInventory.length, 1)
  assert.equal(f.user('a').userTitleInventory[0].communityId, saved.id)
  assert.equal(f.user('a').userTitleInventory[0].name, '小区初创者')
  assert.equal(f.user('a').equippedUserTitleId, undefined, 'Granting must not force equipment')
  assert.equal(f.user('b').userTitleInventory, undefined)
  await f.admin(approval(first.applicationId))
  assert.equal(f.user('a').userTitleInventory.length, 1)
  assert.equal(f.db.state.system_notifications.length, 1)
  const notice = f.db.state.system_notifications[0]
  assert.equal(notice.target, 'client')
  assert.equal(notice.targetOpenid, 'a')
  assert.equal(notice.extra.founder, true)
  assert.match(notice.content, /小区初创者/)
  assert.equal((await f.context.listUserSystemNotifications('a', 'client')).list.length, 1)
  assert.equal((await f.context.listUserSystemNotifications('b', 'client')).list.length, 0)
  const list = await f.playground('a', 'listCommunities')
  assert.equal(list.list[0].community.serviceCommunityId, saved.id)
  assert.equal(JSON.stringify(list).includes('firstApplicantOpenid'), false)
  assert.equal(JSON.stringify(list).includes('founderUserId'), false)
})

test('linking an outstanding application to an already maintained community does not award a second founder', async () => {
  const f = fixture()
  const app = await f.map('a', 'applyCommunity', application)
  f.db.state.platform_configs.push(managed())
  await f.admin({ ...approval(app.applicationId), id, revision: 1, editVersion: 1 })
  assert.equal(f.user('a').userTitleInventory, undefined)
  assert.equal(f.db.state.system_notifications.length, 1)
  assert.equal(f.db.state.system_notifications[0].extra.founder, false)
  assert.doesNotMatch(f.db.state.system_notifications[0].content, /小区初创者/)
})

test('a rejected legacy identity also blocks approval through a different pending historical ID', async () => {
  const pendingId = 'map_application_' + '1'.repeat(32)
  const f = fixture([
    { _id: 'map_application_' + '2'.repeat(32), key: 'map_community_application', ...application,
      cityKey: '上海', name: '上海市浦东新区阳光小区东门', status: 'rejected', rejectionReason: '资料不符' },
    { _id: pendingId, key: 'map_community_application', ...application, cityKey: '上海',
      status: 'pending', firstApplicantOpenid: 'a' }
  ])
  await assert.rejects(() => f.admin(approval(pendingId)), /已有被驳回/)
  assert.equal(f.db.state.platform_configs.find(row => row._id === pendingId).status, 'pending')
  assert.equal(f.db.state.platform_configs.some(row => row.key === 'service_community'), false)
  assert.equal(f.user('a').userTitleInventory, undefined)
  assert.equal((f.db.state.system_notifications || []).length, 0)
})

test('users can equip only owned titles, remove them, and founder display is scoped to its community', async () => {
  const f = fixture()
  const app = await f.map('a', 'applyCommunity', application)
  const saved = await f.admin(approval(app.applicationId))
  const title = f.user('a').userTitleInventory[0]
  await assert.rejects(() => f.playground('b', 'equipUserTitle', { titleId: title.id }), /尚未获得/)
  const sceneId = world.communityId({ residentialCommunity: { serviceCommunityId: saved.id, name: application.name } })
  const actorId = 'presence_' + world.hash('a')
  f.db.state.pet_playground_plots = [{ _id: actorId, kind: 'presence', ownerOpenid: 'a', communityId: sceneId,
    active: false, sessionStarted: 1, session: 'session', seq: 3, lastSeen: Date.now() }]
  const equipped = await f.playground('a', 'equipUserTitle', { titleId: title.id })
  assert.equal(equipped.equippedTitle.id, title.id)
  assert.equal(equipped.publicTitle.name, '小区初创者')
  assert.equal(equipped.sceneId, sceneId)
  const state = await f.playground('a', 'listUserTitles')
  assert.equal(state.sceneId, sceneId)
  assert.equal(state.publicTitle.id, title.id)
  assert.equal(state.session, 'session')
  assert.deepEqual(state.version, equipped.version)
  assert.equal(f.db.state.pet_playground_plots[0].userTitle.name, '小区初创者')
  assert.equal(publicUserTitle(f.user('a'), 'another-community'), null)
  assert.equal(JSON.stringify(equipped).includes('firstApplicantOpenid'), false)
  const removed = await f.playground('a', 'equipUserTitle', { titleId: '' })
  assert.equal(removed.equippedTitle, null)
  assert.equal(f.db.state.pet_playground_plots[0].userTitle, null)
  assert.equal(f.user('a').userTitleInventory.length, 1)
})

test('title state reads fresh equipment and presence together instead of mixing a stale user snapshot with a new scene version', async () => {
  const f = fixture()
  const stale = structuredClone(f.user('a'))
  f.user('a').userTitleInventory = [{ id: 'honor', name: '邻里荣誉' }]
  f.user('a').equippedUserTitleId = 'honor'
  f.db.state.pet_playground_plots = [{ _id: 'presence_' + world.hash('a'), kind: 'presence', ownerOpenid: 'a',
    communityId: 'scene-a', session: 'new-session', sessionStarted: 20, seq: 2 }]
  const state = await f.context.getUserTitleState(stale)
  assert.equal(state.equippedTitle.id, 'honor')
  assert.equal(state.publicTitle.id, 'honor')
  assert.equal(state.session, 'new-session')
  assert.deepEqual(state.version, { epoch: 20, seq: 2 })
})

test('saved resident metadata cannot re-list a disabled or deleted maintained community', async () => {
  const f = fixture([managed()])
  await f.playground('a', 'saveCommunity', { community: { serviceCommunityId: id, name: '阳光小区' } })
  const communityId = world.communityId(f.user('a'))
  f.db.state.pet_playground_plots = [{ _id: 'home-a', kind: 'plot', buildingType: 'residential', ownerOpenid: 'a', communityId }]
  assert.equal((await f.playground('b', 'listCommunities')).list[0].residentCount, 1)
  f.db.state.platform_configs[0].enabled = false
  assert.equal((await f.playground('a', 'listCommunities')).list.length, 0)
  assert.equal((await f.playground('b', 'listCommunities')).list.length, 0)
  f.db.state.platform_configs = []
  assert.equal((await f.playground('a', 'listCommunities')).list.length, 0)
})

test('incomplete maintained coordinates do not produce selectable rows which fail upon entry', async () => {
  const f = fixture([managed({ latitude: null }), managed({ _id: 'map_community_' + 'd'.repeat(24), latitude: 0, longitude: 0 })])
  assert.equal((await f.playground('a', 'listCommunities')).list.length, 0)
})

test('invalid legacy coordinates in one saved profile do not block the public directory', async () => {
  const f = fixture([managed()])
  f.user('a').residentialCommunity = { name: '旧资料小区', city: '上海市', latitude: '旧版异常值', longitude: 121 }
  const communityId = world.communityId(f.user('a'))
  f.db.state.pet_playground_plots = [{ _id: 'home-a', kind: 'plot', buildingType: 'residential', ownerOpenid: 'a', communityId }]
  for (const viewer of ['a', 'b']) {
    const result = await f.playground(viewer, 'listCommunities')
    assert.equal(result.list.length, 1)
    assert.equal(result.list[0].community.serviceCommunityId, id)
  }
})

test('managed community metadata is recovered from the directory even when a saved snapshot has invalid coordinates', async () => {
  const f = fixture([managed()])
  f.user('a').residentialCommunity = { serviceCommunityId: id, name: '旧名字', city: '上海市', latitude: '旧版异常值' }
  const result = await f.playground('a', 'listCommunities')
  assert.equal(result.list[0].mine, true)
  assert.equal(result.list[0].community.name, '阳光小区')
  assert.equal(result.list[0].community.latitude, 31.2)
})

for (const action of ['saveCommunity', 'updateCommunity', 'updateProfile']) {
  test(`${action} binds a community from a null profile field using CloudBase replacement semantics`, async () => {
    const f = fixture([managed()])
    f.user('a').residentialCommunity = null
    const community = { serviceCommunityId: id, name: '阳光小区' }
    const handler = action === 'saveCommunity' ? f.playground : require('../../cloudfunctions/api/handlers/auth')(f.context)
    const result = await handler('a', action, { community, residentialCommunity: community, nickname: 'a' })
    assert.equal(result.residentialCommunity.serviceCommunityId, id)
    assert.deepEqual(result.residentialCommunity, f.user('a').residentialCommunity)
  })

  test(`${action} returns the canonical community actually committed when an admin renames it during saving`, async () => {
    const f = fixture([managed()])
    const check = f.context.checkTextSecurity
    f.context.checkTextSecurity = async (...args) => {
      await check(...args)
      f.db.state.platform_configs.find(row => row._id === id).name = '阳光花园新名称'
    }
    const community = { serviceCommunityId: id, name: '阳光小区' }
    const handler = action === 'saveCommunity' ? f.playground : require('../../cloudfunctions/api/handlers/auth')(f.context)
    const result = await handler('a', action, { community, residentialCommunity: community, nickname: 'a' })
    assert.equal(result.residentialCommunity.name, '阳光花园新名称')
    assert.deepEqual(result.residentialCommunity, f.user('a').residentialCommunity)
    assert.equal(result.residentialCommunity.serviceCommunityId, id)
  })
}

test('switching to a legacy community replaces the profile object without retaining the former directory ID', async () => {
  const f = fixture([managed()])
  await f.playground('a', 'saveCommunity', { community: { serviceCommunityId: id, name: '阳光小区' } })
  const legacy = { name: '原有历史庄园', city: '上海市', latitude: 31, longitude: 121 }
  const result = await f.playground('a', 'saveCommunity', { community: legacy })
  assert.equal(f.user('a').residentialCommunity.serviceCommunityId, undefined)
  assert.deepEqual(result.residentialCommunity, f.user('a').residentialCommunity)
  assert.equal(world.communityId(f.user('a')), world.communityId({ residentialCommunity: legacy }))
})

test('equivalent public names reuse historical application IDs without moving order references', async () => {
  const f = fixture()
  const legacyId = 'map_application_' + '1'.repeat(32)
  f.db.state.platform_configs.push({ _id: legacyId, key: 'map_community_application', ...application,
    name: '上海市浦东新区阳光小区（南门）', district: '浦东新 区', cityKey: '上海',
    firstApplicantOpenid: 'a', status: 'pending', createdAt: new Date('2025-01-01') })
  const result = await f.map('b', 'applyCommunity', { ...application, name: '阳光小区北门' })
  assert.equal(result.applicationId, legacyId)
  assert.equal(result.outcome, 'other_duplicate')
  assert.equal(f.db.state.platform_configs.filter(row => row.key === 'map_community_application').length, 1)
  await f.admin(approval(legacyId))
  assert.equal(f.db.state.system_notifications[0].targetOpenid, 'a')
  assert.equal(f.user('a').userTitleInventory[0].applicationId, legacyId)
})

test('application identities distinguish cities, districts, phases and residential areas', async () => {
  const f = fixture()
  const first = await f.map('a', 'applyCommunity', application)
  for (const patch of [{ city: '南京市' }, { district: '闵行区' }, { name: '阳光小区二期' }, { name: '阳光小区北区' }]) {
    const separate = await f.map('b', 'applyCommunity', { ...application, ...patch })
    assert.equal(separate.outcome, 'created')
    assert.notEqual(separate.applicationId, first.applicationId)
  }
  await assert.rejects(f.map('a', 'applyCommunity', { ...application, district: '' }), /行政区/)
})

for (const enabled of [true, false]) {
  test(`maintained communities are recognized before creating an application, enabled=${enabled}`, async () => {
    const f = fixture([managed({ enabled, aliases: ['阳光家园'] })])
    const result = await f.map('a', 'applyCommunity', { ...application, name: '上海市浦东新区阳光家园南门' })
    assert.equal(result.status, 'existing')
    assert.equal(result.outcome, 'existing')
    assert.equal(result.community?._id, enabled ? id : undefined)
    assert.equal(result.applicationId, undefined)
    assert.equal(f.db.state.platform_configs.filter(row => row.key === 'map_community_application').length, 0)
    assert.equal(f.user('a').userTitleInventory, undefined)
    assert.match(result.message, enabled ? /已上线/ : /暂未启用/)
  })
}

test('application lookup errors and over-limit snapshots never become new applications', async () => {
  const f = fixture()
  const collection = f.db.collection.bind(f.db)
  f.db.collection = name => {
    const chain = collection(name), where = chain.where.bind(chain)
    chain.where = filter => {
      if (name === 'platform_configs' && filter.key === 'map_community_application') throw new Error('application lookup unavailable')
      return where(filter)
    }
    return chain
  }
  await assert.rejects(f.map('a', 'applyCommunity', application), /lookup unavailable/)
  assert.equal(f.db.state.platform_configs.length, 0)
  f.db.collection = collection
  f.db.state.platform_configs = Array.from({ length: 1001 }, (_, index) => ({
    _id: 'map_application_' + index.toString(16).padStart(32, '0'), key: 'map_community_application',
    ...application, cityKey: '上海', name: `历史小区${index}`, status: 'resolved'
  }))
  await assert.rejects(f.map('a', 'applyCommunity', application), /记录较多/)
  assert.equal(f.db.state.platform_configs.length, 1001)
})

test('rejected applications remain closed for every applicant and notify only the original applicant once', async () => {
  const f = fixture()
  const app = await f.map('a', 'applyCommunity', application)
  await f.map('b', 'applyCommunity', application)
  const request = { applicationIds: [app.applicationId], reason: '无法核实为住宅小区' }
  const reject = data => f.context.runAdminRequest('communityMap', 'rejectApplication', data, () => f.map('admin', 'rejectApplication', data))
  await reject(request)
  const record = structuredClone(f.db.state.platform_configs.find(row => row._id === app.applicationId))
  await reject(request)
  assert.deepEqual(f.db.state.platform_configs.find(row => row._id === app.applicationId), record)
  assert.equal(f.db.state.system_notifications.length, 1)
  assert.equal(f.db.state.system_notifications[0].targetOpenid, 'a')
  assert.equal(f.db.state.system_notifications[0].extra.status, 'rejected')
  assert.match(f.db.state.system_notifications[0].content, /无法核实为住宅小区/)
  assert.equal((await f.context.listUserSystemNotifications('a', 'client')).list.length, 1)
  assert.equal((await f.context.listUserSystemNotifications('b', 'client')).list.length, 0)
  for (const openid of ['a', 'b']) {
    const result = await f.map(openid, 'applyCommunity', { ...application, district: '' })
    assert.equal(result.status, 'rejected')
    assert.equal(result.rejectionReason, request.reason)
    assert.equal(result.applicationId, app.applicationId)
  }
  await assert.rejects(f.admin(approval(app.applicationId)), /驳回/)
  await assert.rejects(reject({ ...request, reason: '改变原因' }), /已处理|已变化/)
  assert.deepEqual(f.db.state.platform_configs.find(row => row._id === app.applicationId), record)
  assert.equal(f.user('a').userTitleInventory, undefined)
})

for (const action of ['saveAdmin', 'rejectApplication']) {
  test(`${action} rolls back the application and title if its system notification cannot be saved`, async () => {
    const f = fixture()
    const app = await f.map('a', 'applyCommunity', application)
    const before = structuredClone({ configs: f.db.state.platform_configs, users: f.db.state.users })
    const notify = f.context.notifyCommunityApplicationResult
    f.context.notifyCommunityApplicationResult = async (...args) => {
      await notify(...args)
      throw new Error('notification write unavailable')
    }
    const request = action === 'saveAdmin' ? approval(app.applicationId) : { applicationIds: [app.applicationId], reason: '无法核实' }
    await assert.rejects(f.context.runAdminRequest('communityMap', action, request, () => f.map('admin', action, request)), /notification write/)
    assert.deepEqual(f.db.state.platform_configs, before.configs)
    assert.deepEqual(f.db.state.users, before.users)
    assert.equal((f.db.state.system_notifications || []).length, 0)
    f.context.notifyCommunityApplicationResult = notify
    await f.context.runAdminRequest('communityMap', action, request, () => f.map('admin', action, request))
    assert.equal(f.db.state.system_notifications.length, 1)
  })
}

test('legacy applications with no trusted applicant do not retroactively grant a guessed founder', async () => {
  const f = fixture()
  const app = await f.map('a', 'applyCommunity', application)
  delete f.db.state.platform_configs.find(item => item._id === app.applicationId).firstApplicantOpenid
  await f.map('b', 'applyCommunity', application)
  await f.admin(approval(app.applicationId))
  assert.equal(f.user('a').userTitleInventory, undefined)
  assert.equal(f.user('b').userTitleInventory, undefined)
})

test('equipped founder title enters the live scene for neighbors and disappears after removal or visiting another community', async () => {
  const f = fixture()
  const app = await f.map('a', 'applyCommunity', application)
  const saved = await f.admin(approval(app.applicationId))
  const community = { serviceCommunityId: saved.id, name: application.name }
  for (const openid of ['a', 'b']) await f.playground(openid, 'saveCommunity', { community })
  await f.playground('a', 'claimPlot', { x: 280, z: 280 })
  await f.playground('a', 'enterScene')
  const neighbor = await f.playground('b', 'enterScene')
  const titleId = f.user('a').userTitleInventory[0].id
  await f.playground('a', 'equipUserTitle', { titleId })
  const snapshot = await f.playground('b', 'getScene', { sceneId: neighbor.scene.sceneId, session: neighbor.scene.session })
  const actor = snapshot.records.find(item => item.kind === 'presence' && item.name === 'a')
  assert.equal(actor.userTitle.name, '小区初创者')
  assert.equal(JSON.stringify(actor).includes('firstApplicantOpenid'), false)
  assert.equal(JSON.stringify(actor).includes('applicationId'), false)
  const live = f.db.state.pet_playground_live.filter(item => item.kind === 'scene').flatMap(item => Object.values(item.records || {}))
  assert.equal(live.find(item => item.id === actor.id).userTitle.name, '小区初创者')
  await f.playground('a', 'equipUserTitle', { titleId: '' })
  const removed = await f.playground('b', 'getScene', { sceneId: neighbor.scene.sceneId, session: neighbor.scene.session })
  assert.equal(removed.records.find(item => item.id === actor.id).userTitle, null)
  await f.playground('a', 'equipUserTitle', { titleId })
  const visit = await f.playground('a', 'enterScene', { community: { name: '其他历史小区', city: '上海市' }, userTitle: { name: '伪造头衔' } })
  assert.equal(visit.scene.userTitle, null)
  assert.equal(f.user('a').equippedUserTitleId, titleId)
})
