const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('staff card styles persist and are public, reject invalid input, and preserve partial updates', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff', openid: 'staff', roles: ['staff'], status: 'active' }],
    staff_profiles: [{ _id: 'sp', openid: 'staff', auditStatus: 'approved', serviceAddress: '服务驿站', serviceLatitude: 31, serviceLongitude: 121 }],
    service_reviews: [], sitter_favorites: []
  })
  const api = loadCloudFunction('api', db, 'staff')
  const call = (action, data) => api.main({ module: 'staff', action, data })
  const initial = await call('getPublicSitterDetail', { staffProfileId: 'sp' })
  assert.equal(initial.ok, true)
  assert.equal(initial.data.profileCardOpacity, 46)
  for (const opacity of [0, 100, 37]) {
    const saved = await call('updateStaffProfileConfig', { profileCardColor: '#AABBCC', profileCardOpacity: opacity, profileCardBlur: 100 - opacity, profileCardTextColor: '#123456' })
    assert.equal(saved.ok, true, saved.message)
    const detail = await call('getPublicSitterDetail', { staffProfileId: 'sp' })
    assert.equal(detail.data.profileCardColor, '#aabbcc')
    assert.equal(detail.data.profileCardOpacity, opacity)
    assert.equal(detail.data.profileCardBlur, 100 - opacity)
    assert.equal(detail.data.profileCardTextColor, '#123456')
    const own = await call('getStaffProfile', {})
    assert.equal(own.data.profileCardOpacity, opacity)
  }
  for (const bad of [
    { profileCardColor: 'red;display:none' }, { profileCardTextColor: '#abc' },
    { profileCardOpacity: -1 }, { profileCardOpacity: 101 }, { profileCardOpacity: null }, { profileCardOpacity: '50' },
    { profileCardBlur: -1 }, { profileCardBlur: 101 }, { profileCardBlur: null }, { profileCardBlur: '50' }
  ]) {
    const result = await call('updateStaffProfileConfig', bad)
    assert.equal(result.ok, false)
  }
  await call('updateStaffProfileConfig', { profileCardTextColor: '#ffffff' })
  const detail = await call('getPublicSitterDetail', { staffProfileId: 'sp' })
  assert.equal(detail.data.profileCardColor, '#aabbcc')
  assert.equal(detail.data.profileCardOpacity, 37)
  assert.equal(detail.data.profileCardBlur, 63)
  assert.equal(detail.data.profileCardTextColor, '#ffffff')
})
