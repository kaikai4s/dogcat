const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm')
function fixture(owner = true, overrides = {}) {
  let page; const calls = [], toasts = []
  const detail = { owner, revision: 4, isPublic: false, draft: { text: '一起看夕阳', images: [{ uploadId: 'photo1', url: 'local-photo' }], videos: [{ uploadId: 'video1' }, { uploadId: 'video2' }], music: { uploadId: 'song1' } }, story: null, reviewStatus: 'private' }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packageMemorial/pages/memory'), 'utf8'), {
    Page: def => { page = def }, require: name => name.endsWith('/cloud') ? { callFunction: async (_, action, data) => { calls.push({ action, data }); return action === 'detail' ? detail : overrides.api ? overrides.api(action, data) : {} } } : name.endsWith('/image-upload') ? { prepareImage: overrides.prepareImage } : name.endsWith('/memorial-portrait-layout') ? require('../../miniprogram/packageMemorial/scene/memorial-portrait-layout') : name.endsWith('/plot-number') ? { plotNumber: () => '01-01' } : {},
    wx: { showToast: v => toasts.push(v.title), ...overrides.wx }
  })
  page.setData = values => Object.entries(values).forEach(([key, value]) => { const parts = key.split('.'); let object = page.data; for (const part of parts.slice(0,-1)) object = object[part]; object[parts.at(-1)] = value })
  page._alive = true; page.id = 'app'
  return { page, calls, detail, toasts }
}
test('owner editor sends ordered upload references and revision, visitor preview uses only public story', async () => {
  const { page, calls } = fixture(); await page.load()
  page.edit(); assert.equal(page.data.editing, true)
  page.preview(); assert.equal(page.data.story, null); assert.equal(page.data.previewing, true)
  page.edit(); page.input({ detail: { value: '新的回忆' } }); page.privacy({ detail: { value: true } })
  await page.save()
  const saved = calls.find(c => c.action === 'saveMemory').data
  assert.equal(saved.revision, 4); assert.equal(saved.isPublic, true)
  assert.equal(saved.text, '新的回忆'); assert.deepEqual(Array.from(saved.images), ['photo1'])
  assert.deepEqual(Array.from(saved.videos), ['video1', 'video2']); assert.equal(saved.music, 'song1')
})
test('visitors cannot enter editor or save; busy uploads block save and media removal', async () => {
  const visitor = fixture(false); await visitor.page.load(); visitor.page.edit(); await visitor.page.save()
  assert.equal(visitor.page.data.editing, false); assert.equal(visitor.calls.length, 1)
  const { page, calls } = fixture(); await page.load(); page.data.uploading = true
  await page.save(); page.remove({ currentTarget: { dataset: { kind: 'videos', index: 0 } } })
  assert.deepEqual(calls.map(c => c.action), ['detail', 'portraitDetail']); assert.equal(page.data.draft.videos.length, 2)
})

test('extensionless native video paths upload and remain selectable in the editor', async () => {
  const { page, calls, toasts } = fixture(true, {
    wx: {
      chooseMedia: o => o.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_native_video', size: 123 }] }),
      cloud: { uploadFile: o => { o.success({ fileID: 'cloud://env/video' }); return {} } }
    },
    api: async action => action === 'prepareMedia' ? { cloudPath: 'video.mp4', uploadId: 'new-video', maxBytes: 1024 } : { uploadId: 'new-video', kind: 'video' }
  })
  await page.load(); page.edit()
  await page.addMedia({ currentTarget: { dataset: { kind: 'video' } } })
  assert.equal(calls.find(c => c.action === 'prepareMedia').data.extension, 'mp4')
  assert.equal(page.data.draft.videos.at(-1).uploadId, 'new-video')
  assert.equal(toasts.length, 0)
})
test('leaving during image compression prevents new upload tickets or files', async () => {
  let release, started = false
  const { page, calls } = fixture(true, {
    wx: { chooseMedia: o => o.success({ tempFiles: [{ tempFilePath: '/photo.jpg', size: 100 }] }) },
    prepareImage: () => { started = true; return new Promise(resolve => { release = resolve }) }
  })
  await page.load()
  const upload = page.addMedia({ currentTarget: { dataset: { kind: 'image' } } })
  while (!started) await new Promise(resolve => setImmediate(resolve))
  page.onUnload(); release({ filePath: '/compressed.jpg', extension: '.jpg', size: 80 }); await upload
  assert.deepEqual(calls.map(c => c.action), ['detail', 'portraitDetail'])
})
test('a late upload success after leaving cannot finalize media on a closed page', async () => {
  let uploaded
  const { page, calls } = fixture(true, {
    wx: { chooseMessageFile: o => o.success({ tempFiles: [{ path: '/song.mp3', name: 'song.mp3', size: 30 }] }),
      cloud: { uploadFile: o => { uploaded = o; return { abort() {} } } } },
    api: async () => ({ cloudPath: 'song.mp3', uploadId: 'song', maxBytes: 100 })
  })
  await page.load()
  const upload = page.addMedia({ currentTarget: { dataset: { kind: 'music' } } })
  while (!uploaded) await new Promise(resolve => setImmediate(resolve))
  page.onUnload(); uploaded.success({ fileID: 'cloud://env/song' }); await upload
  assert.equal(calls.some(c => c.action === 'finishMedia'), false)
})

