const { callFunction, showError } = require('../../../utils/cloud')

Page({
  data: { access: null, groups: [], members: [], tree: [], editor: null, selected: [], member: null, selectedGroups: [], busy: false, tab: 'groups', targetOpenid: '' },
  async onShow() { await this.load() },
  async all(action) {
    let cursor = '', rows = []
    do {
      const result = await callFunction('admin', action, { cursor })
      rows = rows.concat(result.list)
      cursor = result.hasMore ? result.cursor : ''
    } while (cursor)
    return rows
  },
  async load() {
    try {
      const access = await callFunction('admin', 'getMyAdminAccess')
      this.setData({ access })
      if (!access.superAdmin) return
      const groups = await this.all('listAdminGroups')
      const members = await this.all('listAdminMembers')
      this.setData({ groups, members })
    } catch (error) { showError(error) }
  },
  enable() {
    wx.showModal({ title: '启用最小权限管理', content: '当前账号将成为超级管理员。其他现有管理员的后台权限将暂停，需分配用户组后恢复。', success: async result => {
      if (!result.confirm || this.data.busy) return
      this.setData({ busy: true })
      try { await callFunction('admin', 'enableAdminPermissions'); await this.load() } catch (error) { showError(error) }
      finally { this.setData({ busy: false }) }
    } })
  },
  tab(e) { this.setData({ tab: e.currentTarget.dataset.tab, editor: null, member: null }) },
  edit(e) {
    const group = this.data.groups.find(item => item._id === e.currentTarget.dataset.id)
    const editor = group ? { ...group } : { name: '', enabled: true, permissions: [] }
    this.setData({ editor, selected: editor.permissions })
    this.paintTree()
  },
  paintTree() {
    const selected = this.data.selected
    const tree = (this.data.access.tree || []).map(node => ({ ...node,
      checked: node.children.every(child => selected.includes(child.id)),
      children: node.children.map(child => ({ ...child, checked: selected.includes(child.id) }))
    }))
    this.setData({ tree })
  },
  name(e) { this.setData({ 'editor.name': e.detail.value }) },
  enabled(e) { this.setData({ 'editor.enabled': e.detail.value }) },
  permissions(e) {
    const node = this.data.tree.find(item => item.id === e.currentTarget.dataset.id)
    const selected = this.data.selected.filter(id => !node.children.some(child => child.id === id)).concat(e.detail.value)
    this.setData({ selected }); this.paintTree()
  },
  branch(e) {
    const node = this.data.tree.find(item => item.id === e.currentTarget.dataset.id)
    const selected = new Set(this.data.selected)
    for (const child of node.children) node.checked ? selected.delete(child.id) : selected.add(child.id)
    this.setData({ selected: [...selected] }); this.paintTree()
  },
  async save() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      const editor = this.data.editor
      await callFunction('admin', 'saveAdminGroup', { id: editor._id, name: editor.name, enabled: editor.enabled, revision: editor.revision, permissions: this.data.selected })
      this.setData({ editor: null }); await this.load(); wx.showToast({ title: '用户组已保存' })
    } catch (error) { showError(error) } finally { this.setData({ busy: false }) }
  },
  inputTarget(e) { this.setData({ targetOpenid: e.detail.value }) },
  async editMember(e) {
    const openid = e.currentTarget.dataset.openid || this.data.targetOpenid.trim()
    if (!openid) return
    try {
      const member = await callFunction('admin', 'getAdminMembership', { openid })
      this.setData({ member, selectedGroups: member.groupIds, groupOptions: this.data.groups.filter(group => group.enabled).map(group => ({ ...group, checked: member.groupIds.includes(group._id) })) })
    } catch (error) { showError(error) }
  },
  groupsChanged(e) { this.setData({ selectedGroups: e.detail.value }) },
  async saveMember() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      await callFunction('admin', 'setAdminMembership', { openid: this.data.member.openid, revision: this.data.member.revision, groupIds: this.data.selectedGroups })
      this.setData({ member: null }); await this.load(); wx.showToast({ title: '人员权限已保存' })
    } catch (error) { showError(error) } finally { this.setData({ busy: false }) }
  },
  cancel() { this.setData({ editor: null, member: null }) }
})
