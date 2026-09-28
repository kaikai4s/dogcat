const { loadingBus } = require('../../utils/loadingBus')

Component({
  data: {
    visible: false,
    title: '加载中...'
  },
  lifetimes: {
    attached() {
      this._isPageShowing = true
      this._onShow = ({ title }) => {
        if (this._isPageShowing) {
          this.setData({ visible: true, title: title || '加载中...' })
        }
      }
      this._onHide = () => {
        if (this.data.visible) {
          this.setData({ visible: false })
        }
      }
      loadingBus.on('show', this._onShow)
      loadingBus.on('hide', this._onHide)

      // 如果当前总线已经是显示状态，立即同步
      const state = loadingBus.getState()
      if (state.isVisible && this._isPageShowing) {
        this.setData({ visible: true, title: state.currentTitle })
      }
    },
    detached() {
      if (this._onShow) loadingBus.off('show', this._onShow)
      if (this._onHide) loadingBus.off('hide', this._onHide)
    }
  },
  pageLifetimes: {
    show() {
      this._isPageShowing = true
      const state = loadingBus.getState()
      if (state.isVisible) {
        this.setData({ visible: true, title: state.currentTitle })
      }
    },
    hide() {
      this._isPageShowing = false
      if (this.data.visible) {
        this.setData({ visible: false })
      }
    }
  },
  methods: {
    preventTouchMove() {
      // 阻止蒙层下穿透
    }
  }
})
