const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
global.wx = global.wx || {
  getStorageSync: () => null,
  setStorageSync: () => null,
  removeStorageSync: () => null,
  showToast: () => {},
  showModal: () => {},
  navigateTo: () => {},
  redirectTo: () => {}
}
global.getApp = global.getApp || (() => ({ globalData: {} }))
const {
  getSitterScheduleForDate,
  formatSitterSlotsText,
  checkTimeFitsSitterSchedule
} = require('../../miniprogram/pages/client/orders/create/index.js')

test('sitter schedule parsing & time fitting constraints (pure functions)', () => {
  // 1. 无指定宠托师时全天开放
  const openResult = getSitterScheduleForDate('2026-09-25', null)
  assert.equal(openResult.available, true)
  assert.equal(openResult.slots, null)

  // 2. 指定宠托师且有每周排班 weeklySchedule（周一到周五 09:00-18:00，周末休息）
  const sitterWithWeekly = {
    weeklySchedule: {
      '1': [{ start: 9, end: 18 }],
      '2': [{ start: 9, end: 18 }],
      '3': [{ start: 9, end: 18 }],
      '4': [{ start: 9, end: 18 }],
      '5': [{ start: 9, end: 18 }],
      '6': [],
      '7': []
    }
  }

  // 2026-09-25 是周五 (getDay() === 5)
  const friSchedule = getSitterScheduleForDate('2026-09-25', sitterWithWeekly)
  assert.equal(friSchedule.available, true)
  assert.deepEqual(friSchedule.slots, [{ start: 9, end: 18 }])

  // 2026-09-26 是周六 (getDay() === 6)
  const satSchedule = getSitterScheduleForDate('2026-09-26', sitterWithWeekly)
  assert.equal(satSchedule.available, false)
  assert.ok(satSchedule.reason.includes('不接单'))

  // 2026-09-27 是周日 (getDay() === 0 -> 7)
  const sunSchedule = getSitterScheduleForDate('2026-09-27', sitterWithWeekly)
  assert.equal(sunSchedule.available, false)
  assert.ok(sunSchedule.reason.includes('不接单'))

  // 3. 具体日历数据 sitterAvailability 覆盖（如某周五被设为 unavailable 休息）
  const sitterAvailability = [
    {
      dateKey: '2026-09-25',
      status: 'unavailable',
      slots: []
    },
    {
      dateKey: '2026-09-28',
      status: 'available',
      slots: [{ start: 10, end: 16 }],
      busyOrders: [
        { startTime: '2026-09-28 11:00', endTime: '2026-09-28 12:00' }
      ]
    }
  ]
  const overriddenFri = getSitterScheduleForDate('2026-09-25', sitterWithWeekly, sitterAvailability)
  assert.equal(overriddenFri.available, false)
  assert.ok(overriddenFri.reason.includes('休息'))

  const customMon = getSitterScheduleForDate('2026-09-28', sitterWithWeekly, sitterAvailability)
  assert.equal(customMon.available, true)
  assert.deepEqual(customMon.slots, [{ start: 10, end: 16 }])

  // 4. checkTimeFitsSitterSchedule 时段约束测试
  // 4.1 在时段内 (10:00 - 11:00 在 09:00 - 18:00 内)
  const fitGood = checkTimeFitsSitterSchedule('2026-09-25 10:00', '2026-09-25 11:00', friSchedule)
  assert.equal(fitGood.ok, true)

  // 4.2 早于开始时间 (08:30 - 09:30 超出 09:00 起始点)
  const fitEarly = checkTimeFitsSitterSchedule('2026-09-25 08:30', '2026-09-25 09:30', friSchedule)
  assert.equal(fitEarly.ok, false)
  assert.ok(fitEarly.reason.includes('不在接单时段'))

  // 4.3 晚于结束时间 (17:30 - 18:30 超出 18:00 截止点)
  const fitLate = checkTimeFitsSitterSchedule('2026-09-25 17:30', '2026-09-25 18:30', friSchedule)
  assert.equal(fitLate.ok, false)
  assert.ok(fitLate.reason.includes('不在接单时段'))

  // 4.4 与已有订单冲突 (10:30 - 11:30 与 11:00 - 12:00 重叠)
  const fitConflict = checkTimeFitsSitterSchedule('2026-09-28 10:30', '2026-09-28 11:30', customMon)
  assert.equal(fitConflict.ok, false)
  assert.ok(fitConflict.reason.includes('已被预约'))

  // 4.5 与已有订单无重叠 (13:00 - 14:00 在 10:00-16:00 内且避开 11:00-12:00)
  const fitNoConflict = checkTimeFitsSitterSchedule('2026-09-28 13:00', '2026-09-28 14:00', customMon)
  assert.equal(fitNoConflict.ok, true)
})

test('orders/create page implements sitter schedule constraints in WXML, WXSS and JS', () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.wxml')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const wxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.wxss')
  const wxss = fs.readFileSync(wxssPath, 'utf8')
  const jsPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.js')
  const js = fs.readFileSync(jsPath, 'utf8')

  // 1. WXML 标记与交互提示
  assert.ok(wxml.includes('sitter-schedule-tip'), 'WXML must display sitter-schedule-tip')
  assert.ok(wxml.includes('sitter-disabled'), 'WXML calendar day cell must support sitter-disabled class')
  assert.ok(wxml.includes('day-rest-badge'), 'WXML must display day-rest-badge for unavailable days')
  assert.ok(wxml.includes('slot-disabled-tag'), 'WXML must display slot-disabled-tag for outside schedule')
  assert.ok(wxml.includes('time-warning-pill'), 'WXML must display time-warning-pill on time card')

  // 2. WXSS 样式定义
  assert.ok(wxss.includes('.sitter-schedule-tip'), 'WXSS must define .sitter-schedule-tip')
  assert.ok(wxss.includes('.calendar-day-cell.sitter-disabled'), 'WXSS must define .calendar-day-cell.sitter-disabled')
  assert.ok(wxss.includes('.day-rest-badge'), 'WXSS must define .day-rest-badge')
  assert.ok(wxss.includes('.slot-disabled-tag'), 'WXSS must define .slot-disabled-tag')
  assert.ok(wxss.includes('.time-warning-pill'), 'WXSS must define .time-warning-pill')

  // 3. JS 方法与强拦截
  assert.ok(js.includes('checkSitterScheduleTime('), 'JS must implement checkSitterScheduleTime')
  assert.ok(js.includes('syncSitterScheduleWarning('), 'JS must implement syncSitterScheduleWarning')
  assert.ok(js.includes('outsideSitterSchedule'), 'JS refreshCalendarUI must flag outsideSitterSchedule')
  assert.ok(js.includes('busyConflict'), 'JS refreshCalendarUI must flag busyConflict')
  assert.ok(js.includes('isSitterUnavailable'), 'JS refreshCalendarUI must flag isSitterUnavailable')
  assert.ok(js.includes('confirmCalendarSelection()'), 'JS must implement confirmCalendarSelection')
  assert.ok(js.includes('checkSitterScheduleTime(candidateForm)'), 'confirmCalendarSelection must validate candidateForm')
  assert.ok(js.includes('const timeCheck = this.checkSitterScheduleTime()'), 'validateRequired must call checkSitterScheduleTime')
})
