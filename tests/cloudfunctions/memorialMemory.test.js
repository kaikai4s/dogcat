const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
function fixture(extra = {}) {
  const db = createCollectionStore({ users: ['owner', 'visitor', 'admin'].map(openid => ({ _id: openid, openid, nickname: openid, roles: [openid === 'admin' ? 'admin' : 'client'], status: 'active' })),
    platform_configs: [{ _id: 'app', key: 'memorial_application', ownerOpenid: 'owner', status: 'approved', petName: '小白', plotKey: 'plot', plotId: 'garden-ortho-v2:3:3' },
      { _id: 'plot', key: 'memorial_plot', applicationId: 'app', status: 'approved', petName: '小白', x: 224, y: 224, plotId: 'garden-ortho-v2:3:3' },
      { _id: 'other', key: 'memorial_application', ownerOpenid: 'owner', status: 'approved', petName: '小黑' }], ...extra }, { cloudObjectUpdates: true })
  const files = new Map(), checked = [], signed = []
  const cloud = { downloadFile: async ({ fileID }) => ({ fileContent: files.get(fileID) }),
    uploadFile: async ({ cloudPath, fileContent }) => { const fileID = 'cloud://test.bucket/' + cloudPath; files.set(fileID, fileContent); return { fileID } },
    getTempFileURL: async ({ fileList }) => { signed.push(...fileList); return { fileList: fileList.map(f => ({ fileID: f.fileID, tempFileURL: 'https://signed.test/' + f.fileID })) } },
    openapi: { security: { msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } }) } } }
  const context = createContext({ db, cloud })
  context.checkImageSecurity = async (_, fileId) => { checked.push(fileId) }
  const handler = require('../../cloudfunctions/api/handlers/memorial')(context)
  const call = (who, action, data = {}) => context.runAdminRequest('memorial', action, data, () => handler(who, action, data))
  const save = (revision, extra = {}) => call('owner', 'saveMemory', { id: 'app', text: '它喜欢晒太阳', isPublic: true, images: [], videos: [], music: null, revision, ...extra })
  return { db, call, save, files, checked, signed, cloud }
}
test('private and pending memories never expose draft or media; only an approved revision is public', async () => {
  const f = fixture()
  await f.save(0, { isPublic: false })
  let detail = await f.call('visitor', 'detail', { id: 'app' })
  assert.equal(detail.owner, false); assert.equal(detail.story, null); assert.equal(detail.draft, undefined)
  await assert.rejects(f.call('visitor', 'saveMemory', { id: 'app' }), /只有主人/)
  await f.save(1)
  const row = f.db.state.platform_configs.find(r => r.key === 'memorial_memory')
  assert.equal((await f.call('visitor', 'detail', { id: 'app' })).story, null)
  await assert.rejects(f.call('visitor', 'reviewMemory', { id: row._id, revision: 2, status: 'approved' }), /管理员|权限/)
  await f.call('admin', 'reviewMemory', { id: row._id, revision: 2, status: 'approved' })
  assert.equal((await f.call('visitor', 'detail', { id: 'app' })).story.text, '它喜欢晒太阳')
  await f.save(2, { text: '新草稿待审核' })
  detail = await f.call('visitor', 'detail', { id: 'app' })
  assert.equal(detail.story.text, '它喜欢晒太阳')
  assert.equal((await f.call('owner', 'detail', { id: 'app' })).draft.text, '新草稿待审核')
  await f.save(3, { isPublic: false })
  assert.equal((await f.call('visitor', 'detail', { id: 'app' })).story, null)
  assert.ok(f.db.state.admin_notifications.every(n => n.resolved))
})
test('save conflicts and old review requests cannot overwrite or publish a newer revision', async () => {
  const f = fixture(); await f.save(0)
  const row = f.db.state.platform_configs.find(r => r.key === 'memorial_memory')
  await assert.rejects(f.save(0, { text: '另一份修改' }), /其他页面更新/)
  await f.save(1)
  await assert.rejects(f.call('admin', 'reviewMemory', { id: row._id, revision: 1, status: 'approved' }), /已更新/)
  await f.call('admin', 'reviewMemory', { id: row._id, revision: 2, status: 'rejected', reason: '请补充内容' })
  assert.equal((await f.call('visitor', 'detail', { id: 'app' })).story, null)
  assert.equal(f.db.state.system_notifications.length, 1)
  assert.equal(await f.call('admin', 'listMemoriesAdmin', { pendingCountsOnly: true }).then(r => r.pendingCount), 0)
})
test('uploads require owner, correct path, file signature, limits and per-memorial tickets; validated media is frozen', async () => {
  const f = fixture()
  await assert.rejects(f.call('visitor', 'prepareMedia', { id: 'app', kind: 'image', extension: 'jpg' }), /只有主人/)
  const ticket = await f.call('owner', 'prepareMedia', { id: 'app', kind: 'image', extension: 'jpg', name: '照片' })
  const fileId = 'cloud://test.bucket/' + ticket.cloudPath
  await assert.rejects(f.call('owner', 'finishMedia', { uploadId: ticket.uploadId, fileId: 'cloud://test.bucket/wrong' }), /不匹配/)
  f.files.set(fileId, Buffer.from('not an image'))
  await assert.rejects(f.call('owner', 'finishMedia', { uploadId: ticket.uploadId, fileId }), /类型不符/)
  f.files.set(fileId, Buffer.from([255, 216, 255, 0, 12, 15]))
  await f.call('owner', 'finishMedia', { uploadId: ticket.uploadId, fileId })
  assert.match(f.checked[0], /memorial-memories\/vault\//)
  assert.notEqual(f.checked[0], fileId)
  await f.call('owner', 'finishMedia', { uploadId: ticket.uploadId, fileId })
  await assert.rejects(f.save(0, { videos: [ticket.uploadId] }), /类型不匹配/)
  await assert.rejects(f.save(0, { images: [ticket.uploadId, ticket.uploadId] }), /重复/)
  await assert.rejects(f.save(0, { id: 'other', images: [ticket.uploadId] }), /这处时光小筑/)
  await f.save(0, { images: [ticket.uploadId], isPublic: false })
  await f.call('visitor', 'detail', { id: 'app' }); assert.equal(f.signed.length, 0)
  const own = await f.call('owner', 'detail', { id: 'app' })
  assert.equal(own.draft.images[0].fileId, undefined)
  assert.match(own.draft.images[0].url, /vault/)
})
test('multiple video/image tickets and one music ticket retain ordered content for admin and public detail', async () => {
  const f = fixture(), media = { images: [], videos: [], music: null }
  for (const kind of ['image', 'image', 'video', 'video', 'music']) {
    const ticket = await f.call('owner', 'prepareMedia', { id: 'app', kind, extension: kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : 'mp3' })
    const fileId = 'cloud://test.bucket/' + ticket.cloudPath
    f.files.set(fileId, kind === 'image' ? Buffer.from([255,216,255]) : Buffer.from(kind === 'video' ? '0000ftypvideo' : 'ID3audio'))
    await f.call('owner', 'finishMedia', { uploadId: ticket.uploadId, fileId })
    if (kind === 'music') media.music = ticket.uploadId
    else media[kind === 'image' ? 'images' : 'videos'].push(ticket.uploadId)
  }
  await f.save(0, media)
  const pending = f.db.state.platform_configs.find(r => r.key === 'memorial_memory')
  assert.equal(pending.publicContent, null)
  const snapshot = structuredClone(pending.draft)
  const list = await f.call('admin', 'listMemoriesAdmin')
  assert.equal(list.list[0].memory.videos.length, 2)
  const row = list.list[0]
  await f.call('admin', 'reviewMemory', { id: row._id, revision: row.revision, status: 'approved' })
  assert.deepEqual(f.db.state.platform_configs.find(r => r._id === row._id).publicContent, snapshot)
  const detail = await f.call('visitor', 'detail', { id: 'app' })
  assert.deepEqual(detail.story.images.map(m => m.uploadId), media.images)
  assert.equal(detail.story.videos.length, 2); assert.ok(detail.story.music.url)
})

test('replaying a saved revision or review after a lost response is idempotent without duplicate notices', async () => {
  const f = fixture()
  assert.deepEqual(await f.save(0), await f.save(0))
  assert.equal(f.db.state.admin_notifications.length, 1)
  const row = f.db.state.platform_configs.find(r => r.key === 'memorial_memory')
  const decision = { id: row._id, revision: 1, status: 'approved', reason: '已核对' }
  assert.deepEqual(await f.call('admin', 'reviewMemory', decision), await f.call('admin', 'reviewMemory', decision))
  assert.equal(f.db.state.system_notifications.length, 1)
  assert.equal((await f.save(0)).status, 'approved')
  await assert.rejects(f.call('admin', 'reviewMemory', { ...decision, status: 'rejected' }), /已更新|已审核/)
  await f.save(1, { text: '后续版本', isPublic: false })
  await assert.rejects(f.save(0), /其他页面更新/)
  assert.equal((await f.call('visitor', 'detail', { id: 'app' })).story, null)
})
test('unsupported inherited object keys cannot become media types', async () => {
  const f = fixture()
  for (const kind of ['toString', 'constructor', '__proto__']) {
    await assert.rejects(f.call('owner', 'prepareMedia', { id: 'app', kind, extension: 'mp3' }), /媒体类型/)
  }
})
test('concurrent completion of one media ticket cannot replace the first finalized immutable file', async () => {
  const f = fixture(), gates = []
  const ticket = await f.call('owner', 'prepareMedia', { id: 'app', kind: 'video', extension: 'mp4' })
  const fileId = 'cloud://test.bucket/' + ticket.cloudPath
  f.files.set(fileId, Buffer.from('0000ftypvideo'))
  const upload = f.cloud.uploadFile
  f.cloud.uploadFile = async data => {
    const result = await upload(data)
    await new Promise(resolve => gates.push({ resolve, result }))
    return result
  }
  const a = f.call('owner', 'finishMedia', { uploadId: ticket.uploadId, fileId })
  const b = f.call('owner', 'finishMedia', { uploadId: ticket.uploadId, fileId })
  while (gates.length < 2) await new Promise(resolve => setImmediate(resolve))
  gates[0].resolve(); await a
  const first = f.db.state.platform_configs.find(r => r._id === ticket.uploadId).fileId
  gates[1].resolve(); await b
  assert.equal(f.db.state.platform_configs.find(r => r._id === ticket.uploadId).fileId, first)
})

test('long stories retain every Unicode character, stay private until approval, and publish immutable versions', async () => {
  const f = fixture(), checked = []
  f.cloud.openapi.security.msgSecCheck = async ({ content }) => { checked.push(content); return { errCode: 0, result: { suggest: 'pass' } } }
  const text = '  我们的故事🐾Ａ\n'.repeat(1200)
  await f.save(0, { text })
  const row = f.db.state.platform_configs.find(r => r.key === 'memorial_memory')
  assert.equal(row.draft.text, ''); assert.match(row.draft.textFileId, /vault\/.*\.txt$/)
  assert.equal((await f.call('owner', 'detail', { id: 'app' })).draft.text, text)
  assert.equal((await f.call('visitor', 'detail', { id: 'app' })).story, null)
  assert.equal((await f.call('admin', 'listMemoriesAdmin')).list[0].memory.text, text)
  assert.ok(checked.length > 1 && checked.every(s => Buffer.byteLength(s) <= 1800 && !s.includes('\ufffd')))
  await f.call('admin', 'reviewMemory', { id: row._id, revision: 1, status: 'approved' })
  await f.save(1, { text: text + '新草稿' })
  assert.equal((await f.call('visitor', 'detail', { id: 'app' })).story.text, text)
  await f.save(2, { text, isPublic: false })
  assert.equal((await f.call('visitor', 'detail', { id: 'app' })).story, null)
})

async function portraitPending(f) {
  const ids = []
  for (let i = 0; i < 2; i++) {
    const ticket = await f.call('owner', 'prepareMedia', { id: 'app', kind: 'image', extension: 'jpg' })
    const fileId = 'cloud://test.bucket/' + ticket.cloudPath
    f.files.set(fileId, Buffer.from([255,216,255,1])); await f.call('owner', 'finishMedia', { uploadId: ticket.uploadId, fileId }); ids.push(ticket.uploadId)
  }
  const data = { id: 'app', revision: 0, front: ids[0], side: ids[1], note: '右耳有白色花纹' }
  await f.call('owner', 'submitPortrait', data)
  return { data, row: f.db.state.platform_configs.find(r => r.key === 'memorial_portrait') }
}
test('portrait references are owner/admin-only, exact-app tickets, and repeat submission is idempotent', async () => {
  const f = fixture(), { data, row } = await portraitPending(f)
  await assert.rejects(f.call('visitor', 'portraitDetail', { id: 'app' }), /只有主人/)
  await assert.rejects(f.call('visitor', 'listPortraitsAdmin'), /管理员|权限/)
  await assert.rejects(f.call('owner', 'submitPortrait', { ...data, id: 'other' }), /这个小筑/)
  await assert.rejects(f.call('owner', 'submitPortrait', { ...data, side: data.front }), /分别/)
  await f.call('owner', 'submitPortrait', data)
  assert.equal(f.db.state.admin_notifications.length, 1)
  await assert.rejects(f.call('owner', 'submitPortrait', { ...data, revision: 1 }), /制作中/)
  assert.equal((await f.call('admin', 'listPortraitsAdmin', { pendingCountsOnly: true })).pendingCount, 1)
  const own = await f.call('owner', 'portraitDetail', { id: 'app' })
  assert.equal(own.photos.length, 2); assert.equal(own.photos[0].fileId, undefined)
  assert.equal((await f.call('admin', 'listPortraitsAdmin')).list[0]._id, row._id)
  assert.equal(JSON.stringify(await f.call('visitor', 'world')).includes(data.front), false)
})
test('portrait approval validates PNG pixels and binds immutable art to the correct memorial and world version', async () => {
  const f = fixture(), { row } = await portraitPending(f)
  await assert.rejects(f.call('owner', 'preparePortraitAsset', { id: row._id, revision: 1 }), /管理员|权限/)
  const ticket = await f.call('admin', 'preparePortraitAsset', { id: row._id, revision: 1 })
  const fileId = 'cloud://test.bucket/' + ticket.cloudPath
  const decision = { id: row._id, revision: 1, status: 'approved', uploadId: ticket.uploadId, fileId }
  const { atlas } = require('../fixtures/appearanceAtlas')
  for (const bytes of [Buffer.from('invalid'), atlas({ columns: 4, rows: 4, opaque: true }), atlas({ columns: 1, rows: 1 }), atlas({ columns: 4, rows: 4 }).subarray(0, 99)]) {
    f.files.set(fileId, bytes)
    await assert.rejects(f.call('admin', 'reviewPortrait', decision), /PNG/)
    assert.equal(f.db.state.platform_configs.find(r => r._id === 'plot').portrait, undefined)
  }
  const bytes = atlas({ columns: 4, rows: 4 }); f.files.set(fileId, bytes)
  Object.assign(decision, await f.call('admin', 'preparePortraitAsset', decision), { scale: 1.3 })
  await f.call('admin', 'reviewPortrait', decision)
  const asset = f.db.state.platform_configs.find(r => r._id === 'plot').portrait
  assert.notEqual(asset.fileId, fileId); assert.deepEqual(f.files.get(asset.fileId), bytes)
  const world = await f.call('visitor', 'world')
  assert.equal(world.memorials[0].portrait.id, ticket.uploadId)
  assert.ok(world.memorials[0].portrait.url)
  assert.equal(world.memorials[0].portrait.scale, 1.3); assert.equal(world.memorials[0].portrait.layoutVersion, 1)
  assert.deepEqual(world.memorials[0].portrait.bounds, decision.bounds)
  assert.equal((await f.call('owner', 'portraitDetail', {id:'app'})).result.scale, 1.3)
  assert.equal(world.memorials[0].portrait.fileId, undefined)
  assert.equal(f.db.state.pet_memorial_live.find(r => !r.records).revision, 1)
  assert.equal(f.db.state.admin_notifications[0].resolved, true)
  const count = f.files.size
  await f.call('admin', 'reviewPortrait', decision)
  assert.equal(f.files.size, count); assert.equal(f.db.state.system_notifications.length, 1)
  assert.equal((await f.call('owner', 'portraitDetail', { id: 'app' })).status, 'approved')
})
test('portrait preview accepts a complete PNG with album suffix and approval stores only the verified PNG stream', async () => {
  const f = fixture(), {row} = await portraitPending(f)
  const ticket = await f.call('admin', 'preparePortraitAsset', {id:row._id,revision:1})
  const fileId = 'cloud://test.bucket/' + ticket.cloudPath
  const bytes = require('../fixtures/appearanceAtlas').atlas({columns:4,rows:4})
  f.files.set(fileId, Buffer.concat([bytes,Buffer.from('album-extra-data')]))
  const decision = {id:row._id,revision:1,status:'approved',uploadId:ticket.uploadId,fileId}
  Object.assign(decision, await f.call('admin','preparePortraitAsset',decision))
  await f.call('admin','reviewPortrait',decision)
  const asset = f.db.state.platform_configs.find(r => r._id === 'plot').portrait
  assert.deepEqual(f.files.get(asset.fileId), bytes)
  assert.deepEqual(asset.bounds,decision.bounds)
  assert.equal((await f.call('visitor','world')).memorials[0].portrait.id,ticket.uploadId)
})
test('portrait approval replaces null and legacy snapshots on both records and retains unrelated fields', async () => {
  for (const previous of [null, { uploadId:'old', bounds:null, retiredField:'must disappear', scale:.5 }]) {
    const f=fixture(), {row}=await portraitPending(f)
    const plot=f.db.state.platform_configs.find(r=>r._id==='plot')
    plot.portrait=structuredClone(previous);plot.epitaph='永远想念你'
    row.asset=structuredClone(previous)
    const photos=structuredClone(row.photos)
    const ticket=await f.call('admin','preparePortraitAsset',{id:row._id,revision:1})
    const fileId='cloud://test.bucket/'+ticket.cloudPath
    f.files.set(fileId,require('../fixtures/appearanceAtlas').atlas({columns:4,rows:4}))
    const decision={id:row._id,revision:1,status:'approved',uploadId:ticket.uploadId,fileId}
    Object.assign(decision,await f.call('admin','preparePortraitAsset',decision),{scale:.85})
    await f.call('admin','reviewPortrait',decision)
    const saved=f.db.state.platform_configs.find(r=>r._id===row._id)
    const placed=f.db.state.platform_configs.find(r=>r._id==='plot')
    assert.deepEqual(saved.asset,placed.portrait)
    assert.equal(saved.asset.scale,.85)
    assert.deepEqual(saved.asset.bounds,decision.bounds)
    assert.equal(saved.asset.retiredField,undefined)
    assert.equal(placed.epitaph,'永远想念你');assert.deepEqual(saved.photos,photos)
    assert.equal(saved.status,'approved')
    await f.call('admin','reviewPortrait',decision)
    assert.equal(f.db.state.system_notifications.length,1)
    assert.equal(f.db.state.pet_memorial_live.find(r=>!r.records).revision,1)
  }
})
test('failed portrait transaction rolls back placement and approval together, and the same upload can retry', async () => {
  const f=fixture(), {row}=await portraitPending(f)
  f.db.state.platform_configs.find(r=>r._id==='plot').portrait=null
  const ticket=await f.call('admin','preparePortraitAsset',{id:row._id,revision:1})
  const fileId='cloud://test.bucket/'+ticket.cloudPath
  f.files.set(fileId,require('../fixtures/appearanceAtlas').atlas({columns:4,rows:4}))
  const decision={id:row._id,revision:1,status:'approved',uploadId:ticket.uploadId,fileId}
  Object.assign(decision,await f.call('admin','preparePortraitAsset',decision))
  const transaction=f.db.runTransaction
  let fail=true
  f.db.runTransaction=fn=>transaction(async tx=>{
    const collection=tx.collection
    tx.collection=name=>{
      const col=collection(name),doc=col.doc
      col.doc=id=>{
        const ref=doc(id),update=ref.update
        ref.update=options=>{if(fail&&name==='platform_configs'&&id===row._id)throw new Error('simulated write failure');return update(options)}
        return ref
      }
      return col
    }
    return fn(tx)
  })
  await assert.rejects(f.call('admin','reviewPortrait',decision),/simulated write failure/)
  assert.equal(f.db.state.platform_configs.find(r=>r._id===row._id).asset,null)
  assert.equal(f.db.state.platform_configs.find(r=>r._id===row._id).status,'pending')
  assert.equal(f.db.state.platform_configs.find(r=>r._id==='plot').portrait,null)
  assert.equal((f.db.state.system_notifications||[]).length,0)
  fail=false;await f.call('admin','reviewPortrait',decision)
  assert.equal(f.db.state.platform_configs.find(r=>r._id===row._id).status,'approved')
})
test('republishing short text removes a previous long-story file reference instead of merging stale content', async () => {
  const f=fixture()
  await f.save(0,{text:'陪伴'.repeat(4000)})
  const row=f.db.state.platform_configs.find(r=>r.key==='memorial_memory')
  await f.call('admin','reviewMemory',{id:row._id,revision:1,status:'approved'})
  assert.ok(f.db.state.platform_configs.find(r=>r._id===row._id).publicContent.textFileId)
  await f.save(1,{text:'新的回忆'})
  await f.call('admin','reviewMemory',{id:row._id,revision:2,status:'approved'})
  const published=f.db.state.platform_configs.find(r=>r._id===row._id).publicContent
  assert.equal(published.textFileId,undefined)
  assert.equal((await f.call('visitor','detail',{id:'app'})).story.text,'新的回忆')
})
test('portrait publication cannot revive stale requests or bind to a reassigned plot', async () => {
  const f = fixture(), { data, row } = await portraitPending(f)
  const ticket = await f.call('admin', 'preparePortraitAsset', { id: row._id, revision: 1 })
  const fileId = 'cloud://test.bucket/' + ticket.cloudPath
  f.files.set(fileId, require('../fixtures/appearanceAtlas').atlas({ columns: 4, rows: 4 }))
  const decision = { id: row._id, revision: 1, status: 'approved', uploadId: ticket.uploadId, fileId }
  Object.assign(decision, await f.call('admin', 'preparePortraitAsset', decision))
  f.db.state.platform_configs.find(r => r._id === 'plot').applicationId = 'other'
  await assert.rejects(f.call('admin', 'reviewPortrait', decision), /小筑状态/)
  assert.equal(f.db.state.platform_configs.find(r => r._id === 'plot').portrait, undefined)
  await f.call('admin', 'reviewPortrait', { id: row._id, revision: 1, status: 'rejected', reason: '请补充清晰侧面照' })
  await f.call('owner', 'submitPortrait', { ...data, revision: 1 })
  await assert.rejects(f.call('admin', 'reviewPortrait', decision), /已更新/)
})
test('world signs portrait URLs in bounded batches without leaking reference photos', async () => {
  const f = fixture(), batches = []
  for (let i = 0; i < 101; i++) f.db.state.platform_configs.push({ _id: 'extra' + i, key: 'memorial_plot', status: 'approved', portrait: { uploadId: 'portrait' + i, fileId: 'cloud://test.bucket/art/' + i }, x: 100, y: 100 })
  const sign = f.cloud.getTempFileURL
  f.cloud.getTempFileURL = args => { batches.push(args.fileList.length); return sign(args) }
  const world = await f.call('visitor', 'world')
  assert.deepEqual(batches, [50, 50, 1]); assert.equal(world.memorials.filter(r => r.portrait).length, 101)
})

test('entrance only signs selected approved public media and hides immediately on privacy changes', async () => {
  const f = fixture()
  for (const [id, kind] of [['image1', 'image'], ['image2', 'image'], ['video1', 'video']]) f.db.state.platform_configs.push({ _id:id, key:'memorial_media', applicationId:'app', ownerOpenid:'owner', status:'ready', kind, fileId:'cloud://test.bucket/'+id })
  const refs = { images:['image1','image2'], videos:['video1'], entranceImages:['image2'], entranceVideos:['video1'] }
  await f.save(0, refs)
  assert.deepEqual(await f.call('visitor','entrance',{id:'app'}), {images:[],videos:[]})
  const memory = f.db.state.platform_configs.find(r=>r.key==='memorial_memory')
  await f.call('admin','reviewMemory',{id:memory._id,revision:1,status:'approved'})
  f.signed.length = 0
  const result = await f.call('visitor','entrance',{id:'app'})
  assert.deepEqual(result.images.map(m=>m.uploadId), ['image2']); assert.deepEqual(result.videos.map(m=>m.uploadId), ['video1'])
  assert.deepEqual(f.signed.map(f=>f.fileID).sort(), ['cloud://test.bucket/image2','cloud://test.bucket/video1'])
  assert.equal(result.text, undefined); assert.equal(JSON.stringify(result).includes('fileId'), false)
  await f.save(1,{...refs,entranceImages:['image1'],entranceVideos:[]})
  assert.deepEqual((await f.call('owner','entrance',{id:'app'})).images.map(m=>m.uploadId), ['image2'])
  await f.save(2,{...refs,isPublic:false})
  f.signed.length=0
  assert.deepEqual(await f.call('visitor','entrance',{id:'app'}),{images:[],videos:[]})
  assert.equal(f.signed.length,0)
})
test('entrance selection validates membership, type and duplicates and participates in save conflicts', async () => {
  const f=fixture()
  f.db.state.platform_configs.push({_id:'image1',key:'memorial_media',applicationId:'app',ownerOpenid:'owner',status:'ready',kind:'image',fileId:'cloud://test.bucket/image1'})
  for (const extra of [{entranceImages:['foreign']},{entranceImages:['image1','image1']},{entranceVideos:['image1']},{entranceImages:'image1'}]) await assert.rejects(f.save(0,{images:['image1'],...extra}), /入口展示/)
  const saved=await f.save(0,{images:['image1'],entranceImages:['image1']})
  assert.deepEqual(await f.save(0,{images:['image1'],entranceImages:['image1']}),saved)
  await assert.rejects(f.save(0,{images:['image1'],entranceImages:[]}), /其他页面/)
  await assert.rejects(f.call('visitor','entrance',{id:'missing'}), /暂不可查看/)
})

async function memoryWithMedia(f, isPublic = true) {
  for (const [id,kind] of [['photo-a','image'],['photo-b','image'],['video-a','video'],['video-b','video']]) {
    f.db.state.platform_configs.push({_id:id,key:'memorial_media',ownerOpenid:'owner',applicationId:'app',status:'ready',kind,fileId:'cloud://test.bucket/'+id})
  }
  await f.save(0,{isPublic,images:['photo-a','photo-b'],videos:['video-a','video-b'],entranceImages:['photo-a'],entranceVideos:['video-a']})
  const row=f.db.state.platform_configs.find(r=>r.key==='memorial_memory')
  if(isPublic)await f.call('admin','reviewMemory',{id:row._id,revision:1,status:'approved'})
  return row._id
}
const mediaChange = (mediaRevision, extra = {}) => ({id:'app',revision:1,mediaRevision,kind:'images',operation:'entrance',uploadId:'photo-a',enabled:false,...extra})

test('entrance toggles immediately update approved media without a new review; identical retries are idempotent', async () => {
  const f=fixture(),id=await memoryWithMedia(f)
  const notices=f.db.state.admin_notifications.length, decisions=f.db.state.system_notifications.length
  const off=mediaChange(0)
  const result=await f.call('owner','updateMemoryMedia',off)
  assert.deepEqual(await f.call('owner','updateMemoryMedia',off),result)
  assert.equal(result.revision,1);assert.equal(result.mediaRevision,1);assert.equal(result.reviewStatus,'approved')
  assert.deepEqual((await f.call('visitor','entrance',{id:'app'})).images,[])
  assert.equal((await f.call('owner','detail',{id:'app'})).draft.images[0].entrance,false)
  await f.call('owner','updateMemoryMedia',mediaChange(1,{enabled:true}))
  assert.deepEqual((await f.call('visitor','entrance',{id:'app'})).images.map(m=>m.uploadId),['photo-a'])
  const row=f.db.state.platform_configs.find(r=>r._id===id)
  assert.equal(row.revision,1);assert.equal(row.status,'approved');assert.equal(row.mediaRevision,2)
  assert.equal(f.db.state.admin_notifications.length,notices);assert.equal(f.db.state.system_notifications.length,decisions)
  assert.equal((await f.call('admin','listMemoriesAdmin',{pendingCountsOnly:true})).pendingCount,0)
  assert.equal(f.db.state.pet_memorial_live[0].revision,3) // approval + two real changes, no retry event
})

test('photo and video removal immediately disappear from public detail, entrance and draft without review', async () => {
  const f=fixture();await memoryWithMedia(f)
  const change=mediaChange(0,{operation:'remove'})
  const removed=await f.call('owner','updateMemoryMedia',change)
  assert.deepEqual(await f.call('owner','updateMemoryMedia',change),removed)
  await f.call('owner','updateMemoryMedia',mediaChange(1,{kind:'videos',uploadId:'video-a',operation:'remove'}))
  const owner=await f.call('owner','detail',{id:'app'}), visitor=await f.call('visitor','detail',{id:'app'})
  for(const snapshot of [owner.draft,owner.story,visitor.story]) {
    assert.deepEqual(snapshot.images.map(m=>m.uploadId),['photo-b'])
    assert.deepEqual(snapshot.videos.map(m=>m.uploadId),['video-b'])
  }
  assert.deepEqual(await f.call('visitor','entrance',{id:'app'}),{images:[],videos:[]})
  assert.equal(owner.reviewStatus,'approved');assert.equal(owner.revision,1);assert.equal(owner.mediaRevision,2)
  assert.equal(f.db.state.admin_notifications.length,1)
  await assert.rejects(f.save(1,{images:['photo-a','photo-b'],videos:['video-a','video-b']}),/展示设置或照片已更新/)
  await assert.rejects(f.save(0,{images:['photo-a','photo-b'],videos:['video-a','video-b'],entranceImages:['photo-a'],entranceVideos:['video-a']}),/展示设置或照片已更新/)
  await f.save(1,{mediaRevision:2,text:'真正新增的故事',images:['photo-b'],videos:['video-b']})
  assert.equal((await f.call('visitor','detail',{id:'app'})).story.text,'它喜欢晒太阳')
  assert.equal((await f.call('owner','detail',{id:'app'})).reviewStatus,'pending')
})

test('immediate operations never publish pending text or new uploads and an old reviewer cannot restore deleted media', async () => {
  const f=fixture(),id=await memoryWithMedia(f)
  f.db.state.platform_configs.push({_id:'new-photo',key:'memorial_media',ownerOpenid:'owner',applicationId:'app',status:'ready',kind:'image',fileId:'cloud://test.bucket/new-photo'})
  await f.save(1,{text:'尚未审核的新故事',images:['photo-a','photo-b','new-photo'],videos:['video-a'],entranceImages:['photo-a']})
  await f.call('owner','updateMemoryMedia',mediaChange(0,{revision:2,uploadId:'new-photo',enabled:true}))
  let visitor=await f.call('visitor','detail',{id:'app'})
  assert.equal(visitor.story.text,'它喜欢晒太阳');assert.equal(visitor.story.images.some(m=>m.uploadId==='new-photo'),false)
  const listed=(await f.call('admin','listMemoriesAdmin')).list[0]
  await f.call('owner','updateMemoryMedia',mediaChange(1,{revision:2,operation:'remove'}))
  visitor=await f.call('visitor','detail',{id:'app'})
  assert.deepEqual(visitor.story.images.map(m=>m.uploadId),['photo-b'])
  assert.equal((await f.call('owner','detail',{id:'app'})).reviewStatus,'pending')
  assert.equal(f.db.state.admin_notifications.length,2)
  await f.call('admin','reviewMemory',{id,revision:listed.revision,status:'approved'})
  visitor=await f.call('visitor','detail',{id:'app'})
  assert.equal(visitor.story.text,'尚未审核的新故事')
  assert.deepEqual(visitor.story.images.map(m=>m.uploadId),['photo-b','new-photo'])
  assert.deepEqual((await f.call('visitor','entrance',{id:'app'})).images.map(m=>m.uploadId),['new-photo'])
})

test('private or first pending memory mutations preserve a null public snapshot and reject foreign or invalid operations', async () => {
  const f=fixture();await memoryWithMedia(f,false)
  await f.call('owner','updateMemoryMedia',mediaChange(0))
  await f.call('owner','updateMemoryMedia',mediaChange(1,{operation:'remove'}))
  const row=f.db.state.platform_configs.find(r=>r.key==='memorial_memory')
  assert.equal(row.publicContent,null);assert.equal(row.status,'private')
  assert.equal((await f.call('visitor','detail',{id:'app'})).story,null)
  await assert.rejects(f.call('visitor','updateMemoryMedia',mediaChange(2)),/只有主人/)
  await assert.rejects(f.call('owner','updateMemoryMedia',mediaChange(2,{uploadId:'foreign'})),/已被移除/)
  for(const extra of [{kind:'music'},{kind:'__proto__'},{operation:'replace'},{enabled:'true'},{mediaRevision:-1},{revision:NaN}]) {
    await assert.rejects(f.call('owner','updateMemoryMedia',mediaChange(2,extra)),/操作无效/)
  }
  await assert.rejects(f.call('owner','updateMemoryMedia',mediaChange(0,{uploadId:'photo-b'})),/展示设置或照片已更新/)
  await assert.rejects(f.call('owner','updateMemoryMedia',mediaChange(2,{revision:0})),/其他页面更新/)
  const pending=fixture();const pendingId=await memoryWithMedia(pending,false)
  await pending.save(1,{images:['photo-a']})
  await pending.call('owner','updateMemoryMedia',mediaChange(0,{revision:2,enabled:true}))
  assert.equal(pending.db.state.platform_configs.find(r=>r._id===pendingId).publicContent,null)
  assert.deepEqual(await pending.call('visitor','entrance',{id:'app'}),{images:[],videos:[]})
})

test('immediate removal rolls back both snapshots when the scene notification write fails', async () => {
  const f=fixture(),id=await memoryWithMedia(f)
  const before=structuredClone(f.db.state.platform_configs.find(r=>r._id===id)),transaction=f.db.runTransaction
  f.db.runTransaction=fn=>transaction(async tx=>{
    const collection=tx.collection
    tx.collection=name=>{
      if(name==='pet_memorial_live')throw new Error('simulated notification failure')
      return collection(name)
    }
    return fn(tx)
  })
  await assert.rejects(f.call('owner','updateMemoryMedia',mediaChange(0,{operation:'remove'})),/simulated notification failure/)
  assert.deepEqual(f.db.state.platform_configs.find(r=>r._id===id),before)
})
test('user archive reads private draft only behind explicit admin permission', async () => {
  const f=fixture(); await f.save(0,{isPublic:false,text:'私密故事'})
  await assert.rejects(f.call('visitor','getMemorialAdmin',{id:'app'}), /管理员|权限/)
  await assert.rejects(f.call('visitor','listUserMemorialsAdmin',{openid:'owner'}), /管理员|权限/)
  const list=await f.call('admin','listUserMemorialsAdmin',{openid:'owner'})
  assert.equal(list.list.length,2); assert.equal(list.list[0].ownerOpenid,'owner')
  const detail=await f.call('admin','getMemorialAdmin',{id:'app'})
  assert.equal(detail.draft.text,'私密故事'); assert.equal(detail.story,null); assert.equal(detail.gardenName,'时光纪念园')
  const limited=fixture({admin_access_config:[{_id:'policy',enabled:true,ownerOpenid:'super'}],admin_memberships:[{_id:'admin',groupIds:['archive-list']}],admin_groups:[{_id:'archive-list',enabled:true,permissions:['memorial.listUserMemorialsAdmin']}]})
  assert.equal((await limited.call('admin','listUserMemorialsAdmin',{openid:'owner'})).list.length,2)
  await assert.rejects(limited.call('admin','getMemorialAdmin',{id:'app'}),/权限/)
})

test('portrait pose is validated, retained for owner/reviewer, and participates in retries', async () => {
  const f=fixture(), {data,row}=await portraitPending(f)
  assert.equal((await f.call('owner','portraitDetail',{id:'app'})).pose,'sitting')
  await assert.rejects(f.call('owner','submitPortrait',{...data,pose:'standing'}),/姿势/)
  await assert.rejects(f.call('owner','submitPortrait',{...data,pose:'sleeping'}),/更新/)
  await f.call('admin','reviewPortrait',{id:row._id,revision:1,status:'rejected',reason:'请补充照片'})
  await f.call('owner','submitPortrait',{...data,revision:1,pose:'sleeping'})
  await f.call('owner','submitPortrait',{...data,revision:1,pose:'sleeping'})
  const listed=(await f.call('admin','listPortraitsAdmin')).list[0]
  assert.equal(listed.pose,'sleeping');assert.equal(listed.legacy,true);assert.equal(listed.style,'arch')
  f.db.state.platform_configs.find(r=>r._id==='plot').footprint=2
  f.db.state.platform_configs.find(r=>r._id==='plot').style='cottage'
  const detail=await f.call('owner','portraitDetail',{id:'app'});assert.equal(detail.pose,'sleeping');assert.equal(detail.legacy,false);assert.equal(detail.style,'cottage')
})
test('placement preview requires the exact upload owner/revision and detects changed PNG pixels before publication', async () => {
  const f=fixture(), {row}=await portraitPending(f)
  const ticket=await f.call('admin','preparePortraitAsset',{id:row._id,revision:1})
  const fileId='cloud://test.bucket/'+ticket.cloudPath, data={id:row._id,revision:1,uploadId:ticket.uploadId,fileId}
  const {atlas}=require('../fixtures/appearanceAtlas');f.files.set(fileId,atlas({columns:4,rows:4}))
  await assert.rejects(f.call('owner','preparePortraitAsset',data),/管理员|权限/)
  await assert.rejects(f.call('admin','preparePortraitAsset',{...data,revision:2}),/变化/)
  await assert.rejects(f.call('admin','preparePortraitAsset',{...data,fileId:'cloud://test.bucket/other'}),/当前申请/)
  const preview=await f.call('admin','preparePortraitAsset',data)
  assert.deepEqual(preview.bounds,{x:49,y:31,width:413,height:468})
  const decision={...data,status:'approved',previewDigest:preview.previewDigest,scale:1.2,bounds:{x:0,y:0,width:1,height:1}}
  for(const scale of [0,NaN,Infinity,'1',1.41])await assert.rejects(f.call('admin','reviewPortrait',{...decision,scale}),/大小/)
  f.files.set(fileId,atlas({columns:4,rows:4,color:190}))
  await assert.rejects(f.call('admin','reviewPortrait',decision),/预览不一致/)
  assert.equal(f.db.state.platform_configs.find(r=>r._id==='plot').portrait,undefined)
  f.files.set(fileId,atlas({columns:4,rows:4}));await f.call('admin','reviewPortrait',decision)
  assert.deepEqual(f.db.state.platform_configs.find(r=>r._id==='plot').portrait.bounds,preview.bounds)
  await f.call('admin','reviewPortrait',decision)
  await assert.rejects(f.call('admin','reviewPortrait',{...decision,scale:1}),/处理/)
})
