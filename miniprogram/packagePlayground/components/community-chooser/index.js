const { callFunction, chooseSelectedLocation, showError } = require('../../../utils/cloud')
Component({
  data: { visible: false, loading: false, list: [], error: '', keyword: '', page: 1, hasMore: false, candidate: null, locating: false },
  lifetimes: { detached() { this._request = (this._request || 0) + 1; this.rejectSelection() } },
  methods: {
    open() {
      this.rejectSelection()
      this.setData({ visible: true, list: [], error: '', keyword: '', candidate: null, page: 1, hasMore: false, loading: false, locating: false })
      const promise = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject })
      this.load(false)
      return promise
    },
    rejectSelection() { if (this._reject) this._reject({ errMsg: 'chooseCommunity:fail cancel' }); this._reject = null; this._resolve = null },
    close() { this._request = (this._request || 0) + 1; this.setData({ visible: false, loading: false }); this.rejectSelection() },
    noop() {},
    keyword(e) { this.setData({ keyword: e.detail.value }) },
    search() { this.load(false) },
    more() { if (!this.data.loading && this.data.hasMore) this.load(true) },
    async load(append = false) {
      const version = (this._request || 0) + 1, page = append ? this.data.page + 1 : 1
      this._request = version
      this.setData({ loading: true, error: '' })
      try {
        const result = await callFunction('playground', 'listCommunities', { keyword: this.data.keyword, page })
        if (version === this._request && this.data.visible) this.setData({ list: append ? this.data.list.concat(result.list || []) : result.list || [], page, hasMore: !!result.hasMore })
      } catch (error) {
        if (version === this._request && this.data.visible) this.setData({ error: error.message || '小区列表暂时无法加载' })
      } finally { if (version === this._request) this.setData({ loading: false }) }
    },
    select(e) {
      const item = this.data.list.find(row => row.id === e.currentTarget.dataset.id)
      if (item) this.finish(item.community)
    },
    finish(community) {
      const resolve = this._resolve
      this._request = (this._request || 0) + 1
      this._resolve = null; this._reject = null
      this.setData({ visible: false, loading: false })
      if (resolve) resolve(community)
    },
    confirmCandidate() { if (this.data.candidate) this.finish(this.data.candidate.community) },
    async map() {
      if (this.data.locating) return
      this.setData({ locating: true, candidate: null })
      const version = this._request
      try {
        const location = await chooseSelectedLocation()
        const candidate = await callFunction('playground', 'getCommunityInfo', { community: location })
        if (this.data.visible && this._request === version) this.setData({ candidate })
      } catch (error) { if (this.data.visible && !String(error.errMsg || '').includes('cancel')) showError(error) }
      finally { if (this.data.visible) this.setData({ locating: false }) }
    }
  }
})
