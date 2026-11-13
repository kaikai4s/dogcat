const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const world = require('../../cloudfunctions/api/config/memorial-world.json')
const layout = require('../../cloudfunctions/api/config/memorial-plots.json')
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)
const cells = layout.ids.map(id => world.cells.find(p => p.id === id))
async function fixture() {
  const deleted = []
  const db = createCollectionStore({ users: ['a', 'b', 'admin'].map(openid => ({ _id: openid, openid, nickname: openid, roles: [openid === 'admin' ? 'admin' : 'client'], status: 'active' })) }, { cloudObjectUpdates: true })
  const cloud = { openapi: { security: { msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } }) } },
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f.fileID, tempFileURL: 'https://example.test/image' })) }),
    deleteFile: async ({ fileList }) => { deleted.push(...fileList); return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) } } }
  const context = createContext({ db, cloud })
  let time = Date.parse('2026-11-13T10:00:00Z')
  context.nowMs = () => time
  const handler = require('../../cloudfunctions/api/handlers/memorial')(context)
  const call = (who, action, data = {}) => context.runAdminRequest('memorial', action, data, () => handler(who, action, data))
  const form = { requestId: 'original_request', version: world.version, plotId: cells[0].id, petName: '小白', epitaph: '想念你', date: '2025-01-01' }
  const { id } = await call('a', 'submit', form)
  await call('admin', 'review', { id, status: 'approved' })
  const garden = await call('admin', 'createGarden', { requestId: 'garden_request', name: '星光园', accepting: true })
  const move = { id, locationRevision: 0, requestId: 'move_request', gardenId: garden.id, plotId: cells[0].id, style: 'moon', version: world.version }
  const demolish = { id, locationRevision: 0, requestId: 'demolish_request', confirm: true, confirmName: '小白' }
  const row = id => db.state.platform_configs.find(r => r._id === id)
  return { db, context, cloud, deleted, call, form, id, garden, move, demolish, row, advance: ms => { time += ms } }
}
test('cross-garden relocation preserves memories, portrait, counts, expiry and daily allowance without review', async () => {
  const f = await fixture(), { id, call, row, db } = f
  await call('a', 'saveMemory', { id, revision: 0, text: '一起度过的日子', isPublic: false, images: [], videos: [] })
  const app = row(id), sourceKey = app.plotKey
  const portraitId = 'memorial_portrait_' + hash(id)
  db.state.platform_configs.push({ _id: portraitId, key: 'memorial_portrait', applicationId: id, gardenId: world.version, ownerOpenid: 'a', revision: 3, status: 'pending', note: '花纹', photos: [], asset: { fileId: 'cloud://test/portrait.png' } })
  row(sourceKey).portrait = { fileId: 'cloud://test/portrait.png', uploadId: 'portrait' }
  const status = await call('b', 'offeringStatus', { id })
  await call('b', 'placeOffering', { id, day: status.day, kind: 'flower' })
  const source = structuredClone(row(sourceKey))
  const moved = await call('a', 'relocate', f.move)
  assert.equal(moved.id, id); assert.equal(moved.locationRevision, 1)
  assert.equal(row(sourceKey).status, 'released'); assert.equal(row(sourceKey).portrait, undefined)
  const target = row(row(id).plotKey)
  for (const field of ['portrait', 'offerings', 'offeringScene']) assert.deepEqual(target[field], source[field])
  assert.equal(target.style, 'moon')
  assert.equal(row(portraitId).revision, 3); assert.equal(row(portraitId).gardenId, f.garden.id)
  const detail = await call('a', 'detail', { id })
  assert.equal(detail.draft.text, '一起度过的日子'); assert.equal(detail.gardenId, f.garden.id); assert.equal(detail.locationRevision, 1)
  assert.equal((await call('b', 'placeOffering', { id, day: status.day, kind: 'flower', gardenId: f.garden.id })).duplicate, true)
  assert.equal((await call('b', 'world')).memorials.length, 0)
  assert.equal((await call('b', 'world', { gardenId: f.garden.id })).memorials.length, 1)
  assert.deepEqual(await call('a', 'relocate', f.move), moved)
  const again = await call('a', 'relocate', { ...f.move, locationRevision: 1, requestId: 'move_again', gardenId: world.version })
  assert.equal(again.locationRevision, 2)
  await assert.rejects(call('a', 'relocate', f.move), /位置已更新/)
  await assert.rejects(call('a', 'demolish', f.demolish), /位置已更新/)
})
test('ownership, occupied neighbors, paused gardens, invalid revisions and changed retry payload are rejected', async () => {
  const f = await fixture()
  await assert.rejects(f.call('b', 'relocate', f.move), /主人/)
  await assert.rejects(f.call('b', 'demolish', f.demolish), /主人/)
  await assert.rejects(f.call('a', 'demolish', { ...f.demolish, confirm: false }), /确认/)
  await assert.rejects(f.call('a', 'relocate', { ...f.move, locationRevision: undefined }), /无效/)
  const neighbor = cells.find(p => p.id !== cells[0].id && Math.abs(p.x - cells[0].x) < 128 && Math.abs(p.y - cells[0].y) < 128)
  await f.call('b', 'submit', { ...f.form, plotId: neighbor.id, gardenId: f.garden.id })
  await assert.rejects(f.call('a', 'relocate', f.move), /占用/)
  assert.equal(f.row(f.id).locationRevision, undefined)
  await f.call('admin', 'updateGarden', { id: f.garden.id, revision: 1, name: '星光园', accepting: false })
  await assert.rejects(f.call('a', 'relocate', f.move), /暂停/)
  const same = { ...f.move, gardenId: world.version }
  await f.call('a', 'relocate', same)
  await assert.rejects(f.call('a', 'relocate', { ...same, style: 'arch' }), /内容已改变/)
})
test('demolition archives content for seven days, releases the plot, and retries expired cloud cleanup', async () => {
  const f = await fixture()
  await f.call('a', 'saveMemory', { id: f.id, revision: 0, text: 'cloud://test/unrelated-file', isPublic: true, images: [], videos: [] })
  const memoryId = 'memorial_memory_' + hash(f.id), plot = f.row(f.id).plotKey
  f.row(memoryId).draft.images = [{ fileId: 'cloud://test/photo' }]
  f.db.state.platform_configs.push({ _id: 'media_to_delete', key: 'memorial_media', applicationId: f.id, fileId: 'cloud://test/photo', sourceFileId: 'cloud://test/original' })
  const status = await f.call('b', 'offeringStatus', { id: f.id })
  await f.call('b', 'placeOffering', { id: f.id, kind: 'snack', day: status.day })
  const result = await f.call('a', 'demolish', f.demolish)
  assert.deepEqual(await f.call('a', 'demolish', f.demolish), result)
  assert.equal(f.row(memoryId).key, 'memorial_memory_archived'); assert.equal(f.row(plot).offerings, undefined)
  assert.deepEqual((await f.call('b', 'world')).occupied, [])
  assert.equal((await f.call('a', 'listMine')).list.length, 0)
  assert.ok(f.db.state.admin_notifications.every(n => n.resolved))
  await assert.rejects(f.call('a', 'saveMemory', { id: f.id }), /暂不可查看/)
  await assert.rejects(f.call('b', 'placeOffering', { id: f.id, kind: 'flower', day: status.day }), /不可探望/)
  await f.call('a', 'submit', { ...f.form, requestId: 'replacement_request' })
  await f.context.cleanupMemorials()
  assert.equal(f.deleted.length, 0)
  assert.equal((await f.call('a', 'listRecycle')).list.length, 1)
  f.advance(7 * 86400000)
  const remove = f.cloud.deleteFile
  f.cloud.deleteFile = async () => ({ fileList: [{ status: -1, errMsg: 'temporarily unavailable' }] })
  await f.context.cleanupMemorials()
  assert.ok(f.row('media_to_delete')); assert.ok(f.db.state.platform_configs.find(r => r.key === 'memorial_cleanup'))
  f.cloud.deleteFile = remove
  await f.context.cleanupMemorials(); await f.context.cleanupMemorials()
  assert.equal(f.row('media_to_delete'), undefined)
  assert.equal(f.db.state.platform_configs.some(r => r.key === 'memorial_cleanup'), false)
  assert.ok(f.deleted.includes('cloud://test/photo')); assert.ok(f.deleted.includes('cloud://test/original'))
  assert.equal(f.deleted.includes('cloud://test/unrelated-file'), false)
})
test('save started before relocation uses the current location; save started before demolition cannot recreate memory', async () => {
  for (const action of ['relocate', 'demolish']) {
    const f = await fixture()
    let release, reached
    const blocked = new Promise(r => { reached = r }), gate = new Promise(r => { release = r })
    f.context.checkTextSecurity = async () => { reached(); await gate }
    const handler = require('../../cloudfunctions/api/handlers/memorial')(f.context)
    const saving = handler('a', 'saveMemory', { id: f.id, revision: 0, text: '保存中的回忆', isPublic: false, images: [], videos: [] })
    await blocked
    await f.call('a', action, action === 'relocate' ? f.move : f.demolish)
    release()
    if (action === 'demolish') {
      await assert.rejects(saving, /暂不可查看/)
      assert.equal(f.row('memorial_memory_' + hash(f.id)), undefined)
    } else {
      await saving
      assert.equal(f.row('memorial_memory_' + hash(f.id)).gardenId, f.garden.id)
    }
  }
})
test('concurrent relocation and demolition cannot both consume the same location revision', async () => {
  const f = await fixture()
  const results = await Promise.allSettled([f.call('a', 'relocate', f.move), f.call('a', 'demolish', f.demolish)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(f.db.state.platform_configs.filter(r => r.key === 'memorial_plot' && r.status === 'approved').length, f.row(f.id).status === 'approved' ? 1 : 0)
})

test('a media upload completing after demolition cannot resurrect a ticket and its unused vault is cleaned', async () => {
  const f = await fixture()
  const ticket = await f.call('a', 'prepareMedia', { id: f.id, kind: 'image', extension: 'png', name: 'photo.png' })
  const fileId = 'cloud://test-bucket/' + ticket.cloudPath
  let release, reached
  const blocked = new Promise(r => { reached = r }), gate = new Promise(r => { release = r })
  f.cloud.downloadFile = async () => ({ fileContent: Buffer.from([137, 80, 1, 2]) })
  f.cloud.uploadFile = async () => { reached(); await gate; return { fileID: 'cloud://test/late-vault' } }
  f.context.checkImageSecurity = async () => {}
  const handler = require('../../cloudfunctions/api/handlers/memorial')(f.context)
  const finishing = handler('a', 'finishMedia', { uploadId: ticket.uploadId, fileId })
  await blocked
  await f.call('a', 'demolish', f.demolish)
  f.advance(7 * 86400000)
  await f.context.cleanupMemorials(); await f.context.cleanupMemorials()
  release()
  await assert.rejects(finishing, /暂不可查看/)
  assert.equal(f.row(ticket.uploadId), undefined)
  await f.context.cleanupMemorials()
  assert.ok(f.deleted.includes('cloud://test/late-vault'))
})

test('demolition requires the full pet name and recycle records are private', async () => {
  const f = await fixture()
  for (const confirmName of ['', '小', 'other']) await assert.rejects(f.call('a', 'demolish', { ...f.demolish, confirmName }), /名字不匹配/)
  await f.call('a', 'demolish', f.demolish)
  assert.equal((await f.call('b', 'listRecycle')).list.length, 0)
  await assert.rejects(f.call('b', 'recycleDetail', { id: f.id }), /恢复期/)
  await assert.rejects(f.call('b', 'restore', { id: f.id, original: true, locationRevision: 1, requestId: 'restore_other' }), /主人/)
})
test('restore preserves identity, public and draft content, pending portrait, offerings and daily receipts', async () => {
  const f = await fixture(), memoryId = 'memorial_memory_' + hash(f.id), portraitId = 'memorial_portrait_' + hash(f.id)
  await f.call('a', 'saveMemory', { id: f.id, revision: 0, text: '公开回忆', isPublic: true, images: [], videos: [] })
  await f.call('admin', 'reviewMemory', { id: memoryId, revision: 1, status: 'approved' })
  await f.call('a', 'saveMemory', { id: f.id, revision: 1, text: '等待审核的新回忆', isPublic: true, images: [], videos: [] })
  f.db.state.platform_configs.push({ _id: portraitId, key: 'memorial_portrait', applicationId: f.id, ownerOpenid: 'a', status: 'pending', revision: 2, photos: [], note: '画像说明' })
  const status = await f.call('b', 'offeringStatus', { id: f.id })
  await f.call('b', 'placeOffering', { id: f.id, kind: 'flower', day: status.day })
  const plot = structuredClone(f.row(f.row(f.id).plotKey)), memory = structuredClone(f.row(memoryId))
  const removed = await f.call('a', 'demolish', f.demolish)
  assert.equal(removed.recoverUntil, f.context.nowMs() + 7 * 86400000)
  await f.context.cleanupMemorials()
  assert.equal(f.deleted.length, 0)
  assert.equal((await f.call('admin', 'listMemoriesAdmin', { pendingCountsOnly: true })).pendingCount, 0)
  const restore = { id: f.id, original: true, locationRevision: 1, requestId: 'restore_original' }
  const restored = await f.call('a', 'restore', restore)
  assert.deepEqual(await f.call('a', 'restore', restore), restored)
  assert.equal(restored.locationRevision, 2)
  assert.deepEqual(f.row(memoryId).draft, memory.draft)
  assert.deepEqual(f.row(memoryId).publicContent, memory.publicContent)
  assert.equal(f.row(portraitId).key, 'memorial_portrait'); assert.equal(f.row(portraitId).revision, 2)
  assert.deepEqual(f.row(f.row(f.id).plotKey).offerings, plot.offerings)
  assert.deepEqual(f.row(f.row(f.id).plotKey).offeringScene, plot.offeringScene)
  assert.equal((await f.call('b', 'placeOffering', { id: f.id, kind: 'flower', day: status.day })).duplicate, true)
  assert.equal((await f.call('a', 'listRecycle')).list.length, 0)
  assert.equal((await f.call('admin', 'listMemoriesAdmin', { pendingCountsOnly: true })).pendingCount, 1)
  const notice = f.db.state.admin_notifications.find(n => n._id === 'admin_audit_memorial_memory_' + memoryId + ':2')
  assert.equal(notice.resolved, false)
  f.advance(8 * 86400000); await f.context.cleanupMemorials()
  assert.equal(f.row(f.id).status, 'approved'); assert.ok(f.row(memoryId))
})
test('occupied original plot can be restored in another garden without touching the new occupant', async () => {
  const f = await fixture()
  await f.call('a', 'demolish', f.demolish)
  const other = await f.call('b', 'submit', { ...f.form, petName: '小黑', requestId: 'new_occupant' })
  await f.call('admin', 'review', { id: other.id, status: 'approved' })
  await assert.rejects(f.call('a', 'restore', { id: f.id, original: true, locationRevision: 1, requestId: 'restore_original' }), /占用/)
  await f.call('a', 'restore', { ...f.move, locationRevision: 1, requestId: 'restore_elsewhere' })
  assert.equal(f.row(f.row(other.id).plotKey).applicationId, other.id)
  assert.equal(f.row(f.id).gardenId, f.garden.id)
  assert.equal(f.row(f.id).style, 'moon')
})
test('exact expiration denies restoration even before the cleanup worker runs', async () => {
  const f = await fixture()
  await f.call('a', 'demolish', f.demolish)
  f.advance(7 * 86400000)
  await assert.rejects(f.call('a', 'restore', { id: f.id, original: true, locationRevision: 1, requestId: 'expired_restore' }), /恢复期/)
  assert.equal((await f.call('a', 'listRecycle')).list.length, 0)
  await f.context.cleanupMemorials()
  assert.equal(f.row(f.id).key, 'memorial_demolished')
  assert.equal(f.db.state.platform_configs.some(r => r.key === 'memorial_recovery_plot'), false)
})
test('restore races safely with cleanup, and a second demolition gets a new recovery deadline', async () => {
  const f = await fixture()
  const first = await f.call('a', 'demolish', f.demolish)
  f.advance(6 * 86400000)
  await Promise.all([f.context.cleanupMemorials(), f.call('a', 'restore', { id: f.id, original: true, locationRevision: 1, requestId: 'racing_restore' })])
  const second = await f.call('a', 'demolish', { ...f.demolish, locationRevision: 2, requestId: 'second_demolition' })
  assert.equal(second.recoverUntil - first.recoverUntil, 6 * 86400000)
  f.advance(86400000); await f.context.cleanupMemorials()
  assert.equal(f.row(f.id).key, 'memorial_recycle')
  await assert.rejects(f.call('a', 'restore', { id: f.id, original: true, locationRevision: 1, requestId: 'stale_restore' }), /位置已更新/)
})

test('a lost transaction response must not make cleanup delete an adopted media file', async () => {
  const f = await fixture()
  const ticket = await f.call('a', 'prepareMedia', { id: f.id, kind: 'image', extension: 'png', name: 'kept.png' })
  f.cloud.downloadFile = async () => ({ fileContent: Buffer.from([137, 80, 1, 2]) })
  f.cloud.uploadFile = async () => ({ fileID: 'cloud://test/adopted-photo' })
  f.context.checkImageSecurity = async () => {}
  const handler = require('../../cloudfunctions/api/handlers/memorial')(f.context)
  const run = f.db.runTransaction
  let lost = false
  f.db.runTransaction = async callback => {
    const result = await run(callback)
    if (!lost && f.row(ticket.uploadId)?.status === 'ready') { lost = true; throw new Error('commit acknowledgement lost') }
    return result
  }
  await assert.rejects(handler('a', 'finishMedia', { uploadId: ticket.uploadId, fileId: 'cloud://test/' + ticket.cloudPath }), /acknowledgement/)
  f.db.runTransaction = run
  await f.context.cleanupMemorials()
  assert.equal(f.row(ticket.uploadId).fileId, 'cloud://test/adopted-photo')
  assert.equal(f.deleted.includes('cloud://test/adopted-photo'), false)
  await f.call('a', 'demolish', f.demolish)
  f.advance(7 * 86400000)
  await f.context.cleanupMemorials(); await f.context.cleanupMemorials()
  assert.equal(f.deleted.includes('cloud://test/adopted-photo'), true)
})

test('a lost memory save response must preserve the stored long story through recovery', async () => {
  const f = await fixture(), memoryId = 'memorial_memory_' + hash(f.id)
  f.cloud.uploadFile = async () => ({ fileID: 'cloud://test/adopted-story' })
  const run = f.db.runTransaction
  f.db.runTransaction = async callback => { const result = await run(callback); if (f.row(memoryId)) throw new Error('commit acknowledgement lost'); return result }
  await assert.rejects(f.call('a', 'saveMemory', { id: f.id, revision: 0, text: '想念'.repeat(3000), isPublic: false, images: [], videos: [] }), /acknowledgement/)
  f.db.runTransaction = run
  await f.call('a', 'demolish', f.demolish)
  await f.context.cleanupMemorials()
  assert.equal(f.deleted.includes('cloud://test/adopted-story'), false)
  await f.call('a', 'restore', { id: f.id, original: true, locationRevision: 1, requestId: 'recover_long_story' })
  assert.equal(f.row(memoryId).draft.textFileId, 'cloud://test/adopted-story')
})
