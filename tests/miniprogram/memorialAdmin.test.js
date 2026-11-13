const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const entry = require.resolve('../../miniprogram/pages/admin/memorial/index')
const realRequire = createRequire(entry)
const event = data => ({ currentTarget: { dataset: data } })
const inspected = { layoutVersion: 1, width: 512, height: 512, bounds: { x: 100, y: 80, width: 220, height: 360 }, previewDigest: 'a'.repeat(64), scale: 1 }
function readyPreview(page) {
  const row = page.data.rows[0]
  for (const part of ['pet', 'monument']) page.placementImageLoaded(event({ key: row.previewKey, part, attempt: row.previewAttempt, src: row[part + 'Url'] }))
}
function setup({ api, enabled = true, accept = true, wx: native = {} } = {}) {
  let page
  const calls = [], prompts = [], errors = [], audio = []
  const row = { _id: 'app', plotId: 'garden-ortho-v2:2:3', lawn: '北苑1', petName: '小白', status: 'pending', createdAt: '2026-11-11T18:30:00.000Z' }
  const settings = { subscription: { enabled, templates: { adminPendingAudit: 'audit-template-id' } } }
  const cloud = { callFunction: async (module, action, data) => {
    calls.push({ module, action, data })
    if (api) return api(module, action, data)
    return action === 'getSettings' ? settings : action === 'listAdmin' ? { list: [row], cursor: 'app', hasMore: true } : {}
  }, showError: e => errors.push(e.message), setCachedSystemSettings: value => value,
  requestSubscribeTemplates: (keys, scene, options) => {
    prompts.push({ keys: Array.from(keys), scene, options })
    return Promise.resolve({ requested: true, templateIdByKey: { adminPendingAudit: 'audit-template-id' }, results: { 'audit-template-id': accept ? 'accept' : 'reject' } })
  } }
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    Page: config => { page = config }, require: name => name.endsWith('/cloud') ? cloud : realRequire(name), wx: { showToast() {}, openSetting() {}, stopPullDownRefresh() {}, createInnerAudioContext() {
      const node = { play() {}, destroy() { this.destroyed = true }, onError(fn) { this.fail = fn }, onEnded(fn) { this.end = fn } }
      audio.push(node); return node
    },
    getFileSystemManager() { return {getFileInfo(o) { o.success({size:100}) }} },
    createSelectorQuery() { const q={in:()=>q,select:()=>q,fields:()=>q,exec(fn) { fn([{node:{
      createImage() { return {set src(value) { this.onload() }} },
      getContext() { return {clearRect() {},drawImage() {}} }
    }}]) }};return q },
    canvasToTempFilePath(o) { assert.equal(o.fileType,'png');o.success({tempFilePath:'/normalized.png'}) },
    getImageInfo(o) { o.success({ type: 'png', width: 512, height: 512, path: o.src }) },
    ...native,
    cloud: { downloadFile(o) { o.success({tempFilePath: '/platform.png', statusCode:200}) }, ...native.cloud } }
  })
  page.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = page.data
      for (const name of parts.slice(0, -1)) target = target[name]
      target[parts.at(-1)] = value
    }
  }
  return { page, calls, prompts, errors, audio }
}
test('review page shows stable plot numbers and Beijing submission time; authorization runs only on a tap', async () => {
  const { page, prompts } = setup()
  await page.onShow()
  assert.equal(page.data.rows[0].plotNumber, '03-04')
  assert.equal(page.data.rows[0].createdText, '11-12 02:30')
  assert.equal(prompts.length, 0)
  const pending = page.subscribeAudit()
  assert.equal(prompts.length, 1, 'native authorization must happen before any network await')
  assert.deepEqual(prompts[0].keys, ['adminPendingAudit'])
  await pending
  assert.match(page.data.subscriptionFeedback, /已同意/)
  assert.equal(page.data.subscribing, false)
})
test('disabled configuration and refusal never claim subscription success', async () => {
  const disabled = setup({ enabled: false })
  await disabled.page.onShow()
  disabled.page.subscribeAudit()
  assert.equal(disabled.prompts.length, 0)
  assert.match(disabled.page.data.subscriptionTip, /尚未开启/)
  const rejected = setup({ accept: false })
  await rejected.page.onShow(); await rejected.page.subscribeAudit()
  assert.match(rejected.page.data.subscriptionFeedback, /尚未开启/)
})
test('review enforces permission and rejection reason; submitted decisions refresh the list', async () => {
  const { page, calls, errors } = setup()
  await page.onShow()
  page.review(event({ id: 'app', status: 'approved' }))
  assert.equal(page.data.reviewForm, null)
  page.data.adminPermissions = { memorial_review: true }
  page.review(event({ id: 'app', status: 'rejected' }))
  await page.confirm()
  assert.match(errors[0], /原因/)
  assert.equal(calls.some(c => c.action === 'review'), false)
  page.reason({ detail: { value: '请调整寄语内容' } })
  await page.confirm()
  assert.equal(calls.filter(c => c.action === 'review').length, 1)
  assert.equal(calls.find(c => c.action === 'review').data.reason, '请调整寄语内容')
  assert.equal(page.data.reviewForm, null)
  assert.equal(page.data.busy, false)
})
test('old filter responses cannot overwrite the latest status or mutate a closed review page', async () => {
  const waiting = []
  const { page } = setup({ api: (module, action, data) => new Promise(resolve => waiting.push({ action, data, resolve })) })
  const first = page.load()
  const second = page.changeStatus(event({ status: 'approved' }))
  waiting[1].resolve({ list: [], hasMore: false })
  await second
  waiting[0].resolve({ list: [{ _id: 'stale' }], hasMore: true })
  await first
  assert.equal(page.data.rows.length, 0)
  assert.equal(page.data.status, 'approved')
  const third = page.load()
  page.onHide()
  waiting[2].resolve({ list: [{ _id: 'hidden' }], hasMore: true })
  await third
  assert.equal(page.data.rows.length, 0)
})

