const crypto = require('crypto')
const world = require('../config/memorial-world.json')
const { readOptionalDocument, readDocuments } = require('../utils/documentPages')
const hash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)
const text = value => String(value || '').normalize('NFKC').trim()
module.exports = function createHandler(context) {
  const { db, now, getUser, requireAdmin, checkRateLimit, checkTextSecurity } = context
  const read = (store, id) => readOptionalDocument(store, 'platform_configs', id)
  const write = (store, id, data) => store.collection('platform_configs').doc(id).set({ data })
  return async function memorial(openid, action, data = {}) {
    const user = await getUser(openid)
    const admin = ['listAdmin', 'review'].includes(action) ? await requireAdmin(openid) : null
    await checkRateLimit(openid, 'memorial.' + action, { max: action === 'submit' ? 5 : 60, windowMs: action === 'submit' ? 3600000 : 60000 })
    if (action === 'world') {
      const plots = await readDocuments(db, db.command, 'platform_configs', { key: 'memorial_plot' }, 500)
      return { version: world.version, occupied: plots.filter(p => p.status !== 'released').map(p => p.plotId),
        memorials: plots.filter(p => p.status === 'approved').map(p => ({ id: p.plotId, x: p.x, y: p.y, name: p.petName, epitaph: p.epitaph, date: p.date })) }
    }
    if (action === 'listMine' || action === 'listAdmin') {
      const where = { key: 'memorial_application' }
      if (!admin) where.ownerOpenid = openid
      else if (['pending', 'approved', 'rejected'].includes(data.status)) where.status = data.status
      if (data.pendingCountsOnly && admin) return { pendingCount: (await db.collection('platform_configs').where({ key: 'memorial_application', status: 'pending' }).count()).total }
      const cursor = text(data.cursor)
      const result = await db.collection('platform_configs').where({ ...where, ...(cursor ? { _id: db.command.gt(cursor) } : {}) }).orderBy('_id', 'asc').limit(31).get()
      const rows = (result.data || []).slice(0, 30).map(({ _id, petName, epitaph, date, plotId, lawn, status, reason, createdAt, applicant }) => ({ _id, petName, epitaph, date, plotId, lawn, status, reason, createdAt, ...(admin ? { applicant } : {}) }))
      return { list: rows, cursor: rows.length ? rows[rows.length - 1]._id : '', hasMore: (result.data || []).length > 30 }
    }
    if (action === 'submit') {
      const petName = text(data.petName), epitaph = text(data.epitaph), date = text(data.date), requestId = text(data.requestId)
      const plot = world.cells.find(p => p.id === data.plotId)
      if (!plot || data.version !== world.version) throw new Error('墓位数据已变化，请重新选择')
      if (!petName || petName.length > 20 || !epitaph || epitaph.length > 120) throw new Error('请填写宠物名字（20字以内）和寄语（120字以内）')
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > today) throw new Error('请选择有效的纪念日期，不可晚于今天')
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) throw new Error('提交编号无效，请重试')
      await checkTextSecurity(openid, petName + ' ' + epitaph, { scene: 1, label: '纪念碑申请' })
      const id = 'memorial_app_' + hash(openid + '|' + requestId), plotKey = 'memorial_plot_' + hash(plot.id)
      const ownerKey = 'memorial_pet_' + hash(openid + '|' + petName.toLowerCase())
      const fingerprint = hash(JSON.stringify([plot.id, petName, epitaph, date]))
      return db.runTransaction(async tx => {
        const existing = await read(tx, id)
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new Error('提交内容已改变，请重新打开申请')
          return { id, status: existing.status }
        }
        const occupied = await read(tx, plotKey), owner = await read(tx, ownerKey)
        if (occupied && occupied.status !== 'released') throw new Error('这个墓位刚被选走，请选择其他位置')
        if (owner && owner.status !== 'rejected') throw new Error('该宠物已有待审核或已建立的纪念碑，请查看我的申请')
        const stamp = now()
        await write(tx, id, { key: 'memorial_application', ownerOpenid: openid, ownerKey, plotKey, plotId: plot.id, lawn: plot.lawn,
          x: plot.x, y: plot.y, petName, epitaph, date, fingerprint, applicant: user.nickname || '用户', status: 'pending', reason: '', createdAt: stamp, updatedAt: stamp })
        await write(tx, plotKey, { key: 'memorial_plot', plotId: plot.id, applicationId: id, status: 'pending', x: plot.x, y: plot.y, updatedAt: stamp })
        await write(tx, ownerKey, { key: 'memorial_pet', applicationId: id, status: 'pending' })
        await context.enqueueAdminAuditNotification(tx, { auditType: 'memorial_application', targetId: id, applicant: user.nickname || '用户',
          type: '纪念碑申请', reason: petName + ' · ' + plot.lawn, page: 'pages/admin/memorial/index' })
        return { id, status: 'pending' }
      })
    }
    if (action === 'review') {
      const id = text(data.id), status = data.status, reason = text(data.reason)
      if (!/^memorial_app_[a-f0-9]{32}$/.test(id) || !['approved', 'rejected'].includes(status)) throw new Error('审核参数无效')
      if (reason.length > 200 || (status === 'rejected' && !reason)) throw new Error('请填写驳回原因（200字以内）')
      if (reason) await checkTextSecurity(openid, reason, { scene: 2, label: '纪念碑审核原因' })
      return db.runTransaction(async tx => {
        const row = await read(tx, id)
        if (!row || row.key !== 'memorial_application') throw new Error('申请不存在')
        if (row.status === status && row.reason === reason) return { id, status }
        if (row.status !== 'pending') throw new Error('申请已被处理，请刷新')
        const plot = await read(tx, row.plotKey)
        if (!plot || plot.applicationId !== id || plot.status !== 'pending') throw new Error('墓位状态已变化，请刷新核对')
        const stamp = now()
        await tx.collection('platform_configs').doc(id).update({ data: { status, reason, reviewedBy: openid, updatedAt: stamp } })
        await write(tx, row.ownerKey, { key: 'memorial_pet', applicationId: id, status })
        const { _id: ignoredId, ...plotData } = plot
        await write(tx, row.plotKey, { ...plotData, status: status === 'approved' ? 'approved' : 'released',
          ...(status === 'approved' ? { petName: row.petName, epitaph: row.epitaph, date: row.date } : {}), updatedAt: stamp })
        const noticeId = 'admin_audit_memorial_application_' + id
        if (await readOptionalDocument(tx, 'admin_notifications', noticeId)) {
          await tx.collection('admin_notifications').doc(noticeId).update({ data: { resolved: true, resolvedAt: stamp, updatedAt: stamp } })
        }
        const time = stamp instanceof Date ? stamp.toISOString() : String(stamp)
        await tx.collection('system_notifications').doc('memorial_result_' + hash(id)).set({ data: {
          title: status === 'approved' ? '纪念碑申请已通过' : '纪念碑申请未通过',
          content: status === 'approved' ? `“${row.petName}”的纪念碑已在${row.lawn}建立，可进入纪念园查看。` : `“${row.petName}”的申请未通过：${reason}。可修改后重新申请。`,
          target: 'client', targetOpenid: row.ownerOpenid, targetOpenids: [], type: 'notice', status: 'active', level: 'normal',
          targetUrl: '/packageMemorial/pages/garden', idempotencyKey: 'memorial_result:' + id,
          senderAdminId: admin._id || '', senderAdminOpenid: openid, senderAdminName: admin.name || '管理员', createdAt: time, updatedAt: time
        } })
        return { id, status }
      })
    }
    throw new Error('未知纪念园操作')
  }
}
