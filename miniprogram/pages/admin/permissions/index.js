const { callFunction, showError } = require('../../../utils/cloud')

Page({
  data: {
    access: null, groups: [], members: [], filteredGroups: [], filteredMembers: [], tree: [],
    editor: null, selected: [], member: null, selectedGroups: [], groupOptions: [],
    busy: false, loading: true, error: '', tab: 'groups', targetOpenid: '', keyword: '', permissionKeyword: '',
    enabledCount: 0, permissionCount: 0, totalPermissions: 0, expanded: {}, memberLoading: false
  },
  async onShow() { if (!this.data.editor && !this.data.member) await this.load() },
  async all(action) {
    let cursor = '', rows = []
    const seen = new Set()
    do {
      const result = await callFunction('admin', action, { cursor })
      rows = rows.concat(result.list || [])
      cursor = result.hasMore ? result.cursor : ''
      if (cursor && seen.has(cursor)) throw new Error('列表加载异常，请重试')
      seen.add(cursor)
    } while (cursor)
    return rows
  },
  async load() {
    const version = (this._loadVersion || 0) + 1
    this._loadVersion = version
    this.setData({ loading: true, error: '' })
    try {
      const access = await callFunction('admin', 'getMyAdminAccess')
      const [groups, members] = access.superAdmin && access.enabled
        ? await Promise.all([this.all('listAdminGroups'), this.all('listAdminMembers')]) : [[], []]
      if (version !== this._loadVersion) return
      const decoratedGroups = groups.map(group => ({ ...group, permissions: group.permissions || [],
        summary: (access.tree || []).filter(node => node.children.some(child => (group.permissions || []).includes(child.id))).map(node => node.label).join(' · ') || '尚未分配业务权限'
      }))
      this.setData({ access, groups: decoratedGroups, members: members.map(member => ({ ...member,
        isOwner: member.openid === access.currentOpenid, initial: (member.nickname || '管').slice(0, 1)
      })), enabledCount: groups.filter(group => group.enabled).length,
        totalPermissions: (access.tree || []).reduce((sum, node) => sum + node.children.length, 0) })
      this.filterLists()
    } catch (error) {
      if (version === this._loadVersion) this.setData({ error: error.message || '暂时无法加载，请稍后重试', access: null, groups: [], members: [] })
    } finally { if (version === this._loadVersion) this.setData({ loading: false }) }
  },
  enable() {
    if (this.data.busy) return
    wx.showModal({ title: '启用用户组权限管理', content: '当前账号将成为超级管理员。其他现有管理员需分配用户组后，才能继续操作后台。', confirmColor: '#ed7845', success: async result => {
      if (!result.confirm || this.data.busy) return
      this.setData({ busy: true })
      try { await callFunction('admin', 'enableAdminPermissions'); await this.load() } catch (error) { showError(error) }
      finally { this.setData({ busy: false }) }
    } })
  },
  tab(e) {
    if (this.data.busy || this.data.memberLoading || this.data.editor || this.data.member) return
    this.setData({ tab: e.currentTarget.dataset.tab, keyword: '' }); this.filterLists()
  },
  search(e) { this.setData({ keyword: e.detail.value }); this.filterLists() },
  filterLists() {
    const keyword = this.data.keyword.trim().toLowerCase()
    this.setData({
      filteredGroups: this.data.groups.filter(group => !keyword || `${group.name} ${group.summary}`.toLowerCase().includes(keyword)),
      filteredMembers: this.data.members.filter(member => !keyword || `${member.nickname} ${member.openid}`.toLowerCase().includes(keyword))
    })
  },
  edit(e) {
    if (this.data.busy || !this.data.access || !this.data.access.superAdmin) return
    const group = this.data.groups.find(item => item._id === e.currentTarget.dataset.id)
    const editor = group ? { ...group } : { name: '', enabled: true, permissions: [], clientRequestId: `group_${Date.now()}_${Math.random().toString(36).slice(2)}` }
    this.setData({ editor, selected: [...editor.permissions], permissionKeyword: '', expanded: {}, member: null })
    this.paintTree()
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },
  paintTree() {
    const selected = this.data.selected
    const keyword = this.data.permissionKeyword.trim().toLowerCase()
    const tree = (this.data.access.tree || []).map(node => {
      const count = node.children.filter(child => selected.includes(child.id)).length
      const children = node.children.filter(child => !keyword || `${node.label} ${child.label}`.toLowerCase().includes(keyword))
        .map(child => ({ ...child, checked: selected.includes(child.id) }))
      return { ...node, children, count, total: node.children.length, checked: count === node.children.length,
        partial: count > 0 && count < node.children.length, expanded: !!keyword || !!this.data.expanded[node.id] }
    }).filter(node => node.children.length)
    this.setData({ tree, permissionCount: selected.length })
  },
  permissionSearch(e) { this.setData({ permissionKeyword: e.detail.value }); this.paintTree() },
  expand(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ [`expanded.${id}`]: !this.data.expanded[id] }); this.paintTree()
  },
  name(e) { if (!this.data.busy) this.setData({ 'editor.name': e.detail.value }) },
  enabled(e) { if (!this.data.busy) this.setData({ 'editor.enabled': e.detail.value }) },
  permissions(e) {
    if (this.data.busy) return
    const node = this.data.tree.find(item => item.id === e.currentTarget.dataset.id)
    if (!node) return
    const visible = new Set(node.children.map(child => child.id))
    const selected = this.data.selected.filter(id => !visible.has(id)).concat(e.detail.value.filter(id => visible.has(id)))
    this.setData({ selected: [...new Set(selected)] }); this.paintTree()
  },
  branch(e) {
    if (this.data.busy) return
    const node = (this.data.access.tree || []).find(item => item.id === e.currentTarget.dataset.id)
    if (!node) return
    const selected = new Set(this.data.selected)
    const checked = node.children.every(child => selected.has(child.id))
    for (const child of node.children) checked ? selected.delete(child.id) : selected.add(child.id)
    this.setData({ selected: [...selected] }); this.paintTree()
  },
  async save() {
    if (this.data.busy || !this.data.editor) return
    const editor = this.data.editor
    if (!editor.name.trim()) { wx.showToast({ title: '请填写用户组名称', icon: 'none' }); return }
    this.setData({ busy: true })
    try {
      await callFunction('admin', 'saveAdminGroup', { id: editor._id, clientRequestId: editor.clientRequestId, name: editor.name.trim(), enabled: editor.enabled, revision: editor.revision, permissions: this.data.selected })
      this.setData({ editor: null }); await this.load(); wx.showToast({ title: '用户组已保存' })
    } catch (error) { showError(error) } finally { this.setData({ busy: false }) }
  },
  inputTarget(e) { this.setData({ targetOpenid: e.detail.value }) },
  async editMember(e) {
    if (this.data.busy || this.data.memberLoading) return
    const openid = e.currentTarget.dataset.openid || this.data.targetOpenid.trim()
    if (!openid) { wx.showToast({ title: '请输入已注册用户的 OpenID', icon: 'none' }); return }
    this.setData({ memberLoading: true })
    try {
      const member = await callFunction('admin', 'getAdminMembership', { openid })
      const selectedGroups = (member.groupIds || []).filter(id => this.data.groups.some(group => group._id === id && group.enabled))
      this.setData({ member, selectedGroups, groupOptions: this.data.groups.filter(group => group.enabled).map(group => ({ ...group, checked: selectedGroups.includes(group._id) })),
        inactiveGroupCount: (member.groupIds || []).length - selectedGroups.length })
      wx.pageScrollTo({ scrollTop: 0, duration: 200 })
    } catch (error) { showError(error) } finally { this.setData({ memberLoading: false }) }
  },
  groupsChanged(e) {
    if (this.data.busy) return
    const selectedGroups = e.detail.value
    this.setData({ selectedGroups, groupOptions: this.data.groupOptions.map(group => ({ ...group, checked: selectedGroups.includes(group._id) })) })
  },
  async saveMember() {
    if (this.data.busy || !this.data.member) return
    if (this.data.selectedGroups.length > 10) { wx.showToast({ title: '最多分配 10 个用户组', icon: 'none' }); return }
    this.setData({ busy: true })
    try {
      await callFunction('admin', 'setAdminMembership', { openid: this.data.member.openid, revision: this.data.member.revision, groupIds: this.data.selectedGroups })
      this.setData({ member: null, targetOpenid: '' }); await this.load(); wx.showToast({ title: '人员权限已保存' })
    } catch (error) { showError(error) } finally { this.setData({ busy: false }) }
  },
  cancel() { if (!this.data.busy) this.setData({ editor: null, member: null }) },
  openLogs() { wx.navigateTo({ url: '/pages/admin/operation-logs/index' }) }
})
