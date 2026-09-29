const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createHandler = require('../../cloudfunctions/api/handlers/staff')

function setup(roles = ['staff'], extra = {}) {
  const db = createCollectionStore({
    staff_profiles: [{ _id: 'sp1', openid: 'staff1', auditStatus: 'approved', staffLevel: 'intern', serviceAddress: '测试服务地址', serviceLatitude: 31.2, serviceLongitude: 121.5 }]
  })
  const context = createContext({ db, cloud: {} })
  const handler = createHandler({ ...context, getUser: async () => ({ _id: 'u1', roles }), checkTextSecurity: async () => {}, ...extra })
  return { db, handler }
}

test('public profile config cannot be changed by a non-staff account', async () => {
  const { handler } = setup(['client'])
  await assert.rejects(handler('staff1', 'updateStaffProfileConfig', { profileIntro: 'test' }), /仅宠托师/)
})

test('public profile config rejects forged verified or promotion fields', async () => {
  const { handler, db } = setup()
  for (const field of ['auditStatus', 'staffLevel', 'quizPassedAt', 'videoAuditStatus', 'verifiedServiceTags', 'verificationItems', 'completedOrderCount', 'internCompletedOrderCount', 'promotionStatus']) {
    await assert.rejects(handler('staff1', 'updateStaffProfileConfig', { [field]: 'forged' }), /不可自行修改/)
  }
  const profile = (await db.collection('staff_profiles').doc('sp1').get()).data
  assert.equal(profile.staffLevel, 'intern')
  assert.equal(profile.quizPassedAt, undefined)
})
