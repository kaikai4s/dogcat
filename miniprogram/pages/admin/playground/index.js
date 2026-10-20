const { callFunction, showError, setCachedSystemSettings } = require('../../../utils/cloud')
const fieldGroups = [
  { key: 'decay', title: '日常消耗', description: '每小时变化的数值', fields: [
    ['energyDecay','精力下降','点 / 小时',1,100], ['satietyDecay','饱腹下降','点 / 小时',1,100], ['hydrationDecay','水分下降','点 / 小时',1,100],
    ['peeGrowth','尿意增长','点 / 小时',1,100], ['poopGrowth','便意增长','点 / 小时',1,100]
  ] },
  { key: 'recovery', title: '照护恢复', description: '对应动作每秒恢复的数值', fields: [
    ['sleepRate','休息恢复精力','点 / 秒',.01,10], ['eatRate','进食恢复饱腹','点 / 秒',.01,10], ['drinkRate','饮水恢复水分','点 / 秒',.01,10]
  ] },
  { key: 'waste', title: '院外排泄', description: '达到触发值后开始计时，回到庭院则取消等待', fields: [
    ['peeThreshold','嘘嘘触发值','点',1,100], ['peeDelaySeconds','嘘嘘等待时长','秒',1,600],
    ['poopThreshold','便便触发值','点',1,100], ['poopDelaySeconds','便便等待时长','秒',1,600]
  ] }
].map(group => ({ ...group, fields: group.fields.map(([key,label,unit,min,max]) => ({key,label,unit,min,max})) }))
function validate(settings) {
  const group = settings.playgroundGroupBuy
  const checks = [
    [group.minHouseholds, 2, 20, '成团户数', true], [group.discountRate, .01, 1, '拼单折扣比例'],
    [group.recruitHours, 1, 48, '募集时长', true],
    [settings.playground.width, 224, 11200, '地面宽度', true], [settings.playground.height, 224, 11200, '地面长度', true]
  ]
  for (const kind of ['cat', 'dog']) for (const section of fieldGroups) for (const field of section.fields) {
    checks.push([settings.playgroundCare[kind][field.key], field.min, field.max, (kind === 'cat' ? '猫咪' : '狗狗') + field.label])
  }
  for (const [raw, min, max, label, integer] of checks) {
    const value = raw === '' || raw == null ? NaN : Number(raw)
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(label + '须在 ' + min + '～' + max + ' 之间' + (integer ? '，且为整数' : ''))
    }
  }
}
Page({
  data: { loading: true, loadError: false, saving: false, dirty: false, settings: null, activeSpecies: 'cat',
    species: [{key:'cat',label:'猫咪'},{key:'dog',label:'狗狗'}], fieldGroups },
  onShow() { if (!this.data.settings) return this.load() },
  async load() {
    this.setData({ loading: true, loadError: false })
    try { const settings = await callFunction('admin','getSystemSettings'); this.setData({ settings }); this.updatePreview() }
    catch(error) { this.setData({ loadError: true }); showError(error) }
    finally { this.setData({ loading: false }) }
  },
  selectSpecies(e) { this.setData({ activeSpecies: e.currentTarget.dataset.key }) },
  input(e) { this.setData({ ['settings.' + e.currentTarget.dataset.field]: e.detail.value, dirty: true }); this.updatePreview() },
  toggle(e) { this.setData({ ['settings.' + e.currentTarget.dataset.field]: e.detail.value, dirty: true }); this.updatePreview() },
  updatePreview() {
    const rules = this.data.settings.playgroundGroupBuy, rate = Number(rules.discountRate)
    this.setData({ discountText: rate > 0 && rate <= 1 ? Number((rate * 10).toFixed(2)) + '折' : '—',
      exampleAmount: rate > 0 && rate <= 1 ? ((rules.waiveVisitFee ? 80 : 100) * rate).toFixed(2) : '—' })
  },
  async save() {
    if (this.data.saving || !this.data.settings || !this.data.adminSuper) return
    try { validate(this.data.settings) } catch (error) { return showError(error) }
    this.setData({saving:true})
    try {
      const s = this.data.settings
      const result = await callFunction('admin','savePlaygroundSettings',{playground:s.playground,playgroundGroupBuy:s.playgroundGroupBuy,playgroundCare:s.playgroundCare})
      setCachedSystemSettings(result); this.setData({ settings: result, dirty: false }); this.updatePreview()
      wx.showToast({title:'庄园配置已保存'})
    } catch(error) { showError(error) } finally { this.setData({saving:false}) }
  }
})
