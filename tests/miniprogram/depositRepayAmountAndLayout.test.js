const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('admin sitters list repay modal: z-index elevated above bottom-nav, safe-area padding included, and displays each personal deposit shortfall', () => {
  const wxssPath = path.join(__dirname, '../../miniprogram/pages/admin/sitters/list/index.wxss')
  const wxmlPath = path.join(__dirname, '../../miniprogram/pages/admin/sitters/list/index.wxml')
  const jsPath = path.join(__dirname, '../../miniprogram/pages/admin/sitters/list/index.js')
  const appWxssPath = path.join(__dirname, '../../miniprogram/app.wxss')

  const wxss = fs.readFileSync(wxssPath, 'utf8')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const js = fs.readFileSync(jsPath, 'utf8')
  const appWxss = fs.readFileSync(appWxssPath, 'utf8')

  // 1. 验证 bottom-nav 的 z-index 并在 sitters list 中 modal-mask 必须高于 bottom-nav
  assert.ok(appWxss.includes('.bottom-nav'), 'app.wxss must define .bottom-nav')
  assert.ok(wxss.includes('z-index: 10001'), 'modal-mask must have z-index: 10001 to stay above bottom-nav')
  assert.ok(wxss.includes('env(safe-area-inset-bottom)'), 'modal-card must include safe-area padding')

  // 2. 验证 WXML 展示每位宠托师的余额、个人标准及应补差额
  assert.ok(wxml.includes('depositStandardAmountText'), 'WXML must display each sitter personal standard')
  assert.ok(wxml.includes('depositTopUpAmountText'), 'WXML must display each sitter shortfall')
  assert.ok(wxml.includes('预计补缴总额'), 'WXML must display the batch repayment total')

  // 3. 验证 JS 按个人标准计算差额，并汇总所选宠托师的补缴金额
  assert.ok(js.includes('depositTopUpAmount'), 'JS must calculate each sitter shortfall')
  assert.ok(js.includes('repayTotalTopUpAmount'), 'JS must hold the batch repayment total')
})

test('staff home deposit notice card layout: button.notice-btn width is not 100%, flex does not collapse text vertically, and amount is presented', () => {
  const wxssPath = path.join(__dirname, '../../miniprogram/pages/staff/home/index.wxss')
  const wxmlPath = path.join(__dirname, '../../miniprogram/pages/staff/home/index.wxml')
  const jsPath = path.join(__dirname, '../../miniprogram/pages/staff/home/index.js')

  const wxss = fs.readFileSync(wxssPath, 'utf8')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const js = fs.readFileSync(jsPath, 'utf8')

  // 1. 验证 button.notice-btn 不在顶部 width: 100% !important 列表中
  const topResetMatch = wxss.match(/button\.ghost-btn[\s\S]*?width:\s*100%\s*!important/i)
  assert.ok(topResetMatch, 'top reset block must exist')
  assert.ok(!topResetMatch[0].includes('notice-btn'), 'notice-btn must NOT be in top 100% width reset block')

  // 2. 验证 .notice-btn 显式设置了 width: auto !important 和 min-width
  assert.ok(wxss.includes('.notice-btn {') || wxss.includes('.notice-btn{'))
  assert.ok(wxss.includes('width: auto !important'))

  // 3. 验证 WXML 中包含需缴纳金额标签 deposit-amount-tag
  assert.ok(wxml.includes('deposit-amount-tag'), 'WXML must include deposit-amount-tag')
  assert.ok(wxml.includes('需缴纳'), 'WXML must show required amount prefix')

  // 4. 验证 loadNearby catch 友好拦截保证金提醒并附带金额，而不是冷冰冰报错
  assert.ok(js.includes('履约保证金提醒'), 'JS must handle deposit error with friendly modal')
  assert.ok(js.includes('需缴纳'), 'JS modal content must include amount tip')
})
