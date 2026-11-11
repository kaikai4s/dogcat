const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Playback events below model an isolated synthetic player; no real records are modified.
function setup(route = 'staff/training', callFunction = async () => ({})) {
  let page, now = 10000, timerId = 0
  const timers = new Map()
  const calls = [], errors = [], toasts = [], seeks = []
  const wx = { showToast: value => toasts.push(value), showLoading() {}, hideLoading() {},
    createVideoContext: () => ({ seek: value => seeks.push(value), pause() {} }),
    cloud: { getTempFileURL(options) {
      const response = { fileList: options.fileList.map(fileID => ({ fileID, tempFileURL: 'https://synthetic.invalid/video.mp4' })) }
      if (options.success) options.success(response)
      if (options.complete) options.complete(response)
    } } }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages', route, 'index.js'), 'utf8'), {
    Page: value => { page = value }, wx,
    Date: class extends Date { static now() { return now } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, dueAt: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name) {
      if (name.endsWith('/format')) return require('../../miniprogram/utils/format')
      if (name.endsWith('/payment-config')) return require('../../miniprogram/pages/admin/settings/payment-config')
      if (name.endsWith('/subscription-options')) return require('../../miniprogram/utils/subscription-options')
      return { callFunction: async (...args) => { calls.push(args); return callFunction(...args) }, showError: value => errors.push(value),
        withStaffWorkflowText: value => value, formatDateTime: value => value, setCachedSystemSettings() {},
        applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
    }
  })
  page.setData = (patch, callback) => {
    for (const [key, value] of Object.entries(patch)) {
      const fields = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      const target = fields.slice(0, -1).reduce((obj, field) => obj[field], page.data)
      target[fields.at(-1)] = value
    }
    if (callback) callback()
  }
  const load = page.load
  const resolveUrls = page.resolveVideoUrls
  page.load = () => {}
  page.loadDeposit = () => {}
  page.resolveVideoUrls = () => {}
  page.data.videos = [{ key: 'synthetic-video', fileId: 'cloud://synthetic/video.mp4', watched: false, progressPercent: 0 }]
  return { page, load, resolveUrls, calls, errors, toasts, seeks, wx, timers, advance: ms => { now += ms },
    async runNextTimer() {
      const next = [...timers].sort((a, b) => a[1].dueAt - b[1].dueAt)[0]
      if (!next) return false
      timers.delete(next[0])
      now = Math.max(now, next[1].dueAt)
      await next[1].callback()
      return true
    } }
}
const event = detail => ({ currentTarget: { dataset: { key: 'synthetic-video' } }, detail: detail || {} })

test('80 percent triggers submission with actual fractional seconds and keeps the displayed progress', async () => {
  const h = setup()
  h.page.onVideoPlay(event())
  for (const currentTime of [1, 2, 3, 4, 5, 6, 6.59]) h.page.onVideoTimeUpdate(event({ currentTime, duration: 8.25 }))
  assert.equal(h.calls.length, 0)
  await h.page.onVideoTimeUpdate(event({ currentTime: 6.6, duration: 8.25 }))
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][2].watchedSeconds, 6.6)
  assert.equal(h.calls[0][2].duration, 8.25)
  assert.equal(h.page.data.videos[0].watched, true)
  assert.equal(h.page.data.videos[0].progressPercent, 80)
})

test('90 percent uses the configured boundary and metadata when timeupdate omits duration', async () => {
  const h = setup()
  h.page.data.videoPassPercent = 90
  h.page.onVideoLoadedMetadata(event({ duration: 1.25 }))
  h.page.onVideoTimeUpdate(event({ currentTime: 1.12 }))
  assert.equal(h.calls.length, 0)
  await h.page.onVideoTimeUpdate(event({ currentTime: 1.125 }))
  assert.equal(h.calls[0][2].watchedSeconds, 1.125)
  assert.equal(h.calls[0][2].duration, 1.25)
})

