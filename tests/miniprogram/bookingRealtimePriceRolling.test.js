const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('orders/create has realtime price rolling odometer and top price detail modal in WXML, WXSS, and JS', () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.wxml')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const wxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.wxss')
  const wxss = fs.readFileSync(wxssPath, 'utf8')
  const jsPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.js')
  const js = fs.readFileSync(jsPath, 'utf8')

  // 1. 位置关系与统一对齐：照护确认卡片必须位于服务保障规则与取消规则的上方，且共享完全一致的对齐结构与左侧勾选框
  const careConfirmIndex = wxml.indexOf('order-care-card')
  const agreementIndex = wxml.indexOf('id="booking-agreement"')
  assert.ok(careConfirmIndex > 0, 'WXML must contain order-care-card')
  assert.ok(agreementIndex > 0, 'WXML must contain booking-agreement')
  assert.ok(careConfirmIndex < agreementIndex, 'order-care-card must be placed above booking-agreement')
  assert.ok(wxml.includes('class="booking-side-card trust-note agreement-confirm-card care-confirm-card order-care-card'), 'care-confirm-card must share agreement-confirm-card class')
  assert.ok(wxml.includes('toggleCareSyncConfirmed'), 'care confirm must bind toggleCareSyncConfirmed on left cell and header')

  // 2. WXML 结构验证：底栏无“试算价格”按钮，包含预估价、数字滚轮与打开价格详细按钮
  assert.ok(!wxml.includes('quote-btn'), 'Bottom submit bar must not contain quote-btn')
  assert.ok(wxml.includes('price-rolling-container'), 'WXML must contain price-rolling-container')
  assert.ok(wxml.includes('digit-col'), 'WXML must contain digit-col')
  assert.ok(wxml.includes('digit-strip'), 'WXML must contain digit-strip')
  assert.ok(wxml.includes('openPriceDetailModal'), 'WXML must bind openPriceDetailModal')
  assert.ok(wxml.includes('top-price-modal-backdrop'), 'WXML must contain top-price-modal-backdrop')
  assert.ok(wxml.includes('top-price-modal-card'), 'WXML must contain top-price-modal-card')

  // 3. WXSS 样式验证：数字滚动动画与顶部固定弹框动画
  assert.ok(wxss.includes('.price-rolling-container'), 'WXSS must define .price-rolling-container')
  assert.ok(wxss.includes('.digit-strip'), 'WXSS must define .digit-strip transition')
  assert.ok(wxss.includes('topSheetSlideDown'), 'WXSS must define topSheetSlideDown keyframes')
  assert.ok(wxss.includes('.top-price-modal-backdrop'), 'WXSS must define .top-price-modal-backdrop')

  // 4. JS 逻辑验证：包含数字解析、自动算价防抖、实时计算与模态框开关
  assert.ok(js.includes('getPriceDigitsArray('), 'JS must implement getPriceDigitsArray helper')
  assert.ok(js.includes('canAutoQuote()'), 'JS must implement canAutoQuote')
  assert.ok(js.includes('triggerAutoQuote('), 'JS must implement triggerAutoQuote debounce')
  assert.ok(js.includes('calculatePrice('), 'JS must implement calculatePrice')
  assert.ok(js.includes('openPriceDetailModal()'), 'JS must implement openPriceDetailModal')
  assert.ok(js.includes('closePriceDetailModal()'), 'JS must implement closePriceDetailModal')
})
