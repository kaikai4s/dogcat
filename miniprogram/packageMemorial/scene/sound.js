// Adapter accepts wx InnerAudioContext or the browser preview equivalent.
class GardenSound {
  constructor(createAudio, onError, resolveAsset, onPlaying) {
    this.createAudio = createAudio
    this.onPlaying = onPlaying || (() => {})
    this.onError = onError || (() => {})
    this.resolveAsset = resolveAsset || (key => '/packageMemorial/assets/' + key)
    this.nodes = {}
    this.playVersion = {}
    this.music = false
    this.effects = false
    this.visible = true
    this.destroyed = false
    this.distance = 0
  }
  node(kind) {
    if (this.nodes[kind]) return this.nodes[kind]
    const node = this.createAudio()
    node.loop = kind === 'music'
    node.volume = kind === 'music' ? 0.32 : kind === 'step' ? 0.24 : 0.18
    node.obeyMuteSwitch = false
    node._ready = false
    if (node.onCanplay) node.onCanplay(() => {
      if (this.destroyed || this.nodes[kind] !== node) return
      node._ready = true
      if (node._start) node._start()
    })
    node.onError(error => { if (this.visible && this.nodes[kind] === node && node._requested) this.fail(kind, error) })
    if (node.onEnded) node.onEnded(() => {
      if (this.nodes[kind] !== node || this.destroyed) return
      node._playing = false; node._requested = false
    })
    if (node.onPause) node.onPause(() => { if (this.nodes[kind] === node && !node._requested) node._playing = false })
    if (node.onPlay) node.onPlay(() => {
      if (this.visible && this.nodes[kind] === node && node._requested) {
        node._playing = true
        this.onPlaying(kind === 'music' ? 'music' : 'effects', kind)
      }
    })
    this.nodes[kind] = node
    return node
  }
  fail(kind, error) {
    if (this.destroyed) return
    // WeChat reports repeated play() while the sound is already active as an
    // error. It is not a download/decoder failure and must not disable audio.
    if (/audio is playing|already playing|dont play ag[ai]in|don't play again/i.test(String(error && (error.errMsg || error.message) || error))) {
      const node = this.nodes[kind]
      if (node && node._requested) { node._playing = true; node._loading = false; this.onPlaying(kind === 'music' ? 'music' : 'effects', kind) }
      return
    }
    const setting = kind === 'music' ? 'music' : 'effects'
    if (!this[setting]) return
    this[setting] = false
    this.stopSetting(setting)
    if (this.resolveAsset.invalidate) this.resolveAsset.invalidate('audio/' + kind + '.wav')
    if (this.nodes[kind]) { this.nodes[kind].destroy(); delete this.nodes[kind] }
    this.onError(setting, error, kind)
  }
  play(kind, restart) {
    if (!this.visible || this.destroyed || !(kind === 'music' ? this.music : this.effects)) return
    try {
      const node = this.node(kind)
      if (node._requested && (kind === 'music' || node._loading || node._playing)) return
      node._requested = true; node._loading = true
      const version = this.playVersion[kind] = (this.playVersion[kind] || 0) + 1
      const failed = error => {
        if (this.visible && this.nodes[kind] === node && version === this.playVersion[kind]) this.fail(kind, error)
      }
      const start = path => {
        const enabled = kind === 'music' ? this.music : this.effects
        if (this.destroyed || !this.visible || !enabled || version !== this.playVersion[kind]) return
        try {
          node._requested = true
          const changed = node._source !== path
          // A downloaded file is not yet a decoded native audio source. Wait for
          // canplay instead of racing play() against the source assignment.
          const begin = () => {
            if (this.destroyed || !this.visible || this.nodes[kind] !== node || version !== this.playVersion[kind] || !node._requested) return
            node._start = null; node._loading = false
            clearTimeout(node._readyTimer); node._readyTimer = null
            try {
              if (restart && !changed && node._ready) node.seek(0)
              // Set synchronously: another tap can arrive before native onPlay.
              node._playing = true
              const result = node.play()
              if (result && result.catch) result.catch(failed)
            } catch (error) { failed(error) }
          }
          clearTimeout(node._readyTimer)
          if (changed) node._ready = false
          if (node.onCanplay && !node._ready) {
            node._start = begin
            node._readyTimer = setTimeout(() => failed(new Error('音频准备超时，请重试')), 10000)
            if (changed) { node._source = path; node.src = path }
          } else {
            if (changed) { node._source = path; node.src = path }
            begin()
          }
        } catch (error) { failed(error) }
      }
      const source = this.resolveAsset('audio/' + kind + '.wav')
      if (typeof source === 'string') start(source)
      else source.then(start, failed)
    } catch (error) { this.fail(kind, error) }
  }
  stopSetting(setting) {
    for (const kind of setting === 'music' ? ['music'] : ['step', 'chime']) {
      this.playVersion[kind] = (this.playVersion[kind] || 0) + 1
      if (this.nodes[kind]) {
        const node = this.nodes[kind]
        node._requested = false; node._loading = false; node._playing = false; node._start = null
        clearTimeout(node._readyTimer); node._readyTimer = null
        node.pause()
      }
    }
  }
  toggle(setting) {
    if (this.destroyed || !['music', 'effects'].includes(setting)) return false
    this[setting] = !this[setting]
    if (!this[setting]) this.stopSetting(setting)
    else if (setting === 'music') this.play('music')
    else this.chime()
    return this[setting]
  }
  configure(settings) {
    this.music = settings.music === true
    this.effects = settings.effects === true
    this.stopSetting('music'); this.stopSetting('effects')
    if (this.music) this.play('music')
  }
  travel(distance) {
    if (!this.effects || !this.visible || this.destroyed) { this.distance = 0; return }
    this.distance += Math.max(0, distance)
    if (this.distance >= 49) { this.distance %= 49; this.play('step', true) }
  }
  chime() { if (this.effects) this.play('chime', true) }
  pause() {
    this.visible = false
    this.distance = 0
    this.stopSetting('music'); this.stopSetting('effects')
  }
  resume() {
    if (this.destroyed || this.visible) return
    this.visible = true
    if (this.music) this.play('music')
  }
  destroy() {
    this.pause()
    this.destroyed = true
    Object.keys(this.nodes).forEach(kind => this.nodes[kind].destroy())
    this.nodes = {}
  }
}
module.exports = { GardenSound }
