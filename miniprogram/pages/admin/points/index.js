const { callFunction, showError } = require('../../../utils/cloud')

function buildRetroMailMemberLevels(levels, selectedIds) {
  const selectedSet = new Set(selectedIds || [])
  return (levels || []).map((item) => ({
    ...item,
    checked: selectedSet.has(item._id)
  }))
}

Page({
  data: {
    logs: [],
    form: { openid: '', delta: '', reason: '' },
    filterOpenid: '',
    memberLevels: [],
    retroMailMemberLevels: [],
    retroMailTargetTypes: [
      { label: '指定用户', value: 'openid_list' },
      { label: '全部正常用户', value: 'all_active' },
      { label: '按角色', value: 'role' },
      { label: '按会员等级', value: 'member_level' }
    ],
    retroMailTargetIndex: 0,
    retroMailRoles: [
      { label: '用户', value: 'client' },
      { label: '宠托师', value: 'staff' },
      { label: '管理员', value: 'admin' }
    ],
    retroMailRoleIndex: 0,
    retroMailForm: { targetType: 'openid_list', openids: '', role: 'client', targetLevelIds: [], count: '1', title: '补签卡奖励到账', content: '' }
  },

  onShow() {
    this.load()
    this.loadMemberLevels()
  },

  load() {
    callFunction('admin', 'listPointLogs', { openid: this.data.filterOpenid })
      .then((logs) => this.setData({ logs }))
      .catch(showError)
  },

  loadMemberLevels() {
    callFunction('admin', 'listMemberLevels')
      .then((levels) => {
        const memberLevels = levels || []
        this.setData({
          memberLevels,
          retroMailMemberLevels: buildRetroMailMemberLevels(memberLevels, this.data.retroMailForm.targetLevelIds)
        })
      })
      .catch(() => {})
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  filterInput(e) {
    this.setData({ filterOpenid: e.detail.value })
  },

  retroMailInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['retroMailForm.' + field]: e.detail.value })
  },

  changeRetroMailTarget(e) {
    const index = Number(e.detail.value || 0)
    const option = this.data.retroMailTargetTypes[index] || this.data.retroMailTargetTypes[0]
    this.setData({ retroMailTargetIndex: index, 'retroMailForm.targetType': option.value })
  },

  changeRetroMailRole(e) {
    const index = Number(e.detail.value || 0)
    const option = this.data.retroMailRoles[index] || this.data.retroMailRoles[0]
    this.setData({ retroMailRoleIndex: index, 'retroMailForm.role': option.value })
  },

  changeRetroMailLevels(e) {
    const targetLevelIds = e.detail.value || []
    this.setData({
      'retroMailForm.targetLevelIds': targetLevelIds,
      retroMailMemberLevels: buildRetroMailMemberLevels(this.data.memberLevels, targetLevelIds)
    })
  },

  search() {
    this.load()
  },

  grant() {
    const { openid, delta, reason } = this.data.form
    if (!openid) return wx.showToast({ title: '请填写用户 openid', icon: 'none' })
    const deltaNum = Math.round(Number(delta))
    if (!deltaNum) return wx.showToast({ title: '积分变动不能为 0', icon: 'none' })
    callFunction('admin', 'grantPoints', { openid, delta: deltaNum, reason })
      .then(() => {
        wx.showToast({ title: '已操作' })
        this.setData({ form: { openid: '', delta: '', reason: '' } })
        this.load()
      })
      .catch(showError)
  },

  sendRetroCardMail() {
    const form = this.data.retroMailForm
    const count = Math.round(Number(form.count || 0))
    if (!count) return wx.showToast({ title: '请填写补签卡数量', icon: 'none' })
    if (form.targetType === 'openid_list' && !String(form.openids || '').trim()) return wx.showToast({ title: '请填写用户 openid', icon: 'none' })
    if (form.targetType === 'member_level' && !form.targetLevelIds.length) return wx.showToast({ title: '请选择会员等级', icon: 'none' })
    callFunction('admin', 'publishRetroCardMail', { ...form, count })
      .then((res) => {
        wx.showToast({ title: `已发送 ${res.issued || 0} 封`, icon: 'none' })
        this.setData({
          retroMailForm: { targetType: 'openid_list', openids: '', role: 'client', targetLevelIds: [], count: '1', title: '补签卡奖励到账', content: '' },
          retroMailTargetIndex: 0,
          retroMailRoleIndex: 0,
          retroMailMemberLevels: buildRetroMailMemberLevels(this.data.memberLevels, [])
        })
      })
      .catch(showError)
  }
})
