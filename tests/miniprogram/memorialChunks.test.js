const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const M = require('../../miniprogram/packageMemorial/scene/world-template')
const { ChunkStream, validateChunk } = require('../../miniprogram/packageMemorial/scene/chunks')
const { propBox } = require('../../miniprogram/packageMemorial/scene/terrain')
const { MemorialScene } = require('../../miniprogram/packageMemorial/scene/engine')
const { createCloudChunks } = require('../../miniprogram/packageMemorial/scene/cloud-assets')
const root = path.resolve(__dirname, '../../miniprogram/packageMemorial/assets/world-v2/chunks')
const read = id => JSON.parse(fs.readFileSync(path.join(root, id + '.json'), 'utf8'))
const view = (x, y) => ({ left: x - 200, top: y - 300, right: x + 200, bottom: y + 300 })
const flush = () => new Promise(resolve => setImmediate(resolve))

test('nearby chunks load with limited concurrency, far chunks evict, and revisiting reloads them', async () => {
  let active = 0, maxActive = 0
  const requested = []
  const stream = new ChunkStream(async id => {
    requested.push(id); active++; maxActive = Math.max(active, maxActive)
    await flush(); active--; return read(id)
  })
  await stream.warm(view(1536, 1430))
  while (stream.pending.size) await Promise.all(Array.from(stream.pending.values()))
  const first = Array.from(stream.cache.keys())
  assert.ok(first.length < 48)
  assert.ok(maxActive <= 4)
  await stream.warm(view(2800, 350))
  while (stream.pending.size) await Promise.all(Array.from(stream.pending.values()))
  assert.ok(first.some(id => !stream.cache.has(id)))
  assert.ok(stream.cache.size <= stream.maxCache)
  await stream.warm(view(1536, 1430))
  assert.ok(requested.some(id => requested.filter(x => x === id).length > 1))
  stream.destroy()
})

test('failed visible chunks have an explicit retry, without repeated failing requests every frame', async () => {
  let fail = true, failures = 0
  const stream = new ChunkStream(async id => {
    if (id === '4-3' && fail) { failures++; throw new Error('offline') }
    return read(id)
  })
  await assert.rejects(stream.warm(view(1536, 1430)), /offline/)
  for (let i = 0; i < 100; i++) stream.update(view(1536, 1430))
  assert.equal(failures, 1)
  assert.equal(stream.status().failed, true)
  fail = false; stream.retry(); await stream.warm(view(1536, 1430))
  assert.equal(stream.status().failed, false)
  assert.equal(stream.loadedAt(1536, 1430), true)
  stream.destroy()
})

test('destroyed chunk streams discard late responses and schedule no more downloads', async () => {
  const finishes = [], calls = []
  const stream = new ChunkStream(id => new Promise(resolve => { calls.push(id); finishes.push(() => resolve(read(id))) }))
  stream.update(view(1536, 1430)); await flush()
  assert.equal(calls.length, 4)
  stream.destroy(); finishes.forEach(f => f()); await flush()
  assert.equal(stream.cache.size, 0)
  assert.equal(calls.length, 4)
})

test('every packaged cell has identical dimensions, stable ownership and no overlap with roads or greenery', () => {
  const chunks = fs.readdirSync(root).map(file => read(file.replace('.json', '')))
  const objects = chunks.flatMap(c => c.objects), cells = chunks.flatMap(c => c.cells)
  assert.equal(chunks.length, 48)
  assert.ok(cells.length > 400)
  assert.equal(new Set(cells.map(c => c.id)).size, cells.length)
  for (const chunk of chunks) {
    assert.equal(validateChunk(chunk, chunk.id), chunk)
    for (const cell of chunk.cells) {
      assert.equal(cell.corners[1].x - cell.corners[0].x, 40)
      assert.equal(cell.corners[3].y - cell.corners[0].y, 32)
      assert.equal(Math.floor(cell.corners[0].x / M.CHUNK), chunk.cx)
      assert.equal(Math.floor(cell.corners[0].y / M.CHUNK), chunk.cy)
      assert.ok(cell.corners.every(p => !M.onRoad(p.x, p.y, 12)))
      const center = { x: cell.col * 64 + 32, y: cell.row * 64 + 32 }
      assert.ok(objects.every(o => Math.hypot(center.x - o.x, center.y - o.y) > M.PROPS[o.kind].clearance))
    }
  }
})

test('trees, buildings and future memorials keep identical drawn size across all map depths', () => {
  for (const kind of Object.keys(M.PROPS)) {
    const a = propBox({ kind, x: 400, y: 200 }), b = propBox({ kind, x: 2000, y: 2100 })
    assert.equal(a.width, b.width); assert.equal(a.height, b.height)
  }
  const draws = []
  const ctx = new Proxy({}, { get: (_, key) => (...args) => { if (key === 'drawImage') draws.push(args) }, set: () => true })
  const scene = new MemorialScene({ getContext: () => ctx, cancelAnimationFrame() {} })
  scene.images['boy/idle-sw.png'] = {}
  for (const y of [200, 1100, 2100]) { scene.player.y = y; scene.drawPlayer() }
  assert.equal(new Set(draws.map(d => d[7] + ':' + d[8])).size, 1)
  const scale = scene.scale
  scene.resize(844, 330, 2)
  assert.equal(scene.scale, scale)
})

test('cloud chunk parse failures invalidate their files and loaded regions guard movement', async () => {
  const invalidated = [], resolver = () => Promise.resolve('wxfile://chunk')
  resolver.invalidate = key => invalidated.push(key)
  const load = createCloudChunks(resolver, { getFileSystemManager: () => ({ readFile(o) { o.success({ data: '{broken' }) } }) })
  await assert.rejects(load('4-3'), /区域数据/)
  assert.deepEqual(invalidated, ['world-v2/chunks/4-3.json'])
  const scene = new MemorialScene({ getContext: () => ({}), cancelAnimationFrame() {} }, { loadChunk: id => Promise.resolve(read(id)) })
  assert.equal(scene.canWalk(scene.player), false)
  await scene.chunks.warm(view(scene.player.x, scene.player.y))
  assert.equal(scene.canWalk(scene.player), true)
  scene.objects = scene.chunks.objects()
  assert.equal(scene.canWalk(M.landmarks[0]), false)
  scene.destroy()
})