test('100 percent completion accounts for the natural final frame omitted from timeupdate', async () => {
  for (const pauseBeforeEnded of [false, true]) {
    const h = setup()
    h.page.data.videoPassPercent = 100
    h.page.onVideoLoadedMetadata(event({ duration: 1.2 }))
    h.page.onVideoPlay(event())
    h.advance(950)
    h.page.onVideoTimeUpdate(event({ currentTime: 0.95, duration: 1.2 }))
    assert.equal(h.calls.length, 0)
    h.advance(250)
    if (pauseBeforeEnded) h.page.onVideoPause(event())
    await h.page.onVideoEnded(event())
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0][2].watchedSeconds, 1.2)
    assert.equal(h.seeks.length, 0)
  }
})

test('a naturally completed sub-second video works even before its first timeupdate', async () => {
  const h = setup()
  h.page.data.videoPassPercent = 100
  h.page.onVideoLoadedMetadata(event({ duration: 0.125 }))
  h.page.onVideoPlay(event())
  h.advance(125)
  await h.page.onVideoEnded(event())
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][2].duration, 0.125)
  assert.equal(h.calls[0][2].watchedSeconds, 0.125)
})

test('progress synchronization deduplicates pending requests and retries temporary failure', async () => {
  let resolve
  const h = setup('staff/training', () => new Promise(done => { resolve = done }))
  const pending = h.page.onVideoTimeUpdate(event({ currentTime: 0.8, duration: 1 }))
  h.page.onVideoTimeUpdate(event({ currentTime: 0.9, duration: 1 }))
  assert.equal(h.calls.length, 1)
  resolve({})
  await pending
  assert.equal(h.page.getVideoTracking('synthetic-video').completed, true)

  let attempts = 0
  const retry = setup('staff/training', async () => { if (++attempts === 1) throw new Error('synthetic network timeout'); return {} })
  await retry.page.onVideoTimeUpdate(event({ currentTime: 0.8, duration: 1 }))
  assert.equal(retry.page.getVideoTracking('synthetic-video').completed, false)
  assert.equal(retry.page.data.videos[0].watched, false)
  retry.advance(3100)
  await retry.page.onVideoTimeUpdate(event({ currentTime: 1, duration: 1 }))
  assert.equal(attempts, 2)
  assert.equal(retry.page.data.videos[0].watched, true)
})

test('status reload preserves the media URL and displays the actual completed ratio', async () => {
  const row = { key: 'synthetic-video', fileId: 'cloud://synthetic/video.mp4', watched: true, watchedSeconds: 6.6, duration: 8.25 }
  const h = setup('staff/training', async () => ({ profile: {}, quiz: { unlocked: true }, videos: [row], videoPassPercent: 80 }))
  h.page.data.videos[0].tempUrl = 'https://synthetic.invalid/video.mp4'
  await h.load.call(h.page)
  assert.equal(h.page.data.videos[0].tempUrl, 'https://synthetic.invalid/video.mp4')
  assert.equal(h.page.data.videos[0].progressPercent, 80)
  assert.equal(h.page.data.videoPassPercent, 80)
  assert.equal(h.page.data.watchedVideoCount, 1)
})

test('admin upload captures precise media duration and replaces old duration metadata', async () => {
  const h = setup('admin/settings')
  const draft = { ...h.page.data.videos[0], durationSeconds: 300, durationFileId: h.page.data.videos[0].fileId }
  h.page.data.settings.staffTraining.videos = [draft]
  h.wx.chooseMedia = options => options.success({ tempFiles: [{ tempFilePath: 'synthetic.mp4', size: 1024, duration: 1 }] })
  h.wx.getVideoInfo = options => options.success({ duration: 1.375 })
  h.wx.cloud = { uploadFile: options => options.success({ fileID: 'cloud://synthetic/replacement.mp4' }),
    getTempFileURL: options => options.complete({ fileList: [{ tempFileURL: 'https://synthetic.invalid/replacement.mp4' }] }) }
  h.page.chooseTrainingVideoFile({ currentTarget: { dataset: { index: 0 } } })
  await new Promise(resolve => setImmediate(resolve))
  const uploaded = h.page.data.settings.staffTraining.videos[0]
  assert.equal(uploaded.durationSeconds, 1.375)
  assert.equal(uploaded.durationFileId, 'cloud://synthetic/replacement.mp4')
  assert.equal(h.page.data.uploadingTrainingVideo, false)
})

