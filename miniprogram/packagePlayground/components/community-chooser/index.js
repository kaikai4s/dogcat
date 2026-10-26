const { callFunction, chooseSelectedLocation, showError } = require('../../../utils/cloud')
Component({
  data: { visible: false, loading: false, list: [], error: '', keyword: '', city: '', page: 1, hasMore: false, candidate: null, locating: false,
    applying: false, applyForm: null, applicationNotice: '', formError: '' },
  lifetimes: { detached() { this._lifecycle = (this._lifecycle || 0) + 1; this._request = (this._request || 0) + 1; this.rejectSelection() } },
  methods: {
    open() {
      if (this.data.applying || this.data.locating) return Promise.reject({ errMsg: 'chooseCommunity:fail busy' })
      this.rejectSelection()
      this._lifecycle = (this._lifecycle || 0) + 1
      this.setData({ visible: true, list: [], error: '', keyword: '', city: '', candidate: null, page: 1, hasMore: false, loading: false, locating: false,
        applying: false, applyForm: null, applicationNotice: '', formError: '' })
      const promise = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject })
      this.load(false)
      return promise
    },
    rejectSelection() { if (this._reject) this._reject({ errMsg: 'chooseCommunity:fail cancel' }); this._reject = null; this._resolve = null },
    close() { if (this.data.applying) return; this._lifecycle = (this._lifecycle || 0) + 1; this._request = (this._request || 0) + 1; this.setData({ visible: false, loading: false, locating: false }); this.rejectSelection() },
    noop() {},
    keyword(e) { this.setData({ keyword: e.detail.value }) },
    city(e) { this.setData({ city: e.detail.value }) },
    search() { if (!this.data.applying && !this.data.applyForm && !this.data.locating) this.load(false) },
    more() { if (!this.data.loading && !this.data.applying && !this.data.applyForm && this.data.hasMore) this.load(true) },
    async load(append = false) {
      const version = (this._request || 0) + 1, page = append ? this.data.page + 1 : 1
      if (!append) this._query = { keyword: this.data.keyword.trim(), city: this.data.city.trim() }
      const query = this._query || { keyword: '', city: '' }
      this._request = version
      this.setData({ loading: true, error: '', ...(append ? {} : { list: [], hasMore: false, page: 1 }) })
      try {
        const result = await callFunction('playground', 'listCommunities', { ...query, page })
        if (version === this._request && this.data.visible) {
          const rows = append ? this.data.list.concat(result.list || []) : result.list || []
          this.setData({ list: [...new Map(rows.map(row => [row.id, row])).values()], page, hasMore: !!result.hasMore })
        }
      } catch (error) {
        if (version === this._request && this.data.visible) this.setData({ error: error.message || '小区列表暂时无法加载' })
      } finally { if (version === this._request) this.setData({ loading: false }) }
    },
    select(e) {
      if (this.data.applying || this.data.loading || this.data.locating || this.data.applyForm) return
      const item = this.data.list.find(row => row.id === e.currentTarget.dataset.id)
      if (item) this.finish(item.community)
    },
    finish(community) {
      const resolve = this._resolve
      this._lifecycle = (this._lifecycle || 0) + 1
      this._request = (this._request || 0) + 1
      this._resolve = null; this._reject = null
      this.setData({ visible: false, loading: false })
      if (resolve) resolve(community)
    },
    newApplication() {
      if (this.data.applying || this.data.locating) return
      this._request = (this._request || 0) + 1
      this.setData({ loading: false, applyForm: { name: this.data.keyword || '', city: this.data.city || '', district: '' }, applicationNotice: '', formError: '' })
    },
    inputApplication(e) {
      const field = e.currentTarget.dataset.field
      if (this.data.applying || !['name', 'city', 'district'].includes(field)) return
      this.setData({ applyForm: { ...this.data.applyForm, [field]: e.detail.value }, formError: '' })
    },
    cancelApplication() { if (!this.data.applying) { this.setData({ applyForm: null, formError: '' }); this.load(false) } },
    async submitApplication() {
      if (this.data.applying || !this.data.applyForm) return
      const form = this.data.applyForm
      if (!String(form.name || '').trim() || !String(form.city || '').trim()) { this.setData({ formError: '请填写小区名称和所在城市' }); return }
      this.setData({ applying: true, formError: '' })
      const version = this._lifecycle
      try {
        // Only public names are submitted; map coordinates and addresses stay out of the application.
        const result = await callFunction('communityMap', 'applyCommunity', { name: form.name, city: form.city, district: form.district || '' })
        if (!this.data.visible || version !== this._lifecycle) return
        const resolved = result.status === 'resolved' && result.community
        this.setData({ applyForm: null, city: String(resolved?.city || form.city).trim(), keyword: String(resolved?.name || form.name).trim(), applicationNotice: result.status === 'resolved' ? '该小区已维护，可在下方选择' : '申请已提交，后台核验并启用后即可选择；首位有效申请人可获得小区初创者头衔' })
        // Refresh independently: a slow directory request must not lock a
        // successfully submitted form or prevent closing the selector.
        this.load(false)
      } catch (error) { if (this.data.visible && version === this._lifecycle) { this.setData({ formError: error.message || '申请提交失败，请稍后重试' }); showError(error) } }
      finally { if (version === this._lifecycle) this.setData({ applying: false }) }
    },
    async map() {
      if (this.data.locating || this.data.applying) return
      this.setData({ locating: true, candidate: null })
      const version = this._lifecycle
      try {
        const location = await chooseSelectedLocation()
        if (this.data.visible && this._lifecycle === version) {
          this._request = (this._request || 0) + 1
          this.setData({ loading: false, applyForm: { name: location.name || '', city: location.city || this.data.city || '', district: location.district || '' }, applicationNotice: '', formError: '' })
        }
      } catch (error) { if (this.data.visible && this._lifecycle === version && !String(error.errMsg || '').includes('cancel')) showError(error) }
      finally { if (version === this._lifecycle) this.setData({ locating: false }) }
    }
  }
})
