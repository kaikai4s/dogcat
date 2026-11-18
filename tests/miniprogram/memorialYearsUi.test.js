const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const gardenPath = require.resolve('../../miniprogram/packageMemorial/pages/garden')
const memoryPath = require.resolve('../../miniprogram/packageMemorial/pages/memory')
const availablePlot = require('../../cloudfunctions/api/config/memorial-plots.json').ids[0]
const world = require('../../cloudfunctions/api/config/memorial-world.json')

function loadGarden() {
  let definition
  const toasts = []
  const submitted = []
  vm.runInNewContext(fs.readFileSync(gardenPath, 'utf8'), {
    setTimeout,
    clearTimeout,
    Page: (v) => { definition = v },
    require: (name) => name === '../scene/cloud-assets'
      ? { createCloudAssets: () => Object.assign((k) => k, { dispose() {} }) }
      : require('node:module').createRequire(gardenPath)(name),
    wx: {
      getWindowInfo: () => ({}),
      getMenuButtonBoundingClientRect: () => ({ bottom: 0 }),
      getStorageSync: () => null,
      setStorageSync() {},
      showToast: (opts) => toasts.push(opts.title),
      createInnerAudioContext: () => ({ onError() {}, onPlay() {}, play() {}, pause() {}, seek() {}, destroy() {} }),
      onAudioInterruptionBegin() {},
      onAudioInterruptionEnd() {},
      offAudioInterruptionBegin() {},
      offAudioInterruptionEnd() {}
    }
  })

  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(updates) {
      for (const [key, value] of Object.entries(updates)) {
        const parts = key.split('.')
        let obj = this.data
        for (const part of parts.slice(0, -1)) obj = obj[part]
        obj[parts[parts.length - 1]] = value
      }
    }
  }
  page._alive = true
  page._worldData = { occupied: [], memorials: [] }
  const cell = world.cells.find((c) => c.id === availablePlot)
  page.data.selection = { ...cell, plotId: cell.id }
  page.scene = { followPlayer() {}, openOverview() {}, setMemorials() {}, ready: true }
  page.api = async (action, data) => {
    if (action === 'submit') {
      submitted.push(data)
      return { id: 'mem_1', status: 'pending' }
    }
    if (action === 'world') return { occupied: [], memorials: [] }
    if (action === 'listMine') return { list: [], hasMore: false, cursor: '' }
    return {}
  }
  return { page, toasts, submitted }
}

function loadMemory(owner = true, initialYears = {}) {
  let page
  const calls = []
  const toasts = []
  const detail = {
    petName: '小白',
    date: '2025-01-01',
    epitaph: '一直想你',
    owner,
    revision: 1,
    mediaRevision: 0,
    isPublic: false,
    draft: { text: '', images: [], videos: [], music: null },
    story: null,
    reviewStatus: 'private',
    ...initialYears
  }
  async function api(_, action, data) {
    calls.push({ action, data })
    if (action === 'detail') return structuredClone(detail)
    if (action === 'portraitDetail') return { status: 'empty', photos: [] }
    if (action === 'updateYears') {
      const years = require('../../miniprogram/packageMemorial/scene/memorial-years')
      return {
        birthYear: data.birthYear,
        passingYear: data.passingYear,
        lifeSpanText: years.formatMemorialLifeSpan(data.birthYear, data.passingYear)
      }
    }
    return {}
  }
  vm.runInNewContext(fs.readFileSync(memoryPath, 'utf8'), {
    Page: (def) => { page = def },
    require: (name) => name.endsWith('/cloud')
      ? { callFunction: api }
      : name.endsWith('/image-upload')
        ? {}
        : name.endsWith('/memorial-portrait-layout')
          ? require('../../miniprogram/packageMemorial/scene/memorial-portrait-layout')
          : name.endsWith('/recovery-time')
            ? require('../../miniprogram/packageMemorial/scene/recovery-time')
            : name.endsWith('/memorial-years')
              ? require('../../miniprogram/packageMemorial/scene/memorial-years')
              : name.endsWith('/plot-number')
                ? { plotNumber: () => '01-01' }
                : {},
    wx: { showToast: (v) => toasts.push(v.title) }
  })
  page.setData = (values) => {
    for (const [key, value] of Object.entries(values)) {
      const parts = key.split('.')
      let object = page.data
      for (const part of parts.slice(0, -1)) object = object[part]
      object[parts[parts.length - 1]] = value
    }
  }
  page._alive = true
  page.id = 'app_1'
  return { page, calls, toasts }
}

test('memorial WXML surfaces expose birth/passing year pickers and unknown toggles', () => {
  const gardenWxml = fs.readFileSync(gardenPath.replace(/\.js$/, '.wxml'), 'utf8')
  const memoryWxml = fs.readFileSync(memoryPath.replace(/\.js$/, '.wxml'), 'utf8')
  const adminWxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/admin/memorial/index.wxml'), 'utf8')

  assert.ok(gardenWxml.includes('bindchange="chooseApplicationYear"'))
  assert.ok(gardenWxml.includes('bindtap="setYearUnknown"'))
  assert.ok(gardenWxml.includes('出生年份') && gardenWxml.includes('去世年份'))

  assert.ok(memoryWxml.includes('bindchange="chooseYear"'))
  assert.ok(memoryWxml.includes('bindtap="setYearUnknown"'))
  assert.ok(memoryWxml.includes('bindtap="saveYears"'))
  assert.ok(adminWxml.includes('item.lifeSpanText'))
})