test('admin ratio can be edited freely and invalid percentages cannot be saved', () => {
  const h = setup('admin/settings')
  assert.equal(h.page.data.settings.staffTraining.videoPassPercent, 80)
  h.page.data.loaded = true
  for (const value of ['', '0', '101', '80.5']) {
    h.page.trainingVideoPassPercentInput({ detail: { value } })
    h.page.save()
    assert.match(h.errors.at(-1).message, /观看通过比例/)
    assert.equal(h.calls.length, 0)
  }
  h.page.trainingVideoPassPercentInput({ detail: { value: '95' } })
  assert.equal(h.page.data.settings.staffTraining.videoPassPercent, '95')
})

test('admin settings save submits the numeric ratio together with precise duration metadata', async () => {
  const h = setup('admin/settings', async (_, action, payload) => payload)
  h.page.data.loaded = true
  h.page.data.settings.staffTraining.quiz = [{ id: 'synthetic-question', question: '测试题目', options: [{ value: 'A', label: '选项一' }, { value: 'B', label: '选项二' }], answer: 'A' }]
  h.page.data.settings.staffTraining.videos = [{ key: 'synthetic-video', title: '测试视频', fileId: 'cloud://synthetic/video.mp4', durationSeconds: 1.375, durationFileId: 'cloud://synthetic/video.mp4' }]
  h.page.trainingVideoPassPercentInput({ detail: { value: '95' } })
  h.page.save()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][1], 'saveSystemSettings')
  assert.equal(h.calls[0][2].staffTraining.videoPassPercent, 95)
  assert.equal(h.calls[0][2].staffTraining.videos[0].durationSeconds, 1.375)
  assert.equal(h.page.data.saving, false)
  assert.equal(h.errors.length, 0, h.errors.map(error => error.stack || error.message).join('\n'))
})

test('a short video retries progress after natural playback has already ended', async () => {
  let attempts = 0
  const h = setup('staff/training', async () => { if (++attempts === 1) throw new Error('synthetic network timeout'); return {} })
  h.page.onVideoPlay(event())
  h.advance(800)
  await h.page.onVideoTimeUpdate(event({ currentTime: 0.8, duration: 1 }))
  h.advance(200)
  h.page.onVideoEnded(event())
  assert.equal(attempts, 1)
  assert.equal(h.timers.size, 1)
  await h.runNextTimer()
  assert.equal(attempts, 2)
  assert.equal(h.calls[1][2].watchedSeconds, 1)
  assert.equal(h.page.data.videos[0].watched, true)
  assert.equal(h.timers.size, 0)
})

test('automatic synchronization retries are bounded and manual retry needs no replay', async () => {
  let attempts = 0
  const h = setup('staff/training', async () => { if (++attempts <= 3) throw new Error('synthetic network timeout'); return {} })
  await h.page.onVideoTimeUpdate(event({ currentTime: 0.8, duration: 1 }))
  await h.runNextTimer()
  await h.runNextTimer()
  assert.equal(attempts, 3)
  assert.equal(h.timers.size, 0)
  assert.equal(h.page.data.videos[0].syncError, true)
  h.advance(4000)
  h.page.onVideoTimeUpdate(event({ currentTime: 1, duration: 1 }))
  assert.equal(attempts, 3)
  await h.page.retryVideoSync(event())
  assert.equal(attempts, 4)
  assert.equal(h.page.data.videos[0].watched, true)
  assert.equal(h.page.data.videos[0].syncError, false)
})

