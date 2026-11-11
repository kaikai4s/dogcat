// Adapter accepts wx InnerAudioContext or the browser preview equivalent.
class GardenSound {
  constructor(createAudio, onError, resolveAsset) {
    this.createAudio = createAudio
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
    if (node.onCanplay) node.onCanplay(() => { node._ready = true })
    node.onError(() => { if (this.nodes[kind] === node) this.fail(kind) })
    this.nodes[kind] = node
    return node
  }
  fail(kind) {
    if (this.destroyed) return
    const setting = kind === 'music' ? 'music' : 'effects'
    if (!this[setting]) return
    this[setting] = false
    this.stopSetting(setting)
    if (this.resolveAsset.invalidate) this.resolveAsset.invalidate('audio/' + kind + '.wav')
    if (this.nodes[kind]) { this.nodes[kind].destroy(); delete this.nodes[kind] }
    this.onError(setting)
  }
  play(kind, restart) {
    if (!this.visible || this.destroyed) return
    try {
      const node = this.node(kind)
      const version = this.playVersion[kind] = (this.playVersion[kind] || 0) + 1
      const failed = () => {
        if (this.visible && version === this.playVersion[kind]) this.fail(kind)
      }
      const start = path => {
        const enabled = kind === 'music' ? this.music : this.effects
        if (this.destroyed || !this.visible || !enabled || version !== this.playVersion[kind]) return
        try {
          const changed = node._source !== path
          if (changed) { node._ready = false; node._source = path; node.src = path }
          // Seeking before native audio has decoded its source fails on Android.
          if (restart && !changed && node._ready) node.seek(0)
          const result = node.play()
          if (result && result.catch) result.catch(failed)
        } catch (_) { failed() }
      }
      const source = this.resolveAsset('audio/' + kind + '.wav')
      if (typeof source === 'string') start(source)
      else source.then(start, failed)
    } catch (_) { this.fail(kind) }
  }
  stopSetting(setting) {
    for (const kind of setting === 'music' ? ['music'] : ['step', 'chime']) {
      this.playVersion[kind] = (this.playVersion[kind] || 0) + 1
      if (this.nodes[kind]) this.nodes[kind].pause()
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
