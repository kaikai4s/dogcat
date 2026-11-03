const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '../../miniprogram')

test('client assets page renders commission expiration, expired amount and record expiry labels', async () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/client/profile/assets/index.wxml'), 'utf8')
  assert.match(wxml, /commissionValidityDays/)
  assert.match(wxml, /expiredAmount/)
  assert.match(wxml, /stat-expired/)
  assert.match(wxml, /expiresAtText/)
  assert.match(wxml, /record-expired/)
  assert.match(wxml, /amount-expired/)

  let pageConfig = null
  const dummyCloud = {
    callFunction: async (module, action) => {
      if (module === 'finance' && action === 'getUserAssetSummary') {
        return {
          availableAmount: 20,
          expiredAmount: 10,
          withdrawnAmount: 15,
          commissionValidityDays: 30,
          earnings: [
            {
              _id: 'e1',
              sourceType: 'invite_binding',
              amount: 20,
              status: 'available',
              statusText: '可提现',
              expiresAtText: '2026-12-01 到期',
              isExpired: false
            },
            {
              _id: 'e2',
              sourceType: 'invite_binding',
              amount: 10,
              status: 'expired',
              statusText: '已过期',
              expiresAtText: '已于 2026-10-01 过期',
              isExpired: true
            }
          ],
          withdraws: []
        }
      }
      return {}
    },
    showError: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    savePendingInvite: () => {},
    ensureLogin: async () => {},
    loadSystemSettings: async () => ({ maintenance: { invitation: false } }),
    getCachedSystemSettings: () => ({ maintenance: { invitation: false } })
  }

  const context = vm.createContext({
    Page: (cfg) => { pageConfig = cfg },
    require: (name) => {
      if (name.includes('cloud')) return dummyCloud
      if (name.includes('clipboard')) return { copyText: () => {} }
      return {}
    },
    wx: {
      showToast: () => {},
      navigateTo: () => {}
    },
    console
  })

  const jsFile = fs.readFileSync(path.join(root, 'pages/client/profile/assets/index.js'), 'utf8')
  vm.runInContext(jsFile, context)

  const instance = {
    ...pageConfig,
    data: { ...pageConfig.data },
    setData(update, callback) {
      Object.assign(this.data, update)
      if (typeof callback === 'function') callback()
    }
  }

  await instance.load()
  assert.equal(instance.data.summary.availableAmount, 20)
  assert.equal(instance.data.summary.expiredAmount, 10)
  assert.equal(instance.data.summary.commissionValidityDays, 30)
  assert.equal(instance.data.summary.earnings.length, 2)
  assert.equal(instance.data.summary.earnings[0].statusText, '可提现')
  assert.equal(instance.data.summary.earnings[0].isExpired, false)
  assert.equal(instance.data.summary.earnings[1].statusText, '已过期')
  assert.equal(instance.data.summary.earnings[1].isExpired, true)
})

test('admin settings page includes commissionValidityDays in invitation form and normalization', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/admin/settings/index.wxml'), 'utf8')
  assert.match(wxml, /settings\.invitation\.commissionValidityDays/)
  assert.match(wxml, /邀请佣金未提现有效期/)

  const js = fs.readFileSync(path.join(root, 'pages/admin/settings/index.js'), 'utf8')
  assert.match(js, /commissionValidityDays/)
})
