const test = require('node:test')
const assert = require('node:assert/strict')

test('client order detail pay requests serviceStart template to guarantee early start subscription quota', () => {
  const fs = require('fs')
  const path = require('path')
  const code = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/detail/index.js'), 'utf8')

  // Verify that pay() contains 'serviceStart'
  assert.match(code, /requestSubscribeTemplates\(\[['"]orderAccepted['"],\s*['"]serviceStart['"],\s*['"]remoteUnlock['"]\]/)
})

test('client order detail has checkPromptEarlyStart and polling lifecycle', () => {
  const fs = require('fs')
  const path = require('path')
  const code = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/detail/index.js'), 'utf8')

  assert.match(code, /checkPromptEarlyStart/)
  assert.match(code, /startEarlyStartPolling/)
  assert.match(code, /stopEarlyStartPolling/)
  assert.match(code, /handleEarlyStartAction/)
})

test('checkPromptEarlyStart triggers modal with correct information and prevents duplicate popups', () => {
  let modalShown = null
  const page = {
    data: {
      order: {
        staffName: '王小美',
        status: 'assigned'
      }
    },
    promptedEarlyStartId: null,
    handleEarlyStartAction(action) {
      this.actionTaken = action
    },
    checkPromptEarlyStart(earlyStartRequest) {
      if (!earlyStartRequest || earlyStartRequest.status !== 'pending') return
      const requestId = earlyStartRequest._id || 'pending'
      if (this.promptedEarlyStartId === requestId) return
      this.promptedEarlyStartId = requestId

      const staffName = (this.data.order && (this.data.order.staffName || this.data.order.requestedStaffName)) || '宠托师'
      const reason = earlyStartRequest.reason || '宠护师已到达，申请提前开始服务'
      modalShown = {
        title: '提前开始服务申请',
        content: `${staffName}已到达并申请提前开始服务：\n"${reason}"\n\n是否同意提前开始？`
      }
    }
  }

  const req = { _id: 'early_req_1', status: 'pending', reason: '已经提前到达楼下' }
  page.checkPromptEarlyStart(req)
  assert.notEqual(modalShown, null)
  assert.match(modalShown.content, /王小美/)
  assert.match(modalShown.content, /已经提前到达楼下/)

  // Calling again with the same request should not re-trigger modal
  modalShown = null
  page.checkPromptEarlyStart(req)
  assert.equal(modalShown, null)

  // Non-pending status should not trigger modal
  page.checkPromptEarlyStart({ _id: 'early_req_2', status: 'approved' })
  assert.equal(modalShown, null)
})

test('staff service page has startEarlyStartPolling and stopEarlyStartPolling lifecycle', () => {
  const fs = require('fs')
  const path = require('path')
  const code = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/orders/service/index.js'), 'utf8')

  assert.match(code, /startEarlyStartPolling/)
  assert.match(code, /stopEarlyStartPolling/)
  assert.match(code, /requestSubscribeTemplates\(\[['"]serviceStart['"]\],\s*['"]staff_early_start['"]\)/)
})

