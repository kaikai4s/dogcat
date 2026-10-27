const test = require('node:test')
const assert = require('node:assert/strict')
const { safeDecodeCity, locationCity } = require('../../miniprogram/pages/common/community-map/utils')

test('communityMap safeDecodeCity handles encoded, raw, and nested city names', () => {
  assert.equal(safeDecodeCity('%E6%88%90%E9%83%BD'), '成都')
  assert.equal(safeDecodeCity('%E5%8C%97%E4%BA%AC%E5%B8%82'), '北京市')
  assert.equal(safeDecodeCity('成都'), '成都')
  assert.equal(safeDecodeCity('  深圳市  '), '深圳市')
  assert.equal(safeDecodeCity('%25E6%2588%2590%25E9%2583%25BD'), '成都')
  assert.equal(safeDecodeCity(''), '')
  assert.equal(safeDecodeCity(null), '')
  assert.equal(safeDecodeCity(undefined), '')
})

test('locationCity decodes encoded city inside location object', () => {
  assert.equal(locationCity({ city: '%E6%88%90%E9%83%BD' }), '成都')
  assert.equal(locationCity({ city: '成都市' }), '成都市')
  assert.equal(locationCity({ address: '四川省成都市武侯区', name: '某小区' }), '成都市')
})
