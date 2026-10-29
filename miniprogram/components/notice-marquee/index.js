const TRACK_MIN_WIDTH_RPX = 750
const ITEM_SPACING_RPX = 48
const SCROLL_SPEED_RPX_PER_SECOND = 76

function estimateTextWidth(text) {
  let width = 0
  for (const char of text) width += char.charCodeAt(0) > 255 ? 23 : 11
  return width
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    notice: { type: Object, value: { enabled: false, items: [] } },
    theme: { type: String, value: 'theme-day' },
    fontClass: { type: String, value: '' }
  },
  data: { cycleItems: [], duration: 12 },
  observers: {
    notice(notice) {
      const items = notice && notice.enabled && Array.isArray(notice.items)
        ? notice.items.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
        : []
      if (!items.length) {
        this.setData({ cycleItems: [], duration: 12 })
        return
      }

      const baseWidth = items.reduce((width, text) => width + estimateTextWidth(text) + ITEM_SPACING_RPX, 0)
      const copies = Math.max(1, Math.ceil(TRACK_MIN_WIDTH_RPX / baseWidth))
      const cycleItems = []
      for (let copy = 0; copy < copies; copy++) {
        for (let index = 0; index < items.length; index++) {
          cycleItems.push({ id: `${copy}-${index}`, text: items[index] })
        }
      }
      this.setData({
        cycleItems,
        duration: Math.max(10, Math.round(baseWidth * copies / SCROLL_SPEED_RPX_PER_SECOND * 10) / 10)
      })
    }
  },
  methods: {
    showNotice(e) {
      const text = e.currentTarget.dataset.text
      if (text) wx.showModal({ title: '平台公告', content: text, showCancel: false })
    }
  }
})
