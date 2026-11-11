const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')

for (const TZ of ['UTC','Asia/Shanghai','America/Los_Angeles']) {
  test(`mixed service-track timestamps keep the same Beijing ordering and gaps under ${TZ}`, () => {
    execFileSync(process.execPath,['-e',`
      const assert = require('node:assert/strict')
      for (const file of ['./cloudfunctions/api/utils/trackQuality', './miniprogram/utils/trackQuality',
        './miniprogram/pages/staff/utils/trackQuality', './miniprogram/pages/client/orders/utils/trackQuality',
        './miniprogram/pages/admin/utils/trackQuality']) {
        const quality = require(file)
        const epoch = Date.parse('2026-12-31T16:30:00.321Z')
        for (const input of ['2027-01-01 00:30:00.321','2027/01/01 00:30:00.321','2026-12-31T16:30:00.321Z',epoch]) {
          assert.equal(quality.pointTime(input),epoch,file)
        }
        assert.equal(quality.pointTime('2027-02-29 10:00'),0,file)
        const points = [
          {id:'first',recordedAt:'2027-01-01 00:30:00.321'},
          {id:'second',recordedAt:'2026-12-31T16:30:10.321Z'},
          {id:'third',recordedAt:epoch+20000}
        ].map(point=>({...point,latitude:31.2,longitude:121.5,accuracy:10}))
        const accepted = quality.filterTrackPoints(points)
        assert.deepEqual(accepted.map(point=>point.id),['first','second','third'],file)
        assert.deepEqual(accepted.map(point=>point.breakBefore),[true,false,false],file)
      }
    `],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,TZ},stdio:'pipe'})
  })
}

test('main-package and subpackage track quality helpers match the server rules', () => {
  const root = path.resolve(__dirname, '../../miniprogram')
  const server = fs.readFileSync(path.resolve(__dirname, '../../cloudfunctions/api/utils/trackQuality.js'), 'utf8').replace(/\r\n/g, '\n')
  for (const directory of ['utils', 'pages/staff/utils', 'pages/client/orders/utils', 'pages/admin/utils']) {
    const source = fs.readFileSync(path.join(root, directory, 'trackQuality.js'), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(source, server, `${directory} must use the same track quality rules`)
  }
})

function buildMapData(tracks, checkins) {
  const filename = path.resolve(__dirname, '../../miniprogram/pages/client/orders/tracking/index.js')
  const module = { exports: {} }
  const deps = { navMethods: () => ({}), ...require('../../miniprogram/utils/format') }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { buildMapData }', {
    module, Page() {},
    require(name) { return name.endsWith('/trackQuality') ? require(path.resolve(path.dirname(filename), name)) : deps }
  })
  return module.exports.buildMapData(tracks, checkins)
}
const sample = (recordedAt, extra = {}) => ({ latitude: 31.2, longitude: 121.5, accuracy: 10, recordedAt, ...extra })

test('map excludes checkins from distance, rejects drift and splits background gaps', () => {
  const t = Date.now() - 600000
  const result = buildMapData([
    sample(t), sample(t + 10000, { latitude: 31.2001 }),
    sample(t + 15000, { latitude: 40 }),
    sample(t + 300000, { latitude: 31.3 }), sample(t + 310000, { latitude: 31.3001 })
  ], [sample(t + 5000, { latitude: 41, isBackfilled: true, eventTypeText: '补录照片' })])
  assert.equal(result.validTrackCount, 4)
  assert.equal(result.polyline.length, 2)
  assert.equal(result.trackSummary.distanceText, '22m')
  assert.equal(result.includePoints.some(p => p.latitude >= 40), false)
  assert.equal(result.markers.some(p => p.title.includes('补传')), true)
})

test('map splits explicit tracking segments without drawing a connecting line', () => {
  const t = Date.now() - 60000
  const result = buildMapData([
    sample(t, { segmentId: 'first' }), sample(t + 10000, { latitude: 31.2001, segmentId: 'first' }),
    sample(t + 20000, { latitude: 31.2002, segmentId: 'second' }), sample(t + 30000, { latitude: 31.2003, segmentId: 'second' })
  ], [])
  assert.equal(result.polyline.length, 2)
  assert.equal(result.trackSummary.distanceText, '22m')
})
