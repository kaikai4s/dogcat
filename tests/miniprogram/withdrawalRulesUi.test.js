const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('client and staff withdrawal pages visibly explain the complete policy', () => {
  const root = path.resolve(__dirname, '../../miniprogram/pages')
  const client = fs.readFileSync(path.join(root, 'client/profile/assets/index.wxml'), 'utf8')
  const staff = fs.readFileSync(path.join(root, 'staff/earnings/index.wxml'), 'utf8')
  for (const page of [client, staff]) {
    assert.match(page, /提现规则/)
    assert.match(page, /提现金额/)
    assert.match(page, /每日次数/)
    assert.match(page, /dailyCountText/)
    assert.match(page, /每日额度/)
    assert.match(page, /申请时间/)
    assert.match(page, /审核与到账/)
    assert.match(page, /withdrawalRules\.arrivalTimeText/)
  }
})