test('hidden pages cancel pending retry and resume it after status refresh on return', async () => {
  let marks = 0
  const h = setup('staff/training', async (_, action) => {
    if (action === 'getTrainingStatus') return { profile: {}, quiz: {}, videos: [{ key: 'synthetic-video', fileId: 'cloud://synthetic/video.mp4', watched: false }], videoPassPercent: 80 }
    if (++marks === 1) throw new Error('synthetic network timeout')
    return {}
  })
  await h.page.onVideoTimeUpdate(event({ currentTime: 0.8, duration: 1 }))
  h.page.onHide()
  assert.equal(h.timers.size, 0)
  h.page.load = h.load
  h.page.onShow()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.timers.size, 1)
  await h.runNextTimer()
  assert.equal(marks, 2)
  assert.equal(h.page.getVideoTracking('synthetic-video').completed, true)
})

test('a late synchronization result cannot complete a replacement video in the same row', async () => {
  let resolve
  const h = setup('staff/training', () => new Promise(done => { resolve = done }))
  const pending = h.page.onVideoTimeUpdate(event({ currentTime: 0.8, duration: 1 }))
  h.page.data.videos[0] = { ...h.page.data.videos[0], fileId: 'cloud://synthetic/replacement.mp4', progressPercent: 0 }
  const replacement = h.page.getVideoTracking('synthetic-video')
  resolve({})
  await pending
  assert.equal(h.page.data.videos[0].watched, false)
  assert.equal(replacement.completed, false)
  assert.equal(h.toasts.length, 0)
})

test('normal delayed playback callbacks and sparse short-video endings are accepted', async () => {
  const delayed = setup()
  delayed.page.onVideoPlay(event())
  delayed.advance(3200)
  await delayed.page.onVideoTimeUpdate(event({ currentTime: 3.2, duration: 4 }))
  assert.equal(delayed.calls.length, 1)
  assert.equal(delayed.seeks.length, 0)

  const short = setup()
  short.page.data.videoPassPercent = 100
  short.page.onVideoLoadedMetadata(event({ duration: 0.8 }))
  short.page.onVideoPlay(event())
  short.advance(800)
  await short.page.onVideoEnded(event())
  assert.equal(short.calls[0][2].watchedSeconds, 0.8)
})

test('internal status refresh keeps cached media URLs while resolving newly added media', () => {
  const h = setup()
  let requests = 0
  h.page.data.videos[0].tempUrl = 'https://synthetic.invalid/still-playing.mp4'
  h.wx.cloud.getTempFileURL = options => { requests++; options.success({ fileList: options.fileList.map(fileID => ({ fileID, tempFileURL: 'https://synthetic.invalid/new.mp4' })) }) }
  h.resolveUrls.call(h.page, h.page.data.videos, undefined, true)
  assert.equal(requests, 0)
  h.page.data.videos.push({ key: 'second', fileId: 'cloud://synthetic/second.mp4' })
  h.resolveUrls.call(h.page, h.page.data.videos, undefined, true)
  assert.equal(requests, 1)
  assert.equal(h.page.data.videos[0].tempUrl, 'https://synthetic.invalid/still-playing.mp4')
  assert.equal(h.page.data.videos[1].tempUrl, 'https://synthetic.invalid/new.mp4')
})