test('memory-only reviewer sees the memory queue and sends the exact draft revision', async () => {
  const { page, calls } = setup({ api: async (_, action) => action === 'listMemoriesAdmin' ? { list: [{ _id: 'memory', revision: 7, status: 'pending', petName: '小白' }] } : {} })
  page.data.adminPermissions = { memorial_listMemoriesAdmin: true, memorial_reviewMemory: true }
  page.onLoad({ mode: 'applications' }); await page.onShow()
  assert.equal(page.data.mode, 'memories')
  page.review(event({ id: 'memory', status: 'approved' })); await page.confirm()
  const review = calls.find(c => c.action === 'reviewMemory')
  assert.equal(review.data.revision, 7)
})

test('stale admin audio callbacks cannot stop another preview; changing queues stops playback', async () => {
  const { page, audio, errors } = setup()
  await page.onShow()
  page.playAudio(event({ url: 'first.mp3' })); page.playAudio(event({ url: 'second.mp3' }))
  audio[0].end(); audio[0].fail()
  assert.equal(page.data.playingUrl, 'second.mp3')
  assert.notEqual(audio[1].destroyed, true)
  assert.deepEqual(errors, [])
  await page.changeStatus(event({ status: 'approved' }))
  assert.equal(audio[1].destroyed, true)
  assert.equal(page.data.playingUrl, '')
  page.onHide(); audio[1].fail()
  assert.deepEqual(errors, [])
})

test('portrait-only reviewer uploads original PNG, preserves staging through preview, and approves exact revision', async () => {
  let page, selected, uploaded
  const f = setup({ api: async (_, action, data) => {
    if (action === 'preparePortraitAsset' && data.uploadId) return inspected
    if (action === 'listPortraitsAdmin') return { list: [{ _id: 'portrait', petName: '小白', status: 'pending', revision: 4, photos: [] }] }
    if (action === 'preparePortraitAsset') return { uploadId: 'ticket', cloudPath: 'upload.png' }
    return {}
  }, wx: {
    chooseMedia(o) { selected = o; page.onHide() },
    getImageInfo(o) { o.success({ type: 'png', width: 512, height: 512 }) },
    cloud: { uploadFile(o) { uploaded = o; o.success({ fileID: 'cloud://env/upload.png' }); return {} } }
  } }); page = f.page
  page.data.adminPermissions = { memorial_listPortraitsAdmin: true, memorial_preparePortraitAsset: true, memorial_reviewPortrait: true }
  await page.onShow(); assert.equal(page.data.mode, 'portraits')
  page.review(event({ id: 'portrait', status: 'approved' })); assert.equal(page.data.reviewForm, null)
  const work = page.uploadPortrait(event({ id: 'portrait' }))
  await page.onShow(); assert.equal(page.data.busy, true)
  selected.success({ tempFiles: [{ path: '/portrait.png', name: 'portrait.png', size: 100 }] }); await work
  assert.equal(uploaded.filePath, '/normalized.png'); assert.equal(page.data.busy, false)
  assert.equal(page.data.rows[0].previewReady, true, 'verified images must be ready even when native bindload never fires')
  page.onHide(); await page.onShow()
  assert.equal(page.data.rows[0].stagedAsset.uploadId, 'ticket')
  page.resizePortrait(event({ id: 'portrait', step: 5 }))
  page.review(event({ id: 'portrait', status: 'approved' })); await page.confirm()
  const review = f.calls.find(c => c.action === 'reviewPortrait')
  assert.equal(review.data.revision, 4); assert.equal(review.data.uploadId, 'ticket')
  assert.equal(review.data.fileId, 'cloud://env/upload.png')
  assert.equal(review.data.scale, 1.05); assert.equal(review.data.previewDigest, inspected.previewDigest)
  assert.equal(page.data.rows[0].stagedAsset, undefined)
})
test('leaving the admin upload page prevents late file-picker callbacks from creating upload tickets', async () => {
  let selected
  const f = setup({ wx: { chooseMedia(o) { selected = o } } })
  await f.page.onShow(); f.page.data.adminSuper = true
  const work = f.page.uploadPortrait(event({ id: 'app' }))
  f.page.onUnload(); selected.success({ tempFiles: [{ path: '/late.png', size: 100 }] }); await work
  assert.equal(f.calls.some(c => c.action === 'preparePortraitAsset'), false)
})

