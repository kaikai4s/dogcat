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
    showToast() {},
    showActionSheet(options) { options.success({ tapIndex: 0 }) },
    showModal(options) { options.success({ confirm: true }) },
    stopPullDownRefresh() {}
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

test('admin disqualification closes preview and refreshes candidates and rankings without errors', async () => {
  const { page, calls, errors } = createPage({ storage: 'list', respond(action) {
    if (action === 'getActivityHome') return { monthKey: '2026-11', candidates: [pet(2)], ranking: [pet(2)] }
    if (action === 'listRanking') return { list: [pet(2)] }
    return {}
  } })
  page.onLoad()
  page.setData({ ranking: [pet(1), pet(2)], candidates: [pet(1), pet(2)], showPreviewModal: true, previewModalPet: pet(1) })
  page.handleAdminDisqualify({ currentTarget: { dataset: { id: 'pet-1', name: '宠物1' } } })
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    action: 'disqualifyPetBeautyCandidate',
    data: { petId: 'pet-1', reason: 'AI 生成图片，非真实自养宠物' }
  })
  assert.deepEqual(calls.map((call) => call.action), ['disqualifyPetBeautyCandidate', 'getActivityHome', 'listRanking'])
  assert.equal(page.data.showPreviewModal, false)
  assert.equal(page.data.previewModalPet, null)
  assert.deepEqual(Array.from(page.data.candidates, (item) => item.petId), ['pet-2'])
  assert.deepEqual(Array.from(page.data.ranking, (item) => item.petId), ['pet-2'])
  assert.equal(page.data.rankView, 'list')
  assert.equal(errors.length, 0)
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

test('previewPet and previewPoster skip reload on next onShow lifecycle when returning from fullscreen preview', async () => {
  const { page, calls, previews } = createPage({ respond(action, data) {
    if (action === 'getActivityHome') return { monthKey: '2026-11', candidates: [pet(1)], ranking: [pet(1)] }
    if (action === 'listRanking') return { list: [pet(1)] }
    if (action === 'listHistoryMonths') return { months: [] }
    return {}
  } })
  page.onLoad()
  page.setData({
    ranking: [pet(1), pet(2)],
    candidates: [pet(1)],
    contestConfig: { posterUrl: 'cloud://poster-test.jpg' },
    keyword: '保留搜索关键字'
  })

  // 1. 测试点击宠物大图预览
  page.previewPet({ currentTarget: { dataset: { id: 'pet-1' } } })
  assert.equal(previews.length, 1)
  assert.equal(previews[0].current, 'cloud://photo-1')
  assert.equal(page._skipNextOnShow, true, 'previewPet 应将 _skipNextOnShow 置为 true')

  // 模拟微信退出全屏图片预览器时触发页面的 onShow
  const initialCallCount = calls.length
  page.onShow()
  assert.equal(page._skipNextOnShow, false, '_skipNextOnShow 消费后应重置为 false')
  assert.equal(calls.length, initialCallCount, '预览返回触发 onShow 不应重新发起任何网络请求或重新加载榜单')
  assert.equal(page.data.keyword, '保留搜索关键字', '当前搜索状态与榜单数据应保持原样')

  // 2. 随后的普通 onShow 生命周期应恢复正常加载
  page.onShow()
  await flush()
  assert.ok(calls.length > initialCallCount, '正常的 onShow 应正常加载')

  // 3. 测试点击活动海报预览
  page.setData({ keyword: '海报测试关键字' })
  page.previewPoster()
  assert.equal(previews.length, 2)
  assert.equal(previews[1].current, 'cloud://poster-test.jpg')
  assert.equal(page._skipNextOnShow, true, 'previewPoster 应将 _skipNextOnShow 置为 true')

  // 模拟海报预览返回时的 onShow
  const callCountBeforePosterReturn = calls.length
  page.onShow()
  assert.equal(page._skipNextOnShow, false)
  assert.equal(calls.length, callCountBeforePosterReturn, '海报预览返回不应触发重新加载')
  assert.equal(page.data.keyword, '海报测试关键字')

  // 4. 测试历史月份下预览返回：标题应保持历史月份（如“8月宠物最美大赛”），不被冲刷成当前月
  page.setData({
    monthKey: '2026-11',
    currentMonthKey: '2026-11',
    selectedMonthIndex: 1,
    monthOptions: [
      { label: '2026-11 (本月)', value: '2026-11', isHistory: false },
      { label: '2026-08 (往期)', value: '2026-08', isHistory: true }
    ],
    candidates: [{ petId: 'pet-avatar-only', name: '仅头像宠物', avatarUrl: 'cloud://avatar-only.jpg' }]
  })
  page.updateContestTitle('2026-08')
  assert.equal(page.data.pageTitle, '8月宠物最美大赛')

  page.previewPet({ currentTarget: { dataset: { id: 'pet-avatar-only' } } })
  assert.equal(previews.length, 3)
  assert.equal(previews[2].current, 'cloud://avatar-only.jpg', 'avatarUrl 宠物也应能正常提取并预览大图')
  assert.equal(page._skipNextOnShow, true)

  page.onShow()
  assert.equal(page._skipNextOnShow, false)
  assert.equal(page.data.pageTitle, '8月宠物最美大赛', '大图预览返回后标题不得被错误重置为当月')

  // 5. 下拉刷新应强制重置 _skipNextOnShow 并恢复刷新加载
  page._skipNextOnShow = true
  const callCountBeforeRefresh = calls.length
  page.onPullDownRefresh()
  await flush()
  assert.equal(page._skipNextOnShow, false)
  assert.ok(calls.length > callCountBeforeRefresh, '下拉刷新应强制刷新榜单数据')
})

