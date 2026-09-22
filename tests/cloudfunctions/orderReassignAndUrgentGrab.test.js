const test = require('node:test')
const assert = require('node:assert/strict')
const { formatAssignmentSource, withOrderText } = require('../../miniprogram/utils/format')

test('assignmentSource formatting distinguishes normal and urgent grabs', () => {
  assert.equal(formatAssignmentSource('open_grab'), '普通抢单')
  assert.equal(formatAssignmentSource('urgent_grab'), '加急揭榜抢单')
  assert.equal(formatAssignmentSource('staff_accept'), '宠托师抢单')
  assert.equal(formatAssignmentSource('admin_assign'), '管理员派单')
  assert.equal(formatAssignmentSource('direct_accept'), '指定宠托师接单')
  assert.equal(formatAssignmentSource('admin_urgent_republish'), '平台转加急抢单')

  const order = withOrderText({
    status: 'assigned',
    assignmentSource: 'urgent_grab',
    urgentGrabDurationSeconds: 150
  })
  assert.equal(order.assignmentSourceText, '加急揭榜抢单')
  assert.equal(order.urgentGrabDurationText, '3分钟')

  const fastOrder = withOrderText({
    status: 'assigned',
    assignmentSource: 'urgent_grab',
    urgentGrabDurationSeconds: 45
  })
  assert.equal(fastOrder.urgentGrabDurationText, '45秒')
})

test('acceptOrder marks urgent grab as urgent_grab and records duration and timeline', () => {
  const time = new Date('2026-09-22T14:30:00.000Z')
  const urgentRepublishedAt = new Date('2026-09-22T14:15:00.000Z') // 15分钟前转加急

  // 模拟 acceptOrder 中的判断逻辑
  function determineAssignment(order, publishMode, acceptTime) {
    const isUrgentGrab = Boolean(
      order.isUrgent === true ||
      order.assignmentSource === 'admin_urgent_republish' ||
      (Number(order.urgentBonus || 0) > 0) ||
      (Number(order.urgentStaffReward || 0) > 0)
    )
    const assignmentSource = publishMode === 'direct' ? 'direct_accept' : (isUrgentGrab ? 'urgent_grab' : 'open_grab')

    const assignmentUpdate = {
      status: 'assigned',
      assignmentSource,
      assignedAt: acceptTime
    }
    if (isUrgentGrab && order.urgentRepublishedAt) {
      const urgentTime = new Date(order.urgentRepublishedAt).getTime()
      if (urgentTime > 0) {
        assignmentUpdate.urgentGrabDurationSeconds = Math.max(0, Math.floor((acceptTime.getTime() - urgentTime) / 1000))
      }
    }
    const assignedTitle = publishMode === 'direct' ? '指定宠托师已接单' : (isUrgentGrab ? '加急揭榜抢单' : '宠托师已抢单')
    let timelineDetail = '李* 宠托师'
    if (isUrgentGrab) {
      const durationMin = assignmentUpdate.urgentGrabDurationSeconds != null
        ? Math.ceil(assignmentUpdate.urgentGrabDurationSeconds / 60)
        : null
      const durationText = durationMin != null ? `（加急响应耗时：${durationMin}分钟）` : ''
      timelineDetail = `宠托师（李* 宠托师）已加急揭榜抢单${durationText}，平台加价补贴生效中。`
    }
    return { assignmentUpdate, assignedTitle, timelineDetail }
  }

  // Case 1: 抢加急单
  const urgentOrder = {
    isUrgent: true,
    urgentBonus: 20,
    urgentRepublishedAt
  }
  const result1 = determineAssignment(urgentOrder, 'open', time)
  assert.equal(result1.assignmentUpdate.assignmentSource, 'urgent_grab')
  assert.equal(result1.assignmentUpdate.urgentGrabDurationSeconds, 900) // 15分钟 = 900秒
  assert.equal(result1.assignedTitle, '加急揭榜抢单')
  assert.ok(result1.timelineDetail.includes('加急响应耗时：15分钟'))

  // Case 2: 普通开放单抢单
  const normalOrder = {
    isUrgent: false,
    publishMode: 'open'
  }
  const result2 = determineAssignment(normalOrder, 'open', time)
  assert.equal(result2.assignmentUpdate.assignmentSource, 'open_grab')
  assert.equal(result2.assignmentUpdate.urgentGrabDurationSeconds, undefined)
  assert.equal(result2.assignedTitle, '宠托师已抢单')
})