test('garden application form defaults unknown years, validates order, and submits chosen birth/passing years', async () => {
  const { page, toasts, submitted } = loadGarden()
  page.openApplication()

  assert.equal(page.data.form.birthYear, 'unknown')
  assert.equal(page.data.form.passingYear, 'unknown')
  assert.equal(page.data.formLifeSpanPreview, '未知 — 未知')

  const options = page.data.yearOptions
  const idx2020 = options.findIndex((o) => o.value === '2020')
  const idx2016 = options.findIndex((o) => o.value === '2016')
  const idx2025 = options.findIndex((o) => o.value === '2025')
  assert.ok(idx2020 > 0 && idx2016 > 0 && idx2025 > 0)

  page.inputApplication({ currentTarget: { dataset: { field: 'petName' } }, detail: { value: '团子' } })
  page.inputApplication({ currentTarget: { dataset: { field: 'epitaph' } }, detail: { value: '谢谢你陪我长大' } })
  page.inputApplication({ currentTarget: { dataset: { field: 'date' } }, detail: { value: '2025-02-14' } })

  // Selecting birthYear > passingYear shows toast error and skips submit.
  page.chooseApplicationYear({ currentTarget: { dataset: { field: 'birthYear' } }, detail: { value: idx2025 } })
  page.chooseApplicationYear({ currentTarget: { dataset: { field: 'passingYear' } }, detail: { value: idx2020 } })
  await page.submitApplication()
  assert.equal(submitted.length, 0)
  assert.match(toasts[toasts.length - 1], /出生年份不能晚于去世年份/)

  // Setting birthYear to unknown via chip works and passes validation cleanly.
  page.setYearUnknown({ currentTarget: { dataset: { field: 'birthYear' } } })
  assert.equal(page.data.form.birthYear, 'unknown')
  assert.equal(page.data.formLifeSpanPreview, '未知 — 2020')

  await page.submitApplication()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].birthYear, 'unknown')
  assert.equal(submitted[0].passingYear, '2020')

  // Selecting concrete range also submits accurately.
  const secondPlot = world.cells.find((c) => c.id === require('../../cloudfunctions/api/config/memorial-plots.json').ids[1])
  page.data.selection = { ...secondPlot, plotId: secondPlot.id }
  page.openApplication()
  page.inputApplication({ currentTarget: { dataset: { field: 'petName' } }, detail: { value: '豆豆' } })
  page.inputApplication({ currentTarget: { dataset: { field: 'epitaph' } }, detail: { value: '想念' } })
  page.inputApplication({ currentTarget: { dataset: { field: 'date' } }, detail: { value: '2025-03-01' } })
  page.chooseApplicationYear({ currentTarget: { dataset: { field: 'birthYear' } }, detail: { value: idx2016 } })
  page.chooseApplicationYear({ currentTarget: { dataset: { field: 'passingYear' } }, detail: { value: idx2025 } })
  assert.equal(page.data.formLifeSpanPreview, '2016 — 2025')
  await page.submitApplication()
  assert.equal(submitted[1].birthYear, '2016')
  assert.equal(submitted[1].passingYear, '2025')
})

test('memory owner editor saves updated birth/passing years including unknown and updates header', async () => {
  const { page, calls, toasts } = loadMemory(true, { birthYear: '2016', passingYear: '2025', lifeSpanText: '2016 — 2025' })
  await page.load()

  assert.equal(page.data.editBirthYear, '2016')
  assert.equal(page.data.editPassingYear, '2025')
  assert.equal(page.data.hasYearChanges, false)

  const options = page.data.yearOptions
  const idx2026 = options.findIndex((o) => o.value === '2026')
  const idx2015 = options.findIndex((o) => o.value === '2015')

  // Rejects birth > passing client-side before API call.
  page.chooseYear({ currentTarget: { dataset: { field: 'birthYear' } }, detail: { value: idx2026 } })
  await page.saveYears()
  assert.equal(calls.some((c) => c.action === 'updateYears'), false)
  assert.match(page.data.yearError, /出生年份不能晚于去世年份/)

  // Unknown birth year + passing 2015 -> saves cleanly.
  page.setYearUnknown({ currentTarget: { dataset: { field: 'birthYear' } } })
  page.chooseYear({ currentTarget: { dataset: { field: 'passingYear' } }, detail: { value: idx2015 } })
  assert.equal(page.data.hasYearChanges, true)
  await page.saveYears()

  const req = calls.find((c) => c.action === 'updateYears')
  assert.equal(req.data.birthYear, 'unknown')
  assert.equal(req.data.passingYear, '2015')
  assert.equal(page.data.detail.lifeSpanText, '未知 — 2015')
  assert.equal(page.data.hasYearChanges, false)
  assert.equal(toasts[toasts.length - 1], '年份已更新')

  // Visitor cannot edit years.
  const visitor = loadMemory(false)
  await visitor.page.load()
  visitor.page.setYearUnknown({ currentTarget: { dataset: { field: 'birthYear' } } })
  await visitor.page.saveYears()
  assert.equal(visitor.calls.some((c) => c.action === 'updateYears'), false)
})

test('legacy memorials without stored years do not start with a false pending year edit', async () => {
  const { page, calls } = loadMemory(true)
  await page.load()
  assert.equal(page.data.editBirthYear, 'unknown')
  assert.equal(page.data.editPassingYear, 'unknown')
  assert.equal(page.data.hasYearChanges, false)

  const yearIndex = page.data.yearOptions.findIndex((option) => option.value === '2020')
  page.chooseYear({ currentTarget: { dataset: { field: 'birthYear' } }, detail: { value: yearIndex } })
  assert.equal(page.data.hasYearChanges, true)
  page.setYearUnknown({ currentTarget: { dataset: { field: 'birthYear' } } })
  assert.equal(page.data.hasYearChanges, false)
  await page.saveYears()
  assert.equal(calls.some((call) => call.action === 'updateYears'), false)
})
