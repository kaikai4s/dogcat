const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('orders/create has prominent calendar modal, time slot picker, and surcharge badges in WXML & JS', () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.wxml')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const jsPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.js')
  const js = fs.readFileSync(jsPath, 'utf8')

  // 1. WXML 结构验证
  assert.ok(wxml.includes('service-time-card'), 'orders/create WXML must contain service-time-card')
  assert.ok(wxml.includes('openCalendarModal'), 'orders/create WXML must bind openCalendarModal on tap')
  assert.ok(wxml.includes('calendar-modal-sheet'), 'orders/create WXML must contain calendar-modal-sheet')
  assert.ok(wxml.includes('calendar-days-grid'), 'orders/create WXML must contain calendar-days-grid')
  assert.ok(wxml.includes('day-surcharge-badge'), 'orders/create WXML must contain day-surcharge-badge for date surcharges')
  assert.ok(wxml.includes('time-slots-grid'), 'orders/create WXML must contain time-slots-grid')
  assert.ok(wxml.includes('slot-surcharge-tag'), 'orders/create WXML must contain slot-surcharge-tag for time slot surcharges')
  assert.ok(wxml.includes('confirmCalendarSelection'), 'orders/create WXML must have confirmCalendarSelection button')
  assert.ok(wxml.includes('item.type === \'date_surcharge\''), 'orders/create WXML quote card must display date_surcharge')
  assert.ok(wxml.includes('item.type === \'time_surcharge\''), 'orders/create WXML quote card must display time_surcharge')

  // 2. JS 逻辑验证
  assert.ok(js.includes('openCalendarModal()'), 'Page must implement openCalendarModal')
  assert.ok(js.includes('closeCalendarModal()'), 'Page must implement closeCalendarModal')
  assert.ok(js.includes('onTapCalendarDay('), 'Page must implement onTapCalendarDay')
  assert.ok(js.includes('onTapTimeSlot('), 'Page must implement onTapTimeSlot')
  assert.ok(js.includes('confirmCalendarSelection()'), 'Page must implement confirmCalendarSelection')
  assert.ok(js.includes('initPricingSurcharges('), 'Page must implement initPricingSurcharges')
  assert.ok(js.includes('syncCurrentSurchargesUI()'), 'Page must implement syncCurrentSurchargesUI')
})

test('admin/settings has pricing surcharges configuration panel and handlers', () => {
  const adminWxmlPath = path.resolve(__dirname, '../../miniprogram/pages/admin/settings/index.wxml')
  const adminWxml = fs.readFileSync(adminWxmlPath, 'utf8')
  const adminJsPath = path.resolve(__dirname, '../../miniprogram/pages/admin/settings/index.js')
  const adminJs = fs.readFileSync(adminJsPath, 'utf8')

  // 1. WXML 结构验证
  assert.ok(adminWxml.includes('data-panel="pricingSurcharges"'), 'admin settings WXML must include pricingSurcharges card')
  assert.ok(adminWxml.includes('特殊日期加价规则'), 'admin settings WXML must show 特殊日期加价规则')
  assert.ok(adminWxml.includes('特殊时段加价规则'), 'admin settings WXML must show 特殊时段加价规则')
  assert.ok(adminWxml.includes('addDateSurchargeItem'), 'admin settings WXML must have addDateSurchargeItem button')
  assert.ok(adminWxml.includes('addTimeSlotSurchargeItem'), 'admin settings WXML must have addTimeSlotSurchargeItem button')

  // 2. JS 逻辑验证
  assert.ok(adminJs.includes('togglePricingSurchargesEnabled('), 'admin settings JS must implement togglePricingSurchargesEnabled')
  assert.ok(adminJs.includes('addDateSurchargeItem()'), 'admin settings JS must implement addDateSurchargeItem')
  assert.ok(adminJs.includes('deleteDateSurchargeItem('), 'admin settings JS must implement deleteDateSurchargeItem')
  assert.ok(adminJs.includes('addTimeSlotSurchargeItem()'), 'admin settings JS must implement addTimeSlotSurchargeItem')
  assert.ok(adminJs.includes('deleteTimeSlotSurchargeItem('), 'admin settings JS must implement deleteTimeSlotSurchargeItem')
})
