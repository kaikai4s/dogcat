const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.js'), 'utf8')
const flush = () => new Promise((resolve) => setImmediate(resolve))
const pet = (rank) => ({ petId: `pet-${rank}`, name: `宠物${rank}`, rank, voteCount: 100 - rank, beautyPhotos: [{ fileId: `cloud://photo-${rank}` }] })

function createPage({ storage = '', storageFails = false, respond = () => ({}) } = {}) {
  let page
  const calls = []
  const previews = []
  const errors = []
  const wx = {
    getStorageSync() { if (storageFails) throw new Error('storage'); return storage },
    setStorageSync(key, value) { if (storageFails) throw new Error('storage'); storage = value },
    previewImage(options) { previews.push(options) },
    showToast() {}
  }
  vm.runInNewContext(source, {
    Page(config) { page = config },
    wx,
    require(name) {
      if (name.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      return {
        callFunction(module, action, data) { calls.push({ action, data }); return Promise.resolve(respond(action, data)) },
        ensureLogin: () => Promise.resolve(),
        showError: (err) => errors.push(err)
      }
    }
  })
  page.setData = function (update, callback) { Object.assign(this.data, update); if (callback) callback() }
  return { page, calls, previews, errors, savedView: () => storage }
}

test('default gallery, saved list preference and storage failures all allow switching without fetching', () => {
  const { page, calls, savedView } = createPage()
  page.onLoad()
  assert.equal(page.data.rankView, 'waterfall')
  page.switchRankView({ currentTarget: { dataset: { view: 'list' } } })
  assert.equal(page.data.rankView, 'list')
  assert.equal(savedView(), 'list')
  assert.equal(calls.length, 0)
  const reopened = createPage({ storage: savedView() }).page
  reopened.onLoad()
  assert.equal(reopened.data.rankView, 'list')
  const unavailable = createPage({ storageFails: true }).page
  unavailable.onLoad()
  unavailable.switchRankView({ currentTarget: { dataset: { view: 'list' } } })
  assert.equal(unavailable.data.rankView, 'list')
  unavailable.switchRankView({ currentTarget: { dataset: { view: 'invalid' } } })
  assert.equal(unavailable.data.rankView, 'list')
})

test('home loads paginated rankings; both columns retain every pet when appending and switching', async () => {
  const { page, errors } = createPage({ respond(action, data) {
    if (action === 'getActivityHome') return { monthKey: '2026-09', ranking: [pet(1)], candidates: [] }
    if (action === 'listRanking') return { list: data.page === 1 ? [pet(1), pet(2), pet(3)] : [pet(4), pet(5)], page: data.page, hasMore: data.page === 1 }
    return {}
  } })
  page.loadHome()
  await flush()
  assert.equal(page.data.ranking.length, 3)
  assert.equal(page.data.hasMore, true)
  page.loadMore()
  await flush()
  assert.equal(page.data.ranking.length, 5)
  assert.deepEqual(Array.from(page.data.rankColumns[0].pets, (p) => p.displayRank), [1, 3, 5])
  assert.deepEqual(Array.from(page.data.rankColumns[1].pets, (p) => p.displayRank), [2, 4])
  assert.equal(page.data.rankColumns[0].pets[0].coverUrl, 'cloud://photo-1')
  page.switchRankView({ currentTarget: { dataset: { view: 'list' } } })
  assert.equal(page.data.ranking.length, 5)
  assert.equal(page.data.hasMore, false)
  assert.equal(errors.length, 0)
})

test('history search keeps actual ranks and snapshot photos; returning to current month unlocks voting', async () => {
  const { page, calls, previews } = createPage({ respond(action, data) {
    return { list: [pet(42)], isHistory: !!data.historyMonthKey, locked: !!data.historyMonthKey }
  } })
  page.setData({ candidates: [{ ...pet(42), beautyPhotos: [{ fileId: 'cloud://current-photo' }] }], keyword: '宠物42', monthOptions: [{ value: '2026-09', isHistory: false }, { value: '2026-08', isHistory: true }] })
  page.onMonthChange({ detail: { value: 1 } })
  await flush()
  assert.equal(page.data.rankColumns[0].pets[0].displayRank, 42)
  page.previewPet({ currentTarget: { dataset: { id: 'pet-42' } } })
  assert.equal(previews[0].current, 'cloud://photo-42')
  page.clearSearch()
  await flush()
  assert.equal(calls[calls.length - 1].data.historyMonthKey, '2026-08')
  assert.equal(page.data.keyword, '')
  page.vote({ currentTarget: { dataset: { id: 'pet-42' } } })
  assert.equal(calls.filter((c) => c.action === 'vote').length, 0)
  page.onMonthChange({ detail: { value: 0 } })
  await flush()
  assert.equal(page.data.locked, false)
  assert.equal(page.data.isHistory, false)
})

test('vote updates both views and refreshes server order without changing view preference', async () => {
  const { page, calls, errors } = createPage({ storage: 'list', respond(action) {
    if (action === 'vote') return { voteCount: 200 }
    return { list: [{ ...pet(2), rank: 1, voteCount: 200 }, { ...pet(1), rank: 2 }] }
  } })
  page.onLoad()
  page.setData({ ranking: [pet(1), pet(2)], candidates: [pet(2)] })
  page.vote({ currentTarget: { dataset: { id: 'pet-2' } } })
  await flush()
  assert.equal(page.data.rankView, 'list')
  assert.equal(page.data.hasVotedToday, true)
  assert.equal(page.data.candidates[0].voteCount, 200)
  assert.equal(page.data.ranking[0].petId, 'pet-2')
  assert.equal(page.data.rankColumns[0].pets[0].displayRank, 1)
  assert.equal(page.data.rankColumns[0].pets[0].voteCount, 200)
  page.vote({ currentTarget: { dataset: { id: 'pet-1' } } })
  assert.equal(calls.filter((c) => c.action === 'vote').length, 1)
  assert.equal(errors.length, 0)
})
