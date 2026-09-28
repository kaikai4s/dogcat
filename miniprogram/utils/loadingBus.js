// loadingBus.js - 全局加载状态事件总线与控制中心
const listeners = {
  show: new Set(),
  hide: new Set()
}

let currentTitle = '加载中...'
let isVisible = false

const loadingBus = {
  on(event, handler) {
    if (listeners[event]) {
      listeners[event].add(handler)
    }
  },
  off(event, handler) {
    if (listeners[event]) {
      listeners[event].delete(handler)
    }
  },
  emit(event, data) {
    if (listeners[event]) {
      listeners[event].forEach((handler) => {
        try {
          handler(data)
        } catch (err) {
          console.error('[loadingBus error]', err)
        }
      })
    }
  },
  hasActiveListener() {
    return listeners.show.size > 0
  },
  show(options = {}) {
    const title = typeof options === 'string' ? options : (options && options.title) || '加载中...'
    currentTitle = title
    isVisible = true
    this.emit('show', { title })
  },
  hide() {
    isVisible = false
    this.emit('hide')
  },
  getState() {
    return { isVisible, currentTitle }
  }
}

module.exports = {
  loadingBus
}