test('portrait album upload normalizes oversized source PNG before staging and never opens a chat picker', async () => {
  let album,uploaded,chat=0
  const f=setup({api:async(_,action,data)=>action==='preparePortraitAsset'&&data.uploadId?inspected:action==='listPortraitsAdmin'?{list:[{_id:'portrait',status:'pending',revision:2,photos:[]}]}:action==='preparePortraitAsset'?{uploadId:'ticket',cloudPath:'portrait.png'}:{},wx:{
    chooseMedia(o){album=o;o.success({tempFiles:[{tempFilePath:'/album-original.png',size:3*1024*1024}]})},chooseMessageFile(){chat++},
    getImageInfo(o){assert.ok(['/album-original.png','/normalized.png','/platform.png'].includes(o.src));o.success({width:512,height:512,type:'png'})},
    getFileSystemManager(){return {getFileInfo(o){o.success({size:o.filePath==='/album-original.png'?3*1024*1024:200000})}}},
    cloud:{uploadFile(o){uploaded=o.filePath;o.success({fileID:'cloud://env/portrait.png'});return {}}}
  }})
  f.page.data.adminSuper=true;f.page.data.mode='portraits';await f.page.onShow();await f.page.uploadPortrait(event({id:'portrait',source:'album'}))
  assert.deepEqual(Array.from(album.sizeType),['original']);assert.deepEqual(Array.from(album.sourceType),['album']);assert.equal(chat,0);assert.equal(uploaded,'/normalized.png');assert.equal(f.page.data.rows[0].stagedAsset.uploadId,'ticket')
})
test('album conversions to JPEG are rejected before an upload ticket and explain how to preserve PNG', async () => {
  const f=setup({wx:{chooseMedia(o){o.success({tempFiles:[{tempFilePath:'/converted.jpg',size:500}]})},getImageInfo(o){o.success({width:512,height:512,type:'jpeg'})}}})
  f.page.data.adminSuper=true;await f.page.onShow();await f.page.uploadPortrait(event({id:'app',source:'album'}))
  assert.equal(f.calls.some(c=>c.action==='preparePortraitAsset'),false);assert.match(f.errors[0],/透明 PNG 原图/);assert.equal(f.page.data.busy,false)
})

