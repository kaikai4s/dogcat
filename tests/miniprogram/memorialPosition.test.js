const test = require('node:test'), assert = require('node:assert/strict')
const { safePosition, positionKey } = require('../../miniprogram/packageMemorial/scene/saved-position')
const { PortraitImages } = require('../../miniprogram/packageMemorial/scene/portrait-images')
const { MemorialScene } = require('../../miniprogram/packageMemorial/scene/engine')
const map = require('../../miniprogram/packageMemorial/scene/world-template')
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
test('saved positions are isolated by account/environment and invalid coordinates cannot enter the scene', () => {
  assert.notEqual(positionKey('dev', 'a'), positionKey('dev', 'b'))
  assert.notEqual(positionKey('dev', 'a'), positionKey('prod', 'a'))
  assert.equal(positionKey('dev', ''), '')
  for (const value of [null, { x: NaN, y: 1 }, { x: '1200', y: 1200 }, { x: -1, y: 1400 }, { x: 1e9, y: 1400 }]) assert.equal(safePosition(value), null)
  assert.deepEqual(safePosition(map.spawn), map.spawn)
})
test('scene restores both player and camera, and moves to a walkable neighbor if a memorial occupies the saved spot', () => {
  const saved = { x: map.spawn.x + 60, y: map.spawn.y + 60 }
  const scene = new MemorialScene({ getContext: () => ({}) }, { position: saved })
  assert.deepEqual(scene.player, saved); assert.deepEqual(scene.camera, saved)
  scene.setMemorials([{ ...saved }])
  assert.notDeepEqual(scene.player, saved)
  assert.deepEqual(safePosition(scene.player, [saved]), scene.player)
  assert.ok(Math.hypot(scene.player.x - saved.x, scene.player.y - saved.y) < 180)
})
test('portrait loads are bounded, reuse decoded images, and cannot resurrect a destroyed scene', async () => {
  const waiting = [], changed = [], cache = new PortraitImages(url => new Promise(resolve => waiting.push({ url, resolve })), () => changed.push(1), () => {})
  for (let i = 0; i < 100; i++) cache.get({ id: '' + i, url: 'image/' + i })
  await flush(); assert.equal(waiting.length, 4)
  waiting.forEach(p => p.resolve({ src: p.url })); await flush()
  assert.equal(cache.get({ id: '0', url: 'refreshed-url' }).src, 'image/0')
  cache.get({ id: '4', url: 'image/4' }); await flush()
  cache.destroy(); const before = changed.length; waiting.at(-1).resolve({ src: 'late' }); await flush()
  assert.equal(cache.items.size, 0); assert.equal(changed.length, before)
})
test('failed portrait downloads back off and a refreshed URL can recover immediately', async () => {
  let count = 0, failures = 0
  const cache = new PortraitImages(async url => { count++; if (url === 'expired') throw new Error('403'); return { src: url } }, () => {}, () => failures++, () => 1000)
  cache.get({ id: 'one', url: 'expired' }); await flush()
  for (let i = 0; i < 100; i++) cache.get({ id: 'one', url: 'expired' })
  await flush(); assert.equal(count, 1); assert.equal(failures, 1)
  cache.get({ id: 'one', url: 'fresh' }); await flush()
  assert.equal(cache.get({ id: 'one', url: 'fresh' }).src, 'fresh')
  cache.destroy()
})

test('different gardens persist independent positions while original garden keeps its legacy key', () => {
  assert.equal(positionKey('dev','alice'),'memorial-position:dev:alice:garden-ortho-v2')
  assert.equal(positionKey('dev','alice','garden-ortho-v2'),positionKey('dev','alice'))
  assert.notEqual(positionKey('dev','alice','garden_'+'a'.repeat(32)),positionKey('dev','alice'))
  assert.notEqual(positionKey('dev','alice','garden_'+'a'.repeat(32)),positionKey('dev','alice','garden_'+'b'.repeat(32)))
})