test('story editor counts Unicode characters beyond 5000 without truncating the draft', async () => {
  const { page } = fixture(); await page.load()
  const value = '你🐾'.repeat(4000)
  page.input({ detail: { value } })
  assert.equal(page.data.textCount, 8000); assert.equal(page.data.draft.text, value)
  page.finishEditing(); page.edit(); assert.equal(page.data.draft.text, value)
})
test('owner submits the two distinct portrait photos and current request revision', async () => {
  const { page, calls, toasts } = fixture(true, { api: async action => action === 'portraitDetail' ? { revision: 3, status: 'rejected', photos: [] } : {} })
  await page.load(); await new Promise(resolve => setImmediate(resolve)); page.openPortrait(); assert.equal(page.data.portraitForm, true)
  page.data.portraitPhotos = { front: { uploadId: 'front' }, side: { uploadId: 'side' } }
  page.data.portraitNote = '耳朵有白色花纹'
  page.selectPortraitPose({ currentTarget: { dataset: { pose: 'sleeping' } } })
  await page.submitPortrait()
  const submit = calls.find(c => c.action === 'submitPortrait')
  assert.equal(submit.data.revision, 3); assert.equal(submit.data.front, 'front'); assert.equal(submit.data.side, 'side')
  assert.equal(submit.data.pose, 'sleeping'); assert.equal(submit.data.note, '耳朵有白色花纹'); assert.match(toasts.at(-1), /已提交/)
  page.data.portrait.status = 'pending'; page.openPortrait(); assert.equal(page.data.portraitForm, false)
})

test('entrance selections save with their media and removal cannot leave a stale selection', async () => {
  const { page, calls }=fixture(); await page.load(); page.edit()
  const ev=(kind,id)=>({currentTarget:{dataset:{kind,id}}})
  page.toggleEntrance(ev('images','photo1')); page.toggleEntrance(ev('videos','video1')); page.toggleEntrance(ev('videos','video2'))
  page.remove({currentTarget:{dataset:{kind:'videos',index:0}}})
  await page.save()
  const data=calls.find(c=>c.action==='saveMemory').data
  assert.deepEqual(Array.from(data.entranceImages),['photo1']); assert.deepEqual(Array.from(data.entranceVideos),['video2'])
  const visitor=fixture(false); await visitor.page.load(); visitor.page.toggleEntrance(ev('images','photo1'))
  assert.equal(visitor.page.data.draft.images[0].entrance,undefined)
})

test('portrait pose defaults for old requests, restores sleeping, and is locked while submitting', async () => {
  const { page } = fixture(true, { api: async () => ({ status: 'rejected', revision: 2, pose: 'sleeping', photos: [] }) })
  await page.load(); await page.loadPortrait(); page.openPortrait()
  assert.equal(page.data.portraitPose, 'sleeping'); assert.equal(page.data.portraitPoseLabel, '安心趴睡')
  const choose = pose => page.selectPortraitPose({ currentTarget: { dataset: { pose } } })
  page.data.saving = true; choose('sitting'); assert.equal(page.data.portraitPose, 'sleeping')
  page.data.saving = false; choose('standing'); assert.equal(page.data.portraitPose, 'sleeping')
  delete page.data.portrait.pose; page.openPortrait(); assert.equal(page.data.portraitPose, 'sitting')
})
