const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function setupStaffCertificationPage({
  profile = null,
  certificationConfig = { zhima: { enabled: true, minScore: 650, rulesText: '需650分', scoreTemplateUrl: 'cloud://tmpl_score', profileTemplateUrl: 'cloud://tmpl_profile' } }
} = {}) {
  const file = path.resolve(__dirname, '../../miniprogram/pages/staff/certification/index.js')
  const localRequire = createRequire(file)
  let page
  const toasts = []
  const previews = []
  const calls = []

  const wx = {
    previewImage: (options) => previews.push(options),
    showToast: (options) => toasts.push(options),
    showLoading: () => {},
    hideLoading: () => {},
    navigateTo: () => {},
    redirectTo: () => {},
    getStorageSync: () => 'day',
    setStorageSync: () => {}
  }
  global.wx = wx
  global.getApp = () => ({ globalData: {} })

  const callFunction = async (name, action, data) => {
    calls.push({ name, action, data })
    if (action === 'getStaffCertificationConfig') return certificationConfig
    if (action === 'getStaffProfile') return profile
    if (action === 'submitStaffProfile') return { _id: 'new_prof', auditStatus: 'pending', ...data }
    return {}
  }

  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page(options) {
      page = { ...options, data: JSON.parse(JSON.stringify(options.data)) }
    },
    require(name) {
      if (name.endsWith('/cloud')) {
        return {
          callFunction,
          showError: (err) => toasts.push({ title: String(err && err.message || err), icon: 'none' })
        }
      }
      return localRequire(name)
    },
    wx,
    getCurrentPages: () => [{ route: 'pages/staff/certification/index' }]
  })

  page.setData = function (patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) {
        if (!target[part]) target[part] = {}
        target = target[part]
      }
      target[parts[parts.length - 1]] = value
    }
  }

  return { page, toasts, previews, calls, wx }
}

test('staff certification page: 芝麻信用分未达门槛或截图不全时前端校验拦截', async () => {
  const { page, toasts, calls } = setupStaffCertificationPage()

  // 1. 模拟 onShow 加载配置
  await page.onShow()
  assert.equal(page.data.zhimaConfig.enabled, true)
  assert.equal(page.data.zhimaConfig.minScore, 650)

  // 基础必填表单填写
  page.setData({
    'form.gender': 'female',
    'form.realName': '王五',
    'form.idCardNumber': '110101199003072383',
    'form.phone': '13900139000',
    'form.serviceAddress': '测试地点',
    'form.serviceLatitude': 31.2,
    'form.serviceLongitude': 121.5,
    'form.idCardFrontFileId': 'cloud://front',
    'form.idCardBackFileId': 'cloud://back',
    'form.facePhotoFileId': 'cloud://face'
  })

  // 2. 芝麻分未填写
  page.submit()
  assert.equal(toasts.some((t) => t.title.includes('请输入有效的芝麻信用分')), true)

  // 3. 芝麻分填写 600（低于 650）拦截
  page.setData({ 'form.zhimaScore': '600' })
  page.submit()
  assert.equal(toasts.some((t) => t.title.includes('芝麻信用分需达到650分方可申请成为宠托师')), true)

  // 4. 芝麻分达到 680，但未上传芝麻分截图拦截
  page.setData({ 'form.zhimaScore': '680' })
  page.submit()
  assert.equal(toasts.some((t) => t.title.includes('请上传支付宝芝麻信用分截图')), true)

  // 5. 传了芝麻分截图，但未上传主页截图拦截
  page.setData({ 'form.zhimaScoreFileId': 'cloud://zhima_score' })
  page.submit()
  assert.equal(toasts.some((t) => t.title.includes('请上传支付宝个人主页截图')), true)

  // 6. 双图齐全，正常发起提交
  page.setData({ 'form.alipayProfileFileId': 'cloud://alipay_profile' })
  page.submit()
  await new Promise((r) => setTimeout(r, 10))
  const submitCall = calls.find((c) => c.action === 'submitStaffProfile')
  assert.ok(submitCall)
  assert.equal(submitCall.data.zhimaScore, '680')
  assert.equal(submitCall.data.zhimaScoreFileId, 'cloud://zhima_score')
  assert.equal(submitCall.data.alipayProfileFileId, 'cloud://alipay_profile')
})

test('staff certification page: 支持点击查看后台上传的截屏示例模板', async () => {
  const { page, previews } = setupStaffCertificationPage()
  await page.onShow()

  page.previewTemplate({ currentTarget: { dataset: { url: 'cloud://tmpl_score' } } })
  assert.equal(previews.length, 1)
  assert.equal(previews[0].urls[0], 'cloud://tmpl_score')

  page.previewTemplate({ currentTarget: { dataset: { url: 'cloud://tmpl_profile' } } })
  assert.equal(previews.length, 2)
  assert.equal(previews[1].urls[0], 'cloud://tmpl_profile')
})

test('wxml verification: 确保宠托师认证与管理端审核详情包含芝麻信用组件及模板结构', () => {
  const certWxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/certification/index.wxml'), 'utf8')
  assert.match(certWxml, /支付宝芝麻信用分认证/)
  assert.match(certWxml, /zhimaScoreFileId/)
  assert.match(certWxml, /alipayProfileFileId/)
  assert.match(certWxml, /查看参考模板/)

  const auditWxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/admin/staff-audit/detail/index.wxml'), 'utf8')
  assert.match(auditWxml, /支付宝芝麻信用核验/)
  assert.match(auditWxml, /zhimaScoreFileId/)
  assert.match(auditWxml, /alipayProfileFileId/)

  const settingsWxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/admin/settings/index.wxml'), 'utf8')
  assert.match(settingsWxml, /宠托师芝麻信用准入/)
  assert.match(settingsWxml, /scoreTemplateUrl/)
  assert.match(settingsWxml, /profileTemplateUrl/)
})