test('staff service page detects reassignment and prompts safely to return to workbench', () => {
  let modalShown = false
  let modalTitle = ''
  let modalContent = ''
  let reLaunchedUrl = ''
  let timersStopped = false

  global.wx = {
    showModal: ({ title, content, success }) => {
      modalShown = true
      modalTitle = title
      modalContent = content
      if (typeof success === 'function') {
        success({ confirm: true })
      }
    },
    reLaunch: ({ url }) => {
      reLaunchedUrl = url
    },
    redirectTo: ({ url }) => {
      reLaunchedUrl = url
    }
  }

  const staffServicePage = {
    _reassignModalShown: false,
    serviceElapsedTimer: 123,
    earlyStartPollTimer: 456,
    autoTracking: true,
    data: {
      id: 'order_urgent_reassigned_1'
    },
    stopServiceElapsedTimer() {
      timersStopped = true
      this.serviceElapsedTimer = null
    },
    stopEarlyStartPolling() {
      this.earlyStartPollTimer = null
    },
    stopAutoTracking() {
      this.autoTracking = false
    },
    handleOrderReassigned(notice) {
      if (this._reassignModalShown) return
      this._reassignModalShown = true
      this.stopServiceElapsedTimer()
      this.stopEarlyStartPolling()
      this.stopAutoTracking()
      global.wx.showModal({
        title: '订单已被改派',
        content: notice || '该订单因超时未履约已被平台转加急派单',
        showCancel: false,
        confirmText: '返回工作台',
        confirmColor: '#ea580c',
        success: () => {
          global.wx.reLaunch({
            url: '/pages/staff/home/index',
            fail: () => {
              global.wx.redirectTo({ url: '/pages/staff/home/index' })
            }
          })
        }
      })
    },
    checkOrderReassignment(order, myOpenid) {
      const isReassigned = Boolean(
        order.isReassignedToOther ||
        (order.isUrgent && order.status === 'paid' && !order.staffOpenid) ||
        (order.isUrgent && order.assignmentSource === 'admin_urgent_republish' && !order.staffOpenid) ||
        (myOpenid && order.staffOpenid && order.staffOpenid !== myOpenid && (order.originalStaffOpenid === myOpenid || (Array.isArray(order.previousStaffRecords) && order.previousStaffRecords.some(r => r.staffOpenid === myOpenid))))
      )
      if (isReassigned) {
        const notice = order.reassignNotice || (order.isUrgent ? '该订单因超时未履约已被平台转加急派单' : '该订单已被平台改派给其他宠托师')
        this.handleOrderReassigned(notice)
        return true
      }
      return false
    }
  }

  // Case 1: 原宠托师手机端未刷新，处于详情中；管理员将其转为加急待抢单（status: paid, staffOpenid: ''）
  const reassignedUrgentOrder = {
    _id: 'order_urgent_reassigned_1',
    status: 'paid',
    isUrgent: true,
    assignmentSource: 'admin_urgent_republish',
    staffOpenid: '',
    originalStaffOpenid: 'staff_alice',
    reassignNotice: '该订单因超时未履约已被平台转加急派单'
  }

  const triggered = staffServicePage.checkOrderReassignment(reassignedUrgentOrder, 'staff_alice')
  assert.equal(triggered, true)
  assert.equal(modalShown, true)
  assert.equal(modalTitle, '订单已被改派')
  assert.equal(modalContent, '该订单因超时未履约已被平台转加急派单')
  assert.equal(timersStopped, true)
  assert.equal(staffServicePage.autoTracking, false)
  assert.equal(reLaunchedUrl, '/pages/staff/home/index')

  // Case 2: 重置状态，测试加急单被另一位员工抢单后，原员工进入感知
  staffServicePage._reassignModalShown = false
  modalShown = false
  reLaunchedUrl = ''
  const takenByBobOrder = {
    _id: 'order_urgent_reassigned_1',
    status: 'assigned',
    isUrgent: true,
    staffOpenid: 'staff_bob',
    originalStaffOpenid: 'staff_alice',
    isReassignedToOther: true,
    reassignNotice: '该订单因超时未履约已被平台转加急派单'
  }
  const triggered2 = staffServicePage.checkOrderReassignment(takenByBobOrder, 'staff_alice')
  assert.equal(triggered2, true)
  assert.equal(modalShown, true)
  assert.equal(reLaunchedUrl, '/pages/staff/home/index')
})
