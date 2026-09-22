const { callFunction, showError } = require('../../../utils/cloud')
const { formatDateTime } = require('../../../utils/format')
const statuses = { started: '结果待核实', succeeded: '成功', failed: '失败', denied: '无权限' }
Page({
  data: { actors: [{ label: '全部人员', openid: '' }], actorIndex: 0, actorOpenid: '', status: '', action: '', rows: [], page: 1, hasMore: false, loading: false,
    statusOptions: ['全部结果', '成功', '失败', '无权限', '结果待核实'], statusIndex: 0 },
  async onShow() {
    try {
      const access = this.data.adminAccess
      this.names = {}
      for (const branch of access?.tree || []) for (const leaf of branch.children) this.names[leaf.id] = `${branch.label} / ${leaf.label}`
      if (access?.superAdmin || access?.permissions.includes('admin.listOperationActors')) {
        let cursor = '', actors = [{ label: '全部人员', openid: '' }]
        do {
          const result = await callFunction('admin', 'listOperationActors', { cursor })
          actors = actors.concat(result.list.map(user => ({ label: `${user.nickname || '未设置昵称'} (${user.openid})`, openid: user.openid })))
          cursor = result.hasMore ? result.cursor : ''
        } while (cursor)
        this.setData({ actors })
      }
      await this.load(true)
    } catch (error) { showError(error) }
  },
  actor(e) { const index = Number(e.detail.value); this.setData({ actorIndex: index, actorOpenid: this.data.actors[index].openid }); this.load(true) },
  actorInput(e) { this.setData({ actorOpenid: e.detail.value }) },
  status(e) { const index = Number(e.detail.value); this.setData({ statusIndex: index, status: ['', 'succeeded', 'failed', 'denied', 'started'][index] }); this.load(true) },
  action(e) { this.setData({ action: e.detail.value }) },
  search() { this.load(true) },
  async load(reset = false) {
    if (this.data.loading) return
    const page = reset ? 1 : this.data.page + 1
    this.setData({ loading: true })
    try {
      const result = await callFunction('admin', 'listOperationLogs', { page, actorOpenid: this.data.actorOpenid.trim(), status: this.data.status, action: this.data.action.trim() })
      const rows = result.list.map(row => ({ ...row, timeText: formatDateTime(row.createdAt), resultText: statuses[row.status] || row.status,
        actionText: this.names[row.permission] || `${row.module}.${row.action}`, targetText: Object.values(row.target || {}).join(' · ') }))
      this.setData({ rows: reset ? rows : this.data.rows.concat(rows), page, hasMore: result.hasMore })
    } catch (error) { showError(error) } finally { this.setData({ loading: false }) }
  },
  onReachBottom() { if (this.data.hasMore) this.load() }
})
