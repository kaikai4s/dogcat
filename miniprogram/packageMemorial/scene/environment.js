// All calendar math uses UTC+8, independent of the phone's locale/time zone.
const HOUR = 3600000, DAY = 24 * HOUR, OFFSET = 8 * HOUR
const WEATHER_SLOT = 90 * 60000, WEATHER_BLEND = 12 * 60000
const SEASONS = ['spring', 'summer', 'autumn', 'winter']
const SEASON_NAMES = { spring: '春日', summer: '夏日', autumn: '秋日', winter: '冬日' }
const WEATHER_NAMES = { clear: '晴朗', cloudy: '多云', rain: '细雨', mist: '薄雾', snow: '轻雪' }
const TABLES = {
  spring: [['clear', 42], ['cloudy', 24], ['rain', 25], ['mist', 9]],
  summer: [['clear', 53], ['cloudy', 23], ['rain', 24]],
  autumn: [['clear', 56], ['cloudy', 22], ['rain', 10], ['mist', 12]],
  winter: [['clear', 38], ['cloudy', 30], ['snow', 24], ['mist', 8]]
}
const clamp = n => Math.max(0, Math.min(1, n))
const smooth = n => { const t = clamp(n); return t * t * (3 - 2 * t) }
const mix = (a, b, t) => a + (b - a) * t
function hash(value) {
  let n = 2166136261
  for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619)
  n ^= n >>> 16; n = Math.imul(n, 0x7feb352d); n ^= n >>> 15
  return (n >>> 0) / 4294967296
}
function calendar(time) {
  const date = new Date(time + OFFSET), month = date.getUTCMonth() + 1
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600 + date.getUTCMilliseconds() / 3600000
  const index = Math.floor((month + 9) % 12 / 3), season = SEASONS[index]
  const startMonth = [3, 6, 9, 12][index]
  const startYear = date.getUTCFullYear() - (month < 3 ? 1 : 0)
  const since = time - (Date.UTC(startYear, startMonth - 1, 1) - OFFSET)
  return { date, hour, season, previous: SEASONS[(index + 3) % 4], seasonMix: smooth(since / (7 * DAY)) }
}
function weatherAt(garden, slot) {
  const season = calendar(slot * WEATHER_SLOT).season
  const seed = String(garden) + ':weather-v1:' + slot
  let roll = hash(seed) * 100, kind = 'clear'
  for (const [name, weight] of TABLES[season]) { roll -= weight; if (roll < 0) { kind = name; break } }
  return { kind, amount: .45 + hash(seed + ':amount') * .5, wind: (hash(seed + ':wind') - .5) * 2 }
}
function environmentAt(time, garden = 'garden-ortho-v2') {
  const cal = calendar(time), slot = Math.floor(time / WEATHER_SLOT)
  const a = weatherAt(garden, slot - 1), b = weatherAt(garden, slot)
  const blend = smooth((time - slot * WEATHER_SLOT) / WEATHER_BLEND)
  const value = (weather, name) => weather.kind === name ? weather.amount : 0
  const weather = { kind: blend < .5 ? a.kind : b.kind, wind: mix(a.wind, b.wind, blend) }
  for (const name of ['rain', 'snow', 'mist', 'cloudy']) weather[name] = mix(value(a, name), value(b, name), blend)
  const seasons = Object.fromEntries(SEASONS.map(s => [s, 0]))
  seasons[cal.previous] = 1 - cal.seasonMix; seasons[cal.season] = cal.seasonMix
  // Artistic Beijing-time dawn/dusk windows, deliberately not geolocation or
  // astronomical sunrise. Interpolate through seasonal boundaries as well.
  const windows = { spring: [6, 18.3], summer: [5.3, 19.1], autumn: [6.2, 17.8], winter: [7.1, 17.2] }
  const sunrise = SEASONS.reduce((sum, s) => sum + windows[s][0] * seasons[s], 0)
  const sunset = SEASONS.reduce((sum, s) => sum + windows[s][1] * seasons[s], 0)
  const daylight = smooth((cal.hour - sunrise + .8) / 1.6) * (1 - smooth((cal.hour - sunset + .8) / 1.6))
  const bell = center => Math.max(0, 1 - Math.abs(cal.hour - center) / 1.3)
  const dawn = smooth(bell(sunrise)), dusk = smooth(bell(sunset))
  const phase = cal.hour < sunrise - .8 || cal.hour > sunset + .8 ? '夜晚' :
    cal.hour < sunrise + 1 ? '清晨' : cal.hour > sunset - 1 ? '黄昏' : '白天'
  const overcast = Math.min(1, weather.cloudy * .8 + weather.rain * .9 + weather.snow * .65 + weather.mist * .3)
  const pad = n => String(n).padStart(2, '0')
  return { time, season: cal.season, seasons, weather, daylight, night: 1 - daylight, dawn, dusk, overcast, phase,
    label: SEASON_NAMES[cal.season] + ' · ' + phase + ' · ' + WEATHER_NAMES[weather.kind],
    timeText: pad(cal.date.getUTCHours()) + ':' + pad(cal.date.getUTCMinutes()) }
}
class GardenEnvironment {
  constructor(options = {}) {
    this.now = options.now || Date.now; this.garden = options.gardenId || 'garden-ortho-v2'
    this.offset = 0; this.onChange = options.onChange || (() => {})
  }
  sync(serverTime, sent, received = this.now()) {
    if (![serverTime, sent, received].every(Number.isFinite) || received < sent || received - sent > 10000) return false
    this.offset = serverTime - (sent + received) / 2
    this._at = undefined
    return true
  }
  sample() {
    const time = this.now() + this.offset
    // Date, hashes and labels update once a second; render particles use time
    // directly. No per-frame calendar work or extra networking.
    if (this._at === undefined || time < this._at || time - this._at >= 1000) {
      this._at = time; this.value = environmentAt(time, this.garden)
      const signature = this.value.label + ':' + this.value.timeText
      if (signature !== this._signature) { this._signature = signature; this.onChange(this.value) }
    }
    return this.value
  }
  time() { return this.now() + this.offset }
}
module.exports = { GardenEnvironment, environmentAt, calendar, weatherAt, hash, smooth, SEASONS, WEATHER_SLOT, WEATHER_BLEND }
