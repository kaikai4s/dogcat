const crypto = require('crypto')
const world = require('../config/memorial-world.json')
const plotLayout = require('../config/memorial-plots.json')
const nearby = (a, b) => Math.abs(a.x - b.x) < plotLayout.spacing && Math.abs(a.y - b.y) < plotLayout.spacing
const { readOptionalDocument } = require('../utils/documentPages')
const { DEFAULT, gardenId } = require('../services/memorialGardens')
const hash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)
const text = value => String(value || '').normalize('NFKC').trim()
module.exports = function createHandler(context) {
  const { db, now, getUser, requireAdmin, checkRateLimit, checkTextSecurity } = context
  const gardens = require('../services/memorialGardens')(context)
  const presence = require('../services/memorialPresence')(context)
  const portrait = require('../services/memorialPortrait')(context)
  const memory = require('../services/memorialMemory')(context)
  const read = (store, id) => readOptionalDocument(store, 'platform_configs', id)
  const write = (store, id, data) => store.collection('platform_configs').doc(id).set({ data })
  return async function memorial(openid, action, data = {}) {
    if (['joinPresence', 'syncPresence', 'leavePresence'].includes(action)) return presence.handle(openid, action, data)
    const user = await getUser(openid)
    const admin = ['listAdmin', 'review', 'listMemoriesAdmin', 'reviewMemory', 'listPortraitsAdmin', 'preparePortraitAsset', 'reviewPortrait', 'listGardensAdmin', 'createGarden', 'updateGarden', 'listUserMemorialsAdmin', 'getMemorialAdmin'].includes(action) ? await requireAdmin(openid) : null
    await checkRateLimit(openid, 'memorial.' + action, { max: action === 'submit' ? 5 : 60, windowMs: action === 'submit' ? 3600000 : 60000 })
    if (['listGardens', 'listGardensAdmin', 'createGarden', 'updateGarden'].includes(action)) return gardens.handle(openid, action, data)
    if (action === 'getMemorialAdmin') return memory(openid, action, data, user)
    if (['portraitDetail', 'submitPortrait', 'listPortraitsAdmin', 'preparePortraitAsset', 'reviewPortrait'].includes(action)) return portrait(openid, action, data, user)
    if (['detail', 'entrance', 'prepareMedia', 'finishMedia', 'saveMemory', 'updateMemoryMedia', 'listMemoriesAdmin', 'reviewMemory'].includes(action)) return memory(openid, action, data, user)
    if (action === 'world') {
      const garden = await gardens.get(data.gardenId || DEFAULT)
      const plots = await gardens.plots(garden._id)
      const publicPlots = plots.filter(p => p.status === 'approved')
      const assets = publicPlots.filter(p => p.portrait && p.portrait.fileId)
      const urls = new Map()
      const fileIds = [...new Set(assets.map(p => p.portrait.fileId))]
      for (let i = 0; i < fileIds.length; i += 50) {
        const signed = await context.cloud.getTempFileURL({ fileList: fileIds.slice(i, i + 50).map(fileID => ({ fileID, maxAge: 3600 })) })
        for (const f of signed.fileList || []) urls.set(f.fileID, f.tempFileURL || '')
      }
      return { serverTime: (context.nowMs || Date.now)(), version: world.version, garden: gardens.publicRow(garden), occupied: [...new Set(plots.filter(p => p.status !== 'released').flatMap(p => [p.plotId, ...world.cells.filter(c => nearby(c, p)).map(c => c.id)]))],
        memorials: plots.filter(p => p.status === 'approved').map(p => ({ id: p.plotId, applicationId: p.applicationId, style: p.style || 'arch', legacy: p.footprint !== 2, x: p.x, y: p.y, name: p.petName, epitaph: p.epitaph, date: p.date, ...(p.portrait ? { portrait: { id: p.portrait.uploadId, ...(p.portrait.layoutVersion === 1 ? { layoutVersion: 1, width: p.portrait.width, height: p.portrait.height, bounds: p.portrait.bounds, scale: p.portrait.scale } : {}), url: urls.get(p.portrait.fileId) || '' } } : {}) })) }
    }
    if (['listMine', 'listAdmin', 'listUserMemorialsAdmin'].includes(action)) {
      const where = { key: 'memorial_application' }
      if (action === 'listUserMemorialsAdmin') {
        if (typeof data.openid !== 'string' || !data.openid.trim()) throw new Error('请选择用户')
        where.ownerOpenid = data.openid.trim()
      } else if (!admin) where.ownerOpenid = openid
      else if (['pending', 'approved', 'rejected'].includes(data.status)) where.status = data.status
      if (data.pendingCountsOnly && admin) return { pendingCount: (await db.collection('platform_configs').where({ key: 'memorial_application', status: 'pending' }).count()).total }
      const cursor = text(data.cursor)
      const result = await db.collection('platform_configs').where({ ...where, ...(cursor ? { _id: db.command.gt(cursor) } : {}) }).orderBy('_id', 'asc').limit(31).get()
      const rows = await gardens.labelRows((result.data || []).slice(0, 30).map(row => ({
        style: row.style || 'arch', _id: row._id, petName: row.petName, epitaph: row.epitaph, date: row.date,
        plotId: row.plotId, lawn: row.lawn, x: row.x, y: row.y, gardenId: gardenId(row), status: row.status,
        reason: row.reason, createdAt: row.createdAt, reviewedAt: row.reviewedAt || (row.status !== 'pending' ? row.updatedAt : ''),
        ...(admin ? { applicant: row.applicant, ownerOpenid: row.ownerOpenid } : {})
      })))
      return { list: rows, cursor: rows.length ? rows[rows.length - 1]._id : '', hasMore: (result.data || []).length > 30 }
    }
    if (action === 'submit') {
      const garden = await gardens.get(data.gardenId || DEFAULT)
      const scope = garden._id === DEFAULT ? '' : garden._id + '|'
      const petName = text(data.petName), epitaph = text(data.epitaph), date = text(data.date), requestId = text(data.requestId)
      const style = data.style || 'arch'
      if (!['arch', 'cottage', 'moon'].includes(style)) throw new Error('请选择有效的小筑样式')
      const plot = world.cells.find(p => p.id === data.plotId)
      if (!plot || data.version !== world.version) throw new Error('位置数据已变化，请重新选择')
      if (!petName || petName.length > 20 || !epitaph || epitaph.length > 120) throw new Error('请填写宠物名字（20字以内）和寄语（120字以内）')
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > today) throw new Error('请选择有效的纪念日期，不可晚于今天')
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) throw new Error('提交编号无效，请重试')
      await checkTextSecurity(openid, petName + ' ' + epitaph, { scene: 1, label: '时光小筑申请' })
      const id = 'memorial_app_' + hash(scope + openid + '|' + requestId), plotKey = 'memorial_plot_' + hash(scope + plot.id)
      const ownerKey = 'memorial_pet_' + hash(openid + '|' + petName.toLowerCase())
      const fingerprint = hash(JSON.stringify([plot.id, petName, epitaph, date, style]))
      return db.runTransaction(async tx => {
        const existing = await read(tx, id)
        if (existing) {
          if (existing.fingerprint !== fingerprint && !(style === 'arch' && !existing.style && existing.fingerprint === hash(JSON.stringify([plot.id, petName, epitaph, date])))) throw new Error('提交内容已改变，请重新打开申请')
          return { id, status: existing.status }
        }
        const currentGarden = await gardens.get(garden._id, tx)
        if (!currentGarden.accepting) throw new Error('这个纪念园已暂停接收新申请，请选择其他园区')
        if (!plotLayout.ids.includes(plot.id)) throw new Error('这个位置没有足够的陪伴空间，请重新选择绿色空位')
        // A shared revision prevents write skew between overlapping new claims.
        const layoutLock = 'memorial_layout_lock' + (scope ? '_' + garden._id : '')
        const lock = await read(tx, layoutLock)
        const occupied = await read(tx, plotKey), owner = await read(tx, ownerKey)
        if (occupied && occupied.status !== 'released') throw new Error('这个位置刚被选走，请选择其他位置')
        if (owner && owner.status !== 'rejected') throw new Error('该宠物已有待审核或已安放的时光小筑，请查看我的申请')
        for (const neighbour of world.cells.filter(p => p.id !== plot.id && nearby(p, plot))) {
          const claim = await read(tx, 'memorial_plot_' + hash(scope + neighbour.id))
          if (claim && claim.status !== 'released') throw new Error('附近小筑需要保留陪伴空间，请选择其他位置')
        }
        await write(tx, layoutLock, { key: 'memorial_layout_lock', revision: (lock && lock.revision || 0) + 1 })
        await presence.changed(tx, garden._id)
        const stamp = now()
        await write(tx, id, { key: 'memorial_application', gardenId: garden._id, ownerOpenid: openid, ownerKey, plotKey, plotId: plot.id, lawn: plot.lawn,
          x: plot.x, y: plot.y, style, petName, epitaph, date, fingerprint, applicant: user.nickname || '用户', status: 'pending', reason: '', createdAt: stamp, updatedAt: stamp })
        await write(tx, plotKey, { key: 'memorial_plot', gardenId: garden._id, footprint: 2, plotId: plot.id, applicationId: id, status: 'pending', x: plot.x, y: plot.y, updatedAt: stamp })
        await write(tx, ownerKey, { key: 'memorial_pet', applicationId: id, status: 'pending' })
        await context.enqueueAdminAuditNotification(tx, { auditType: 'memorial_application', targetId: id, applicant: user.nickname || '用户',
          type: '时光小筑申请', reason: petName + ' · ' + plot.lawn, page: 'pages/admin/memorial/index' })
        return { id, status: 'pending' }
      })
    }
    if (action === 'review') {
      const id = text(data.id), status = data.status, reason = text(data.reason)
      if (!/^memorial_app_[a-f0-9]{32}$/.test(id) || !['approved', 'rejected'].includes(status)) throw new Error('审核参数无效')
      if (reason.length > 200 || (status === 'rejected' && !reason)) throw new Error('请填写驳回原因（200字以内）')
      if (reason) await checkTextSecurity(openid, reason, { scene: 2, label: '时光小筑审核原因' })
      return db.runTransaction(async tx => {
        const row = await read(tx, id)
        if (!row || row.key !== 'memorial_application') throw new Error('申请不存在')
        if (row.status === status && row.reason === reason) return { id, status }
        if (row.status !== 'pending') throw new Error('申请已被处理，请刷新')
        const plot = await read(tx, row.plotKey)
        if (!plot || plot.applicationId !== id || plot.status !== 'pending') throw new Error('位置状态已变化，请刷新核对')
        await presence.changed(tx, gardenId(row))
        const stamp = now()
        await tx.collection('platform_configs').doc(id).update({ data: { status, reason, reviewedBy: openid, reviewedAt: stamp, updatedAt: stamp } })
        await write(tx, row.ownerKey, { key: 'memorial_pet', applicationId: id, status })
        const { _id: ignoredId, ...plotData } = plot
        await write(tx, row.plotKey, { ...plotData, status: status === 'approved' ? 'approved' : 'released',
          ...(status === 'approved' ? { style: row.style || 'arch', petName: row.petName, epitaph: row.epitaph, date: row.date } : {}), updatedAt: stamp })
        const noticeId = 'admin_audit_memorial_application_' + id
        if (await readOptionalDocument(tx, 'admin_notifications', noticeId)) {
          await tx.collection('admin_notifications').doc(noticeId).update({ data: { resolved: true, resolvedAt: stamp, updatedAt: stamp } })
        }
        const time = stamp instanceof Date ? stamp.toISOString() : String(stamp)
        await tx.collection('system_notifications').doc('memorial_result_' + hash(id)).set({ data: {
          title: status === 'approved' ? '时光小筑申请已通过' : '时光小筑申请未通过',
          content: status === 'approved' ? `“${row.petName}”的时光小筑已在${row.lawn}建立，可进入纪念园查看。` : `“${row.petName}”的申请未通过：${reason}。可修改后重新申请。`,
          target: 'client', targetOpenid: row.ownerOpenid, targetOpenids: [], type: 'notice', status: 'active', level: 'normal',
          targetUrl: '/packageMemorial/pages/garden?gardenId=' + encodeURIComponent(gardenId(row)) + '&plotId=' + encodeURIComponent(row.plotId), idempotencyKey: 'memorial_result:' + id,
          senderAdminId: admin._id || '', senderAdminOpenid: openid, senderAdminName: admin.name || '管理员', createdAt: time, updatedAt: time
        } })
        return { id, status }
      })
    }
    throw new Error('未知纪念园操作')
  }
}