test('admin resizing preserves each upload across refresh and preview errors prevent approval', async () => {
  let failPlatform = false
  const f = setup({api: async (_, action) => action === 'listPortraitsAdmin' ? {list: ['a','b'].map(id => ({_id:id, revision:2, status:'pending', style:'moon', pose:'sleeping'}))} : {},
    wx: { cloud: {downloadFile(o) { if (failPlatform) o.fail({errMsg:'offline'}); else o.success({tempFilePath:'/moon.png'}) }} }})
  const { page } = f; page.data.mode='portraits'; page.data.adminSuper=true
  page._portraitAssets={a:{revision:2,asset:{...inspected,uploadId:'one',url:'/a.png'}},b:{revision:2,asset:{...inspected,uploadId:'two',url:'/b.png'}}}
  await page.load(); readyPreview(page)
  for(let i=0;i<20;i++)page.resizePortrait(event({id:'a',step:5}))
  assert.equal(page.data.rows[0].stagedAsset.scale,1.4); assert.equal(page.data.rows[1].stagedAsset.scale,1)
  await page.load(); assert.equal(page.data.rows[0].preview.scalePercent,140)
  assert.match(page.data.rows[0].monumentUrl,/moon.png$/); assert.equal(page.data.rows[0].poseLabel,'安心趴睡')
  const row=page.data.rows[0];page.placementImageError(event({key:row.previewKey,part:'monument',attempt:row.previewAttempt,src:row.monumentUrl}))
  failPlatform=true;await page.review(event({id:'a',status:'approved'}));assert.equal(page.data.reviewForm,null)
  assert.match(f.errors.at(-1),/平台预览/)
  failPlatform=false;await page.retryPlacement(event({id:'a'}));await page.review(event({id:'a',status:'approved'}))
  assert.equal(page.data.reviewForm.preview.scalePercent,140)
  page.close();page.resizePortrait(event({id:'a',step:0}));assert.equal(page.data.rows[0].stagedAsset.scale,1)
  for(let i=0;i<20;i++)page.resizePortrait(event({id:'a',step:-5}))
  assert.equal(page.data.rows[0].stagedAsset.scale,.5)
  page._portraitAssets.a.revision=1;await page.load();assert.equal(page.data.rows[0].stagedAsset,undefined)
})
test('portrait prompts follow the selected request, with natural width framing for sleeping', async () => {
  let copied
  const {page}=setup({wx:{setClipboardData(o){copied=o.data}}})
  page.data.rows=[{_id:'sleep',pose:'sleeping'},{_id:'sit',pose:'sitting'}]
  page.copyPortraitPrompt(event({id:'sleep'}));assert.match(copied,/腹部贴地/);assert.match(copied,/宽度约/)
  page.copyPortraitPrompt(event({id:'sit'}));assert.match(copied,/前爪落在同一接地平面/);assert.match(copied,/高度约/)
})

const turn = () => new Promise(resolve => setImmediate(resolve))
function stagedPage(native = {}) {
  const f = setup({ wx: native })
  f.page.data.mode = 'portraits'; f.page.data.adminSuper = true
  const row = { _id:'portrait', revision:4, status:'pending', style:'arch', stagedAsset:{...inspected, uploadId:'ticket', fileId:'cloud://env/pet.png', url:'/pet.png'} }
  f.page.data.rows = [f.page.portraitRow(row)]
  f.page._portraitAssets = {portrait:{revision:4, asset:row.stagedAsset}}
  return f
}
function imageEvent(row, part) {
  return event({key:row.previewKey, part, attempt:row.previewAttempt, src:row[part+'Url']})
}
test('tap repairs missing preview events by decoding both visible images before opening approval', async () => {
  const waiting = []
  const {page, errors} = stagedPage({getImageInfo(o) {waiting.push(o)}})
  const opening = page.review(event({id:'portrait',status:'approved'}))
  await turn()
  assert.equal(waiting.length,2)
  assert.equal(page.data.reviewForm,null)
  waiting[0].success({width:512,height:512})
  await turn()
  assert.equal(page.data.rows[0].previewReady,false)
  assert.equal(page.data.reviewForm,null,'one image cannot authorize placement')
  waiting[1].success({width:256,height:352})
  await opening
  assert.equal(page.data.rows[0].previewReady,true)
  assert.equal(page.data.reviewForm.uploadId,'ticket')
  assert.deepEqual(errors,[])
})
test('a failed platform remains blocked after pet load, and retry keeps the uploaded file and size', async () => {
  let offline=true
  const {page,errors,calls}=stagedPage({cloud:{downloadFile(o){offline?o.fail({}):o.success({tempFilePath:'/platform.png'})}}})
  await page.review(event({id:'portrait',status:'approved'}))
  assert.match(errors[0],/平台预览/)
  const row=page.data.rows[0]
  page.placementImageLoaded(imageEvent(row,'pet'))
  assert.match(page.data.rows[0].previewError,/平台预览/)
  assert.equal(page.data.rows[0].previewReady,false)
  page.resizePortrait(event({id:'portrait',step:5}))
  offline=false;await page.retryPlacement(event({id:'portrait'}))
  assert.equal(page.data.rows[0].previewReady,true)
  assert.equal(page.data.rows[0].stagedAsset.uploadId,'ticket')
  assert.equal(page.data.rows[0].stagedAsset.scale,1.05)
  assert.equal(calls.some(c=>c.action==='preparePortraitAsset'),false,'retry must not ask for another upload')
})
test('old image callbacks cannot invalidate a retried preview or approve another upload', async () => {
  const {page}=stagedPage()
  await page.preparePlacement(page.data.rows[0])
  const old=page.data.rows[0]
  await page.retryPlacement(event({id:'portrait'}))
  page.placementImageError(imageEvent(old,'pet'))
  assert.equal(page.data.rows[0].previewReady,true)
  const replacement=page.portraitRow({...old,stagedAsset:{...old.stagedAsset,uploadId:'new',url:'/new.png'}})
  page.data.rows=[replacement]
  page.placementImageLoaded(imageEvent(old,'pet'))
  assert.equal(page.data.rows[0].previewReady,false)
  assert.equal(page.data.rows[0].stagedAsset.uploadId,'new')
})
test('image display errors in confirmation block submission and retry updates the same dialog', async () => {
  const {page,calls,errors}=stagedPage()
  await page.review(event({id:'portrait',status:'approved'}))
  const form=page.data.reviewForm
  page.placementImageError(imageEvent(page.data.rows[0],'pet'))
  await page.confirm()
  assert.match(errors.at(-1),/重新确认/)
  assert.equal(calls.some(c=>c.action==='reviewPortrait'),false)
  assert.match(page.data.reviewForm.previewError,/画像预览/)
  await page.retryPlacement(event({id:'portrait'}))
  assert.equal(page.data.reviewForm.previewReady,true)
  assert.equal(page.data.reviewForm.uploadId,form.uploadId)
  assert.equal(page.data.reviewForm.scale,form.scale)
})
test('late verification cannot replace a rejection dialog or reopen a closed dialog', async () => {
  for (const next of ['reject','close']) {
    const waiting=[]
    const {page}=stagedPage({getImageInfo(o){waiting.push(o)}})
    const opening=page.review(event({id:'portrait',status:'approved'}))
    await turn()
    if(next==='reject')await page.review(event({id:'portrait',status:'rejected'}));else page.close()
    waiting.forEach(o=>o.success({width:512,height:512}))
    await opening
    assert.equal(page.data.reviewForm?.status,next==='reject'?'rejected':undefined)
  }
})
test('unloading cancels outstanding preview verification without late UI changes', async () => {
  const {page,errors}=stagedPage({getImageInfo(){}})
  const work=page.review(event({id:'portrait',status:'approved'}))
  await turn();page.onUnload()
  page.setData=()=>assert.fail('unloaded page must not update')
  await work
  assert.equal(page.data.reviewForm,null)
  assert.deepEqual(errors,[])
})
test('switching filters during verification cannot leave an uploaded portrait loading forever', async () => {
  const waiting=[]
  const {page}=stagedPage({getImageInfo(o){waiting.push(o)}})
  const saved=page.data.rows[0]
  const work=page.preparePlacement(saved)
  await turn()
  page.data.rows=[]
  waiting.forEach(o=>o.success({width:512,height:512}))
  await work
  page.data.rows=[page.portraitRow(saved)]
  await page.preparePlacement(page.data.rows[0])
  assert.equal(page.data.rows[0].previewPending,false)
  assert.equal(page.data.rows[0].previewReady,true)
})

