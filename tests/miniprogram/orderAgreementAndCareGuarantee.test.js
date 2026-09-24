const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('care_guarantee agreement configuration and settings linkage', () => {
  const agreementJsPath = path.resolve(__dirname, '../../miniprogram/pages/common/agreement/index.js')
  const agreementJs = fs.readFileSync(agreementJsPath, 'utf8')

  assert.ok(agreementJs.includes('care_guarantee:'), 'agreement/index.js must define care_guarantee config')
  assert.ok(agreementJs.includes('喂养服务保障协议'), 'care_guarantee must have badge and title 喂养服务保障协议')
  assert.ok(agreementJs.includes('《喂养服务保障协议》'), 'care_guarantee must specify 《喂养服务保障协议》')
  assert.ok(agreementJs.includes('一、服务内容与标准化履约'), 'care_guarantee must include service standards')
  assert.ok(agreementJs.includes('二、入户与家庭财产安全保障'), 'care_guarantee must include home safety guarantees')
  assert.ok(agreementJs.includes('三、宠物健康与意外应急保障'), 'care_guarantee must include pet emergency care')
  assert.ok(agreementJs.includes('四、免责与责任边界'), 'care_guarantee must include boundary & force majeure')

  const settingsJsPath = path.resolve(__dirname, '../../miniprogram/pages/client/settings/index.js')
  const settingsJs = fs.readFileSync(settingsJsPath, 'utf8')
  assert.ok(settingsJs.includes("type: 'care_guarantee'"), 'settings page agreement links must include care_guarantee')
  assert.ok(settingsJs.includes('喂养服务保障协议'), 'settings page agreement title must include 喂养服务保障协议')
})

test('orders/create has prominent agreement checkbox and blocks order creation if unchecked', () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.wxml')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const jsPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.js')
  const js = fs.readFileSync(jsPath, 'utf8')

  // 1. WXML structure verification
  assert.ok(wxml.includes('agreement-confirm-card'), 'orders/create WXML must contain agreement-confirm-card')
  assert.ok(wxml.includes('agreement-checkbox'), 'orders/create WXML must contain agreement-checkbox')
  assert.ok(wxml.includes('toggleAgreement'), 'orders/create WXML must bind toggleAgreement')
  assert.ok(wxml.includes('data-type="care_guarantee"'), 'orders/create WXML must link care_guarantee')
  assert.ok(wxml.includes('data-type="refund_cancel"'), 'orders/create WXML must link refund_cancel')
  assert.ok(wxml.includes('data-type="user_service"'), 'orders/create WXML must link user_service')
  assert.ok(wxml.includes('《喂养服务保障协议》'), 'orders/create WXML must display 《喂养服务保障协议》')
  assert.ok(wxml.includes('《退款/取消订单规则》'), 'orders/create WXML must display 《退款/取消订单规则》')

  // 2. JS logic verification
  assert.ok(js.includes('agreeAgreement: false'), 'agreeAgreement must default to false in Page data')
  assert.ok(js.includes('toggleAgreement()'), 'Page must implement toggleAgreement')
  assert.ok(js.includes('if (!this.data.agreeAgreement)'), 'create() must check agreeAgreement before proceeding')
  assert.ok(js.includes('请先阅读并勾选同意服务保障协议与取消规则'), 'create() must prompt toast when agreement not checked')
})
