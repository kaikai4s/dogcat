Component({
  properties: {
    bundle: { type: Object, value: null },
    currentId: { type: String, value: '' },
    allowSwitch: { type: Boolean, value: false }
  },
  data: { selectedId: '', selected: null },
  observers: {
    'bundle,currentId': function (bundle, currentId) {
      const members = bundle && bundle.members || []
      const switched = currentId !== this._currentOrderId
      this._currentOrderId = currentId
      const selected = (switched ? members.find((m) => m.orderId === currentId) : members.find((m) => m.orderId === this.data.selectedId)) || members.find((m) => m.orderId === currentId) || members[0] || null
      this.setData({ selectedId: selected ? selected.orderId : '', selected })
    }
  },
  methods: {
    select(e) {
      const id = e.currentTarget.dataset.id
      const selected = (this.data.bundle && this.data.bundle.members || []).find((m) => m.orderId === id)
      if (selected) this.setData({ selectedId: id, selected })
    },
    open() { this.triggerEvent('switchhousehold', { orderId: this.data.selectedId }) },
    preview(e) { const url = e.currentTarget.dataset.url; if (url) wx.previewImage({ current: url, urls: [url] }) }
  }
})