test('offering display settings load minutes, reject invalid values and save the current revision once', async () => {
  let saved = 0
  const f = setup({ api: async (module, action, data) => {
    if (action === 'getOfferingSettings') return { revision: 3, flowerMinutes: 1440, snackMinutes: 60 }
    if (action === 'saveOfferingSettings') { saved++; assert.deepEqual(JSON.parse(JSON.stringify(data)), { revision: 3, flowerMinutes: 120, snackMinutes: 60 }); return {} }
  } })
  f.page.data.adminSuper = true
  await f.page.openOfferingSettings()
  assert.equal(f.page.data.offeringSettings.flowerMinutes, '1440')
  f.page.inputOfferingSettings({ currentTarget: { dataset: { field: 'flowerMinutes' } }, detail: { value: '0' } })
  await f.page.saveOfferingSettings(); assert.equal(saved, 0); assert.match(f.page.data.offeringSettings.error, /整数/)
  f.page.inputOfferingSettings({ currentTarget: { dataset: { field: 'flowerMinutes' } }, detail: { value: '120' } })
  await f.page.saveOfferingSettings(); assert.equal(saved, 1); assert.equal(f.page.data.offeringSettings, null)
})
test('read-only admins cannot save durations and late settings responses cannot reopen closed dialogs', async () => {
  let resolve
  const f = setup({ api: () => new Promise(done => { resolve = done }) })
  f.page.data.adminPermissions = { memorial_getOfferingSettings: true }
  const pending = f.page.openOfferingSettings(); f.page.closeOfferingSettings()
  resolve({ revision: 0, flowerMinutes: 60, snackMinutes: 60 }); await pending
  assert.equal(f.page.data.offeringSettings, null)
  f.page.data.offeringSettings = { revision: 0, flowerMinutes: '60', snackMinutes: '60' }
  const count = f.calls.length
  await f.page.saveOfferingSettings(); assert.equal(f.calls.length, count)
})