test('video uploads follow their row key when another row is deleted during upload', async () => {
  const h = setup('admin/settings')
  h.page.data.settings.staffTraining.videos = [{ key: 'first', title: '第一条' }, { key: 'second', title: '第二条' }]
  let metadata
  h.wx.chooseMedia = options => options.success({ tempFiles: [{ tempFilePath: 'synthetic.mp4', size: 1024 }] })
  h.wx.getVideoInfo = options => { metadata = options }
  h.wx.cloud = { uploadFile: options => options.success({ fileID: 'cloud://synthetic/new.mp4' }), getTempFileURL: options => options.complete({}) }
  h.page.chooseTrainingVideoFile({ currentTarget: { dataset: { index: 1 } } })
  h.page.deleteTrainingVideo({ currentTarget: { dataset: { index: 0 } } })
  metadata.success({ duration: 1.375 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.page.data.settings.staffTraining.videos.length, 1)
  assert.equal(h.page.data.settings.staffTraining.videos[0].key, 'second')
  assert.equal(h.page.data.settings.staffTraining.videos[0].fileId, 'cloud://synthetic/new.mp4')
})

test('an upload callback for a deleted video or poster cannot create a new row', async () => {
  for (const method of ['chooseTrainingVideoFile', 'chooseTrainingPosterFile']) {
    const h = setup('admin/settings')
    h.page.data.settings.staffTraining.videos = [{ key: 'first', title: '第一条' }, { key: 'second', title: '第二条' }]
    let complete
    h.wx.chooseMedia = options => options.success({ tempFiles: [{ tempFilePath: 'synthetic.mp4', size: 1024, duration: 1 }] })
    h.wx.cloud = { uploadFile: options => options.success({ fileID: 'cloud://synthetic/new-file' }), getTempFileURL: options => { complete = options.complete } }
    h.page[method]({ currentTarget: { dataset: { index: 0 } } })
    await new Promise(resolve => setImmediate(resolve))
    h.page.deleteTrainingVideo({ currentTarget: { dataset: { index: 0 } } })
    complete({})
    assert.equal(h.page.data.settings.staffTraining.videos.length, 1)
    assert.equal(h.page.data.settings.staffTraining.videos[0].key, 'second')
    assert.equal(h.page.data.settings.staffTraining.videos[0].fileId, undefined)
    assert.equal(h.page.data.uploadingTrainingVideo, false)
    assert.equal(h.page.data.uploadingTrainingPoster, false)
  }
})

test('100 percent natural completion retains the final playback segment across pause and resume', async () => {
  const h = setup()
  h.page.data.videoPassPercent = 100
  h.page.onVideoPlay(event())
  h.advance(950)
  h.page.onVideoTimeUpdate(event({ currentTime: 0.95, duration: 1.2 }))
  h.advance(150)
  h.page.onVideoPause(event())
  h.advance(10000)
  h.page.onVideoPlay(event())
  h.advance(100)
  await h.page.onVideoEnded(event())
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][2].watchedSeconds, 1.2)
})

test('changed training rules refresh the status without scheduling network retries', async () => {
  const h = setup('staff/training', async (_, action) => {
    if (action === 'getTrainingStatus') return { profile: {}, quiz: {}, videos: [{ key: 'synthetic-video', fileId: 'cloud://synthetic/video.mp4' }], videoPassPercent: 95 }
    throw Object.assign(new Error('培训要求已调整'), { module: 'staff', code: 'TRAINING_WATCH_INCOMPLETE' })
  })
  h.page.load = h.load
  await h.page.onVideoTimeUpdate(event({ currentTime: 0.8, duration: 1 }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.timers.size, 0)
  assert.equal(h.page.data.videoPassPercent, 95)
  assert.equal(h.page.data.videos[0].watched, undefined)
})

test('a final retry that fails after hiding the page remains manually recoverable on return', async () => {
  let attempts = 0, rejectFinal
  const h = setup('staff/training', async (_, action) => {
    if (action === 'getTrainingStatus') return { profile: {}, quiz: {}, videos: [{ key: 'synthetic-video', fileId: 'cloud://synthetic/video.mp4', watched: false }], videoPassPercent: 80 }
    if (++attempts < 3) throw new Error('synthetic network timeout')
    return new Promise((_, reject) => { rejectFinal = reject })
  })
  await h.page.onVideoTimeUpdate(event({ currentTime: 0.8, duration: 1 }))
  await h.runNextTimer()
  const finalRetry = h.runNextTimer()
  h.page.onHide()
  rejectFinal(new Error('synthetic network timeout'))
  await finalRetry
  assert.equal(h.errors.length, 0)
  h.page.load = h.load
  h.page.onShow()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.page.data.videos[0].syncError, true)
  assert.equal(h.timers.size, 0)
})
