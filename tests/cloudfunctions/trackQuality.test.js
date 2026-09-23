const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

const time = Date.now() - 60000
function point(id, seconds = 0, extra = {}) {
  return { clientPointId: id, latitude: 31.2 + seconds * 0.00001, longitude: 121.5,
    accuracy: 10, recordedAt: time + seconds * 1000, coordinateType: 'gcj02', locationSource: 'gps', ...extra }
}

for (const path of ['../../cloudfunctions/api/utils/trackQuality', '../../miniprogram/utils/trackQuality']) {
  const quality = require(path)
  test(`${path}: rejects unknown precision, manual points, wrong coordinate system and isolated jumps`, () => {
    const points = [point('a'), point('b', 10), point('jump', 15, { latitude: 40 }), point('c', 20)]
    assert.deepEqual(quality.filterTrackPoints(points).map((p) => p.clientPointId), ['a', 'b', 'c'])
    for (const extra of [{ accuracy: 0 }, { accuracy: -1 }, { accuracy: 201 }, { accuracy: NaN }, { latitude: 91 }, { longitude: 181 }, { locationSource: 'manual' }, { coordinateType: 'wgs84' }]) {
      assert.equal(quality.isGoodTrackPoint(point('invalid', 0, extra)), false)
    }
    assert.deepEqual(quality.filterTrackPoints([point('startup-drift', -10, { latitude: 40 }), ...points]).map((p) => p.clientPointId), ['a', 'b', 'c'])
  })
  test(`${path}: sorts delayed samples by capture time and marks collection gaps and new sessions`, () => {
    const result = quality.filterTrackPoints([point('late', 10, { isBackfilled: true }), point('first'), point('resume', 300, { latitude: 31.3 }), point('restart', 310, { latitude: 31.3001, segmentId: 'new' })].map((p) => ({ segmentId: 'old', ...p })))
    assert.deepEqual(result.map((p) => p.clientPointId), ['first', 'late', 'resume', 'restart'])
    assert.deepEqual(result.map((p) => p.breakBefore), [true, false, true, true])
  })
}

function setup(tracks = []) {
  const db = createCollectionStore({
    users: [{ _id: 's', openid: 'staff', status: 'active', roles: ['staff'] }, { _id: 'c', openid: 'client', status: 'active', roles: ['client'] }],
    orders: [{ _id: 'o', staffOpenid: 'staff', clientOpenid: 'client', status: 'in_service', startedAt: new Date(time - 60000) }],
    track_logs: tracks
  })
  return { db, api: loadCloudFunction('api', db, 'staff') }
}

test('server rejects inaccurate, future and teleport samples without endlessly retrying them', async () => {
  const { db, api } = setup()
  const res = await api.main({ module: 'track', action: 'batchUploadTrack', data: { orderId: 'o', points: [
    point('a'), point('unknown', 1, { accuracy: 0 }), point('bad', 2, { accuracy: 400 }),
    point('teleport', 3, { latitude: 40 }), point('manual', 4, { locationSource: 'manual' }),
    point('future', 3600), point('b', 10)
  ] } })
  assert.equal(res.ok, true, res.message)
  assert.equal(res.data.count, 2)
  assert.equal(res.data.rejectedCount, 5)
  assert.deepEqual(db.state.track_logs.map((p) => p.clientPointId), ['a', 'b'])
})

test('offline uploads preserve capture time, validate both neighbors and remain idempotent', async () => {
  const { db, api } = setup()
  const upload = (points) => api.main({ module: 'track', action: 'batchUploadTrack', data: { orderId: 'o', points } })
  assert.equal((await upload([point('a'), point('c', 20)])).data.count, 2)
  const middle = point('b', 10, { isBackfilled: true })
  assert.equal((await upload([middle])).data.count, 1)
  assert.equal((await upload([middle])).data.duplicateCount, 1)
  assert.equal((await upload([point('bad-late', 15, { latitude: 40, isBackfilled: true })])).data.rejectedCount, 1)
  assert.equal(db.state.track_logs.find((p) => p.clientPointId === 'b').recordedAt, middle.recordedAt)
  const res = await api.main({ module: 'track', action: 'getOrderTracks', data: { orderId: 'o' } })
  assert.deepEqual(res.data.map((p) => p.clientPointId), ['a', 'b', 'c'])
})

test('old raw records remain intact while the displayed route excludes obvious drift', async () => {
  const raw = [point('a'), point('bad', 5, { accuracy: 200 }), point('b', 10), point('jump', 15, { latitude: 40 }), point('c', 20)]
  const { db, api } = setup(raw.map((p) => ({ ...p, _id: p.clientPointId, orderId: 'o' })))
  const res = await api.main({ module: 'track', action: 'getOrderTracks', data: { orderId: 'o' } })
  assert.deepEqual(res.data.map((p) => p.clientPointId), ['a', 'b', 'c'])
  assert.equal(db.state.track_logs.length, 5)
})
