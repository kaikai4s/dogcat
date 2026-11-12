const test = require('node:test')
const assert = require('node:assert/strict')
const { inspectPortrait, inspectAtlas } = require('../../cloudfunctions/api/services/playground-appearance-png')
const { atlas, chunk } = require('../fixtures/appearanceAtlas')

test('a complete portrait PNG with trailing album data retains its pixels and reports the clean stream boundary', () => {
  const bytes = atlas({columns:4,rows:4}), expected = inspectPortrait(bytes)
  for (const suffix of [Buffer.from('\n'), Buffer.alloc(32), Buffer.from('album-extra-data'), bytes]) {
    const result = inspectPortrait(Buffer.concat([bytes,suffix]))
    assert.equal(result.pngBytes, bytes.length)
    assert.equal(result.digest, expected.digest); assert.deepEqual(result.bounds, expected.bounds)
  }
  assert.throws(() => inspectAtlas(Buffer.concat([atlas(), Buffer.from('\n')])), /末尾/)
})
test('portrait decoder still rejects truncation, bad CRC, malformed ending and opaque art', () => {
  const bytes = atlas({columns:4,rows:4}), corrupt = Buffer.from(bytes)
  corrupt[80] ^= 1
  for (const partial of [bytes.subarray(0,70), bytes.subarray(0,-12), bytes.subarray(0,-1)]) {
    assert.throws(() => inspectPortrait(partial), /数据不完整.*重新下载/)
  }
  assert.throws(() => inspectPortrait(corrupt), /校验/)
  assert.throws(() => inspectPortrait(Buffer.concat([bytes.subarray(0,-12),chunk('IEND',Buffer.from('invalid'))])), /结束标记/)
  assert.throws(() => inspectPortrait(atlas({columns:4,rows:4,opaque:true})), /透明背景/)
})
