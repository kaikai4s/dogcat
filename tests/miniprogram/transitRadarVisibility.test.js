const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('client order detail only shows the transit radar while the sitter is on the way', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/detail/index.wxml'), 'utf8')

  assert.match(wxml, /class="card radar-card" wx:if="\{\{order\.status === 'on_the_way'\}\}"/)
  assert.doesNotMatch(wxml, /radar-card" wx:if="\{\{order\.status === 'on_the_way' \|\| order\.travelEtaMinutes !== undefined\}\}"/)
})
