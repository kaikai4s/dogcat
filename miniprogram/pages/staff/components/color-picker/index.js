const { clamp, hsvToHex, hexToHsv } = require('./color')

Component({
  properties: {
    value: { type: String, value: '#ffffff', observer: 'syncColor' }
  },
  data: { h: 0, s: 0, v: 100, hueColor: '#ff0000', selectedColor: '#ffffff' },
  lifetimes: {
    attached() { this.syncColor(this.properties.value) },
    detached() { this._touch = null; this._picking = false }
  },
  methods: {
    syncColor(value) {
      if (!/^#[0-9a-f]{6}$/i.test(value) || value === this._emittedColor) return
      const hsv = hexToHsv(value, this.data.h)
      this.setData({ ...hsv, hueColor: hsvToHex(hsv.h, 100, 100), selectedColor: value })
    },
    emitColor(h, s, v) {
      const value = hsvToHex(h, s, v)
      this._emittedColor = value
      this.setData({ h, s, v, hueColor: hsvToHex(h, 100, 100), selectedColor: value })
      this.triggerEvent('change', { value })
    },
    changeHue(e) {
      this.emitColor(Number(e.detail.value), this.data.s, this.data.v)
    },
    startPicking(e) {
      this._picking = true
      this._rect = null
      this._touch = e.touches[0]
      this.createSelectorQuery().select('.color-plane').boundingClientRect((rect) => {
        if (!rect || !rect.width || !rect.height) return
        this._rect = rect
        this.applyTouch(true)
      }).exec()
    },
    movePicking(e) {
      if (!this._picking) return
      this._touch = e.touches[0]
      this.applyTouch(false)
    },
    endPicking(e) {
      this._touch = (e.changedTouches && e.changedTouches[0]) || this._touch
      this.applyTouch(true)
      this._picking = false
    },
    applyTouch(force) {
      const rect = this._rect
      const touch = this._touch
      if (!rect || !touch) return
      if (!force && Date.now() - (this._lastPaint || 0) < 32) return
      this._lastPaint = Date.now()
      const s = clamp((touch.clientX - rect.left) / rect.width * 100, 100)
      const v = 100 - clamp((touch.clientY - rect.top) / rect.height * 100, 100)
      this.emitColor(this.data.h, s, v)
    }
  }
})
