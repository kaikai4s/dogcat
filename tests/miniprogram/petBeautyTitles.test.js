const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function createPage(respond) {
  let page
  const errors = []
  const calls = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/client/pets/edit/index.js'), 'utf8'), {
    Page(config) { page = config },
    require(name) { if (name.endsWith('/format')) return require('../../miniprogram/utils/format'); return {
      navMethods: () => ({}),
      showError: (error) => errors.push(error.message),
      callFunction: async (module, action, data) => { calls.push({ module, action, data }); return respond(action, data) }
    } },
    wx: { showToast() {} }
  })
  page.setData = (updates, callback) => {
    for (const [key, value] of Object.entries(updates)) {
      if (key.startsWith('form.')) page.data.form[key.slice(5)] = value
      else page.data[key] = value
    }
    if (callback) callback()
  }
  page.data.id = 'pet'
  return { page, errors, calls }
}

test('monthly award picker loads selected award, removes it and re-equips it', async () => {
  const award = { monthKey: '2026-08', title: '8月最美爱宠' }
  const { page, calls } = createPage((action) => action === 'listMyBeautyTitles'
    ? { titles: [award], beautyTitle: award }
    : { beautyTitle: action === 'unequipBeautyTitle' ? null : award })
  await page.loadBeautyTitles()
  assert.equal(page.data.selectedBeautyTitleIndex, 1)
  assert.ok(page.data.beautyTitleOptions[1].label.includes('2026-08'))
  await page.chooseBeautyTitle({ detail: { value: '0' } })
  assert.equal(page.data.form.beautyTitle, null)
  assert.equal(page.data.beautyTitleOptions.length, 2)
  await page.chooseBeautyTitle({ detail: { value: '1' } })
  assert.equal(page.data.form.beautyTitle.title, award.title)
  assert.equal(calls[2].data.awardMonthKey, '2026-08')
  assert.equal(page.data.beautyTitleSaving, false)
})

test('failed monthly award changes keep current selection and failed loads can retry', async () => {
  const award = { monthKey: '2026-08', title: '8月最美爱宠' }
  let failLoading = true
  const { page, errors, calls } = createPage((action) => {
    if (action === 'listMyBeautyTitles' && !failLoading) return { titles: [award], beautyTitle: award }
    throw new Error('network error')
  })
  await page.loadBeautyTitles()
  assert.equal(page.data.beautyTitleLoadFailed, true)
  await page.chooseBeautyTitle({ detail: { value: '0' } })
  assert.equal(calls.length, 1)
  failLoading = false
  await page.loadBeautyTitles()
  assert.equal(page.data.beautyTitleLoadFailed, false)
  await page.chooseBeautyTitle({ detail: { value: '0' } })
  assert.equal(page.data.selectedBeautyTitleIndex, 1)
  assert.equal(page.data.form.beautyTitle.title, award.title)
  assert.equal(page.data.beautyTitleSaving, false)
  assert.equal(errors.length, 2)
})
