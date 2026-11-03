const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function setupPetListPage() {
  let page
  const requests = []
  const navigations = []
  const modals = []
  const toasts = []

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/pets/list/index.js'), 'utf8'), {
    Page: value => { page = value },
    require: () => ({
      callFunction: (module, action, data) => new Promise((resolve, reject) => requests.push({ module, action, data, resolve, reject })),
      showError() {}
    }),
    wx: {
      stopPullDownRefresh: () => {},
      showLoading: () => {},
      hideLoading: () => {},
      showToast: (opts) => toasts.push(opts),
      showModal: (opts) => modals.push(opts),
      navigateTo: (opts) => navigations.push(opts),
      redirectTo: (opts) => navigations.push(opts),
      setClipboardData: (opts) => { if (opts.success) opts.success() }
    }
  })
  page.setData = patch => {
    for (const [k, v] of Object.entries(patch)) {
      if (k.includes('.')) {
        const parts = k.split('.')
        let target = page.data
        for (let i = 0; i < parts.length - 1; i++) {
          if (!target[parts[i]]) target[parts[i]] = {}
          target = target[parts[i]]
        }
        target[parts[parts.length - 1]] = v
      } else {
        page.data[k] = v
      }
    }
  }
  return { page, requests, navigations, modals, toasts }
}

function setupUserListPage() {
  let page
  const requests = []
  const navigations = []

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/users/list/index.js'), 'utf8'), {
    Page: value => { page = value },
    require: () => ({
      callFunction: (module, action, data) => new Promise((resolve, reject) => requests.push({ module, action, data, resolve, reject })),
      showError() {}
    }),
    wx: {
      stopPullDownRefresh: () => {},
      navigateTo: (opts) => navigations.push(opts),
      redirectTo: (opts) => navigations.push(opts),
      showToast: () => {},
      showModal: () => {},
      setClipboardData: (opts) => { if (opts.success) opts.success() },
      getCurrentPages: () => [{ route: 'pages/admin/users/list/index' }]
    }
  })
  page.setData = patch => {
    for (const [k, v] of Object.entries(patch)) {
      if (k.includes('.')) {
        const parts = k.split('.')
        let target = page.data
        for (let i = 0; i < parts.length - 1; i++) {
          if (!target[parts[i]]) target[parts[i]] = {}
          target = target[parts[i]]
        }
        target[parts[parts.length - 1]] = v
      } else {
        page.data[k] = v
      }
    }
  }
  return { page, requests, navigations }
}

test('admin pets list page: load, search, filter and expand notes', async () => {
  const { page, requests, navigations } = setupPetListPage()

  // 1. onLoad with query and onShow triggers load
  page.onLoad({ keyword: encodeURIComponent('张三'), species: 'dog', status: 'qualified' })
  assert.equal(page.data.keyword, '张三')
  assert.equal(page.data.species, 'dog')
  assert.equal(page.data.contestStatus, 'qualified')

  page.onShow()

  const req = requests[0]
  assert.ok(req)
  assert.equal(req.module, 'admin')
  assert.equal(req.action, 'listPets')
  assert.equal(req.data.keyword, '张三')
  assert.equal(req.data.species, 'dog')
  assert.equal(req.data.contestStatus, 'qualified')

  req.resolve({
    list: [
      {
        _id: 'p_101',
        exclusiveId: 'P101',
        name: '豆豆',
        species: 'dog',
        personality: '粘人',
        beautyPhotos: [{ id: '1', fileId: 'cloud://test/doudou.jpg' }],
        owner: { openid: 'owner_101', nickname: '张三' }
      }
    ],
    page: 1,
    hasMore: false,
    total: 1
  })
  await Promise.resolve()

  assert.equal(page.data.pets.length, 1)
  assert.equal(page.data.pets[0].name, '豆豆')
  assert.equal(page.data.pets[0].hasNotes, true)

  // 2. toggleExpand
  assert.equal(page.data.expandedMap['p_101'], undefined)
  page.toggleExpand({ currentTarget: { dataset: { id: 'p_101' } } })
  assert.equal(page.data.expandedMap['p_101'], true)
  page.toggleExpand({ currentTarget: { dataset: { id: 'p_101' } } })
  assert.equal(page.data.expandedMap['p_101'], false)

  // 3. goToOwner
  page.goToOwner({ currentTarget: { dataset: { openid: 'owner_101' } } })
  assert.equal(navigations.length, 1)
  assert.match(navigations[0].url, /owner_101/)
})

test('admin pets list page: disqualify candidate and reinstate candidate', async () => {
  const { page, requests, modals } = setupPetListPage()

  // 1. 打开下架弹窗并提交下架
  page.openDisqualifyModal({
    currentTarget: {
      dataset: { petId: 'p_fake', petName: '小怪兽', exclusiveId: 'PF100' }
    }
  })
  assert.equal(page.data.disqualifyModal.visible, true)
  assert.equal(page.data.disqualifyModal.petId, 'p_fake')
  assert.equal(page.data.disqualifyModal.exclusiveId, 'PF100')

  page.inputDisqualifyReason({ detail: { value: '多次上传网图被举报' } })
  assert.equal(page.data.disqualifyModal.reason, '多次上传网图被举报')

  page.confirmDisqualify()
  const disqReq = requests.find(r => r.module === 'petBeauty' && r.action === 'disqualifyPetBeautyCandidate')
  assert.ok(disqReq)
  assert.equal(disqReq.data.petId, 'p_fake')
  assert.equal(disqReq.data.reason, '多次上传网图被举报')
  disqReq.resolve({ success: true })
  await Promise.resolve()

  assert.equal(page.data.disqualifyModal.visible, false)

  // 2. 恢复参赛资格
  page.reinstateContest({
    currentTarget: {
      dataset: { petId: 'p_fake', petName: '小怪兽' }
    }
  })
  assert.equal(modals.length, 1)
  assert.match(modals[0].title, /恢复最美大赛资格/)
  modals[0].success({ confirm: true })

  const reinReq = requests.find(r => r.module === 'petBeauty' && r.action === 'reinstatePetBeautyCandidate')
  assert.ok(reinReq)
  assert.equal(reinReq.data.petId, 'p_fake')
})

test('admin users list page: provides viewUserPets and formats timestamps and invites', async () => {
  const { page, requests, navigations } = setupUserListPage()

  page.load({ reset: true })
  const req = requests[0]
  assert.ok(req)
  assert.equal(req.module, 'admin')
  assert.equal(req.action, 'listUsers')

  req.resolve({
    list: [
      {
        _id: 'u_1',
        openid: 'openid_client_1',
        nickname: '测试用户',
        createdAt: '2026-01-05 12:30:00',
        updatedAt: '2026-03-01 10:00:00',
        inviteCode: 'CODE123',
        completedOrderCount: 8,
        retroCardCount: 3
      }
    ],
    page: 1,
    hasMore: false,
    total: 1
  })
  await Promise.resolve()

  assert.equal(page.data.users.length, 1)
  const user = page.data.users[0]
  assert.equal(user.createdAtText, '2026-01-05 12:30:00')
  assert.equal(user.updatedAtText, '2026-03-01 10:00:00')
  assert.equal(user.inviteCode, 'CODE123')
  assert.equal(user.completedOrderCount, 8)
  assert.equal(user.retroCardCount, 3)

  // 测试点击“查看TA的宠物”跳转
  page.viewUserPets({ currentTarget: { dataset: { openid: 'openid_client_1' } } })
  assert.equal(navigations.length, 1)
  assert.equal(navigations[0].url, '/pages/admin/pets/list/index?keyword=openid_client_1')
})
