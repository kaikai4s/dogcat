const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const world = require('../../cloudfunctions/api/services/playground-world')
const createService = require('../../cloudfunctions/api/services/playground-communities')
const community = { name: '阳光小区', address: '公园路', city: '上海', district: '浦东', latitude: 31, longitude: 121 }
const id = world.communityId({ residentialCommunity: community })
test('community directory counts unique residential owners across pages and excludes gardens, facilities, demolished plots and visitors', async () => {
  const users = Array.from({ length: 121 }, (_, i) => ({ _id: `u${i}`, openid: `owner${i}`, residentialCommunity: community }))
  const plots = users.map((u, i) => ({ _id: `home${String(i).padStart(3, '0')}`, kind: 'plot', ownerOpenid: u.openid, communityId: id, buildingType: 'residential' }))
  plots.push(
    { _id: 'duplicate', kind: 'plot', ownerOpenid: 'owner0', communityId: id },
    { _id: 'yard', kind: 'plot', ownerOpenid: 'garden', communityId: id, isNewPlot: true },
    { _id: 'hospital', kind: 'plot', ownerOpenid: 'facility', communityId: id, buildingType: 'pet_hospital' },
    { _id: 'old', kind: 'plot', ownerOpenid: 'gone', communityId: id, demolished: true },
    { _id: 'visitor', kind: 'presence', ownerOpenid: 'visitor', communityId: id },
    { _id: 'owner_mapping', kind: 'owner_plot', ownerOpenid: 'owner0', communityId: id }
  )
  const db = createCollectionStore({ users, pet_playground_plots: plots })
  const service = createService({ db })
  const list = await service.list(users[0])
  assert.equal(list.list.length, 1)
  assert.equal(list.list[0].residentCount, 121)
  assert.equal((await service.info(community)).residentCount, 121)
  assert.equal(list.list[0].mine, true)
  assert.ok(!JSON.stringify(list).includes('owner0'))
  assert.equal((await service.list(users[0], { keyword: '不存在' })).list.length, 0)
  assert.equal((await service.info({ ...community, name: '尚未入住小区' })).residentCount, 0)
})
test('public directory and selected-map counts require login; empty current communities remain selectable', async () => {
  const db = createCollectionStore({ users: [{ _id: 'u', openid: 'u', roles: ['client'], status: 'active', residentialCommunity: community }] })
  const fn = loadCloudFunction('api', db, 'u')
  const result = await fn.main({ module: 'playground', action: 'listCommunities', data: {} })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.list[0].residentCount, 0)
  assert.equal((await fn.main({ module: 'playground', action: 'getCommunityInfo', data: { community: { ...community, latitude: 95 } } })).ok, false)
  const guest = loadCloudFunction('api', db, 'guest')
  assert.equal((await guest.main({ module: 'playground', action: 'listCommunities' })).ok, false)
})
