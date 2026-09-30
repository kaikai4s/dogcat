const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

const securityMock = {
  msgSecCheck: async ({ content }) => {
    if (content && content.includes('违规敏感词')) {
      const err = new Error('内容包含违法违规信息')
      err.errCode = 87014
      throw err
    }
    return { errCode: 0, errMsg: 'ok' }
  },
  imgSecCheck: async () => ({ errCode: 0, errMsg: 'ok' })
}

test('pet: submitVaccineCertification concurrent submission safety and state atomic sync', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_v1',
        openid: 'openid_client',
        name: '布丁',
        species: 'cat',
        vaccineCertification: {
          status: 'none'
        }
      }
    ],
    pet_vaccine_certifications: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client', { security: securityMock })

  const payload = {
    petId: 'pet_v1',
    fileIds: ['cloud://cert1.png'],
    vaccineTypes: ['狂犬疫苗', '猫三联'],
    certificateNo: 'VAC20261001001',
    validUntil: '2027-10-01',
    remark: '按时接种'
  }

  // 1. 并发模拟：两个请求同时提交同一宠物的疫苗认证申请
  const [resA, resB] = await Promise.all([
    clientFn.main({ module: 'pet', action: 'submitVaccineCertification', data: payload }),
    clientFn.main({ module: 'pet', action: 'submitVaccineCertification', data: payload })
  ])

  // 严格保证一个成功一个被排他拦截
  const successes = [resA, resB].filter((r) => r.ok)
  const failures = [resA, resB].filter((r) => !r.ok)
  assert.equal(successes.length, 1)
  assert.equal(failures.length, 1)
  assert.match(failures[0].error, /已有疫苗认证待审核申请，请勿重复提交/)

  // 验证 pet_vaccine_certifications 严格只有 1 条记录
  assert.equal(db.state.pet_vaccine_certifications.length, 1)

  // 验证 pets 表中的 vaccineCertification 同步为 pending
  const pet = db.state.pets.find((p) => p._id === 'pet_v1')
  assert.equal(pet.vaccineCertification.status, 'pending')
  assert.equal(pet.vaccineCertification.certificateNo, 'VAC20261001001')
})

test('admin: auditPetVaccineCertification remark and rejectReason content security checks', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_v2',
        openid: 'openid_client',
        name: '奶酪',
        vaccineCertification: { status: 'pending' }
      }
    ],
    pet_vaccine_certifications: [
      {
        _id: 'pvc_1',
        petId: 'pet_v2',
        openid: 'openid_client',
        status: 'pending',
        certificateNo: 'VAC999'
      }
    ],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 驳回原因包含敏感词被拦截
  const badRejectRes = await adminFn.main({
    module: 'admin',
    action: 'auditPetVaccineCertification',
    data: {
      applicationId: 'pvc_1',
      status: 'rejected',
      rejectReason: '证件模糊包含违规敏感词私下发我',
      adminRemark: '审核备注'
    }
  })
  assert.equal(badRejectRes.ok, false)
  assert.match(badRejectRes.error, /敏感|不合规|违规/)

  // 2. 正常审核通过
  const goodAuditRes = await adminFn.main({
    module: 'admin',
    action: 'auditPetVaccineCertification',
    data: {
      applicationId: 'pvc_1',
      status: 'approved',
      validUntil: '2027-10-01',
      adminRemark: '兽医盖章清晰，审核通过'
    }
  })
  assert.equal(goodAuditRes.ok, true)

  // 验证宠物档案疫苗状态更新为 approved
  const pet = db.state.pets.find((p) => p._id === 'pet_v2')
  assert.equal(pet.vaccineCertification.status, 'approved')
  assert.equal(pet.vaccineCertification.validUntil, '2027-10-01')
})

test('admin: auditStaff prevents duplicate approval override and enforces remark security', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['client'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_staff_1',
        openid: 'openid_staff',
        realName: '王五',
        gender: 'male',
        auditStatus: 'pending',
        staffLevel: 'applicant'
      }
    ],
    staff_identity_verifications: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 审核备注包含敏感词被拦截
  const badRemarkRes = await adminFn.main({
    module: 'admin',
    action: 'auditStaff',
    data: {
      staffProfileId: 'sp_staff_1',
      auditStatus: 'approved',
      auditRemark: '资质合格违规敏感词联系'
    }
  })
  assert.equal(badRemarkRes.ok, false)
  assert.match(badRemarkRes.error, /敏感|不合规|违规/)

  // 2. 审核备注超长被拦截
  const longRemarkRes = await adminFn.main({
    module: 'admin',
    action: 'auditStaff',
    data: {
      staffProfileId: 'sp_staff_1',
      auditStatus: 'approved',
      auditRemark: 'K'.repeat(501)
    }
  })
  assert.equal(longRemarkRes.ok, false)
  assert.match(longRemarkRes.error, /不能超过 500 字/)

  // 3. 正常初审通过
  const goodAuditRes = await adminFn.main({
    module: 'admin',
    action: 'auditStaff',
    data: {
      staffProfileId: 'sp_staff_1',
      auditStatus: 'approved',
      auditRemark: '身份与资质已通过核验'
    }
  })
  assert.equal(goodAuditRes.ok, true)
  assert.equal(db.state.staff_profiles[0].auditStatus, 'approved')

  // 4. 对已审核通过的宠托师重复调用 auditStaff，被状态守卫拦截
  const duplicateAuditRes = await adminFn.main({
    module: 'admin',
    action: 'auditStaff',
    data: {
      staffProfileId: 'sp_staff_1',
      auditStatus: 'approved',
      auditRemark: '重复审核'
    }
  })
  assert.equal(duplicateAuditRes.ok, false)
  assert.match(duplicateAuditRes.error, /已处于该审核状态，请勿重复操作/)
})
