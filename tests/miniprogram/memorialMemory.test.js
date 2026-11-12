const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm')
function fixture(owner = true, overrides = {}) {
  let page; const calls = [], toasts = []
  const detail = { owner, revision: 4, mediaRevision: 0, isPublic: false, draft: { text: '一起看夕阳', images: [{ uploadId: 'photo1', url: 'local-photo' }], videos: [{ uploadId: 'video1' }, { uploadId: 'video2' }], music: { uploadId: 'song1' } }, story: null, reviewStatus: 'private' }
  async function api(_, action, data) {
    calls.push({ action, data })
    if (action === 'detail') return structuredClone(detail)
    if (overrides.api) return overrides.api(action, data)
    if (action === 'updateMemoryMedia') {
      for (const snapshot of [detail.draft, detail.story]) if (snapshot) snapshot[data.kind] = data.operation === 'remove'
        ? snapshot[data.kind].filter(m => m.uploadId !== data.uploadId)
        : snapshot[data.kind].map(m => m.uploadId === data.uploadId ? { ...m, entrance: data.enabled } : m)
      detail.mediaRevision++
      return structuredClone({ revision: detail.revision, mediaRevision: detail.mediaRevision, reviewStatus: detail.reviewStatus, story: detail.story, hasPublicStory: !!detail.story })
    }
    return {}
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packageMemorial/pages/memory'), 'utf8'), {
    Page: def => { page = def }, require: name => name.endsWith('/cloud') ? { callFunction: api } : name.endsWith('/image-upload') ? { prepareImage: overrides.prepareImage } : name.endsWith('/memorial-portrait-layout') ? require('../../miniprogram/packageMemorial/scene/memorial-portrait-layout') : name.endsWith('/plot-number') ? { plotNumber: () => '01-01' } : {},
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

test('entrance selections and media removal persist immediately without submitting another review', async () => {
  const { page, calls }=fixture(); await page.load(); page.edit()
  const ev=(kind,id)=>({currentTarget:{dataset:{kind,id}}})
  await page.toggleEntrance(ev('images','photo1')); await page.toggleEntrance(ev('videos','video1')); await page.toggleEntrance(ev('videos','video2'))
  await page.remove({currentTarget:{dataset:{kind:'videos',index:0}}})
  await page.save()
  assert.equal(calls.some(c=>c.action==='saveMemory'),false)
  assert.equal(calls.filter(c=>c.action==='updateMemoryMedia').length,4)
  assert.equal(page.data.detail.mediaRevision,4); assert.equal(page.data.hasUnsavedChanges,false)
  assert.equal(page.data.draft.images[0].entrance,true)
  assert.deepEqual(Array.from(page.data.draft.videos,m=>m.uploadId),['video2'])
  await page.load(); assert.equal(page.data.draft.images[0].entrance,true)
  assert.deepEqual(Array.from(page.data.draft.videos,m=>m.uploadId),['video2'])
  const visitor=fixture(false); await visitor.page.load(); visitor.page.toggleEntrance(ev('images','photo1'))
  assert.equal(visitor.page.data.draft.images[0].entrance,undefined)
})

test('immediate changes preserve unsaved text and uploads and visitor preview reflects the published removal', async () => {
  const { page,calls,detail }=fixture()
  detail.isPublic=true;detail.reviewStatus='approved';detail.story=structuredClone(detail.draft)
  await page.load();page.edit()
  page.input({detail:{value:'尚未保存的长故事🐾'}})
  page.data.draft.images.push({uploadId:'unsaved-photo',url:'new-local'})
  await page.remove({currentTarget:{dataset:{kind:'images',index:0}}})
  assert.equal(page.data.draft.text,'尚未保存的长故事🐾')
  assert.equal(page.data.textCount,9);assert.equal(page.data.detail.draft.text,'一起看夕阳')
  assert.deepEqual(Array.from(page.data.draft.images,m=>m.uploadId),['unsaved-photo'])
  assert.equal(page.data.hasUnsavedChanges,true)
  page.preview();assert.equal(page.data.story.text,'一起看夕阳');assert.equal(page.data.story.images.length,0)
  page.edit();await page.save()
  const data=calls.find(c=>c.action==='saveMemory').data
  assert.equal(data.text,'尚未保存的长故事🐾');assert.equal(data.mediaRevision,1)
  assert.deepEqual(Array.from(data.images),['unsaved-photo'])
})

test('unsaved uploads can be selected or removed without publishing or requesting immediate updates', async () => {
  const { page,calls }=fixture();await page.load();page.edit()
  page.data.draft.images.push({uploadId:'new-photo',url:'local'})
  await page.toggleEntrance({currentTarget:{dataset:{kind:'images',id:'new-photo'}}})
  assert.equal(page.data.draft.images[1].entrance,true);assert.equal(page.data.hasUnsavedChanges,true)
  assert.equal(calls.some(c=>c.action==='updateMemoryMedia'),false)
  await page.remove({currentTarget:{dataset:{kind:'images',index:1}}})
  assert.equal(page.data.hasUnsavedChanges,false);assert.equal(page.data.detail.mediaRevision,0)
})

test('failed immediate updates leave the selection unchanged and permit retry', async () => {
  let fail=true
  const { page,calls,toasts }=fixture(true,{api:async(action,data)=>{
    if(action!=='updateMemoryMedia')return {}
    if(fail)throw new Error('网络中断，请重试')
    return {revision:data.revision,mediaRevision:data.mediaRevision+1,reviewStatus:'private',story:null}
  }})
  await page.load();page.edit()
  const event={currentTarget:{dataset:{kind:'images',id:'photo1'}}}
  await page.toggleEntrance(event)
  assert.equal(page.data.draft.images[0].entrance,undefined);assert.equal(page.data.mediaSaving,false)
  assert.match(toasts.at(-1),/网络中断/);assert.match(page.data.mediaSaveError,/网络中断/)
  fail=false;await page.toggleEntrance(event)
  const mutations=calls.filter(c=>c.action==='updateMemoryMedia')
  assert.deepEqual(mutations[0].data,mutations[1].data)
  assert.equal(page.data.draft.images[0].entrance,true);assert.equal(page.data.mediaSaveError,'')
})

test('in-flight immediate writes prevent duplicate taps, uploads and saves; closed pages ignore responses', async () => {
  let finish
  const {page,calls}=fixture(true,{api:async action=>action==='updateMemoryMedia'?new Promise(resolve=>{finish=resolve}):{}})
  await page.load();page.edit()
  const event={currentTarget:{dataset:{kind:'images',id:'photo1'}}}
  const writing=page.toggleEntrance(event)
  await page.toggleEntrance(event);await page.remove({currentTarget:{dataset:{kind:'videos',index:0}}})
  await page.addMedia({currentTarget:{dataset:{kind:'image'}}});await page.save()
  assert.equal(calls.filter(c=>c.action==='updateMemoryMedia').length,1)
  assert.equal(calls.some(c=>['prepareMedia','saveMemory'].includes(c.action)),false)
  page.onUnload();finish({revision:4,mediaRevision:1,reviewStatus:'private',story:null});await writing
  assert.equal(page.data.draft.images[0].entrance,undefined)
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
