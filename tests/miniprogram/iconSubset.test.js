const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { optimize } = require('../../scripts/optimize-icons')

test('every used icon is packaged with its font; complete source stays outside mini program', () => {
  const result = optimize(true)
  assert.ok(result.icons > 200)
  assert.ok(result.cssBytes + result.fontBytes < 60000)
  const font = fs.readFileSync(path.join(__dirname, '../../miniprogram/assets/fonts/remixicon.woff2'))
  assert.equal(font.subarray(0, 4).toString(), 'wOF2')
  assert.ok(fs.statSync(path.join(__dirname, '../../scripts/assets/remixicon/source.woff2')).size > result.fontBytes)
})
