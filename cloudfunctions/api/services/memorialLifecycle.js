const crypto = require('crypto')
const { readOptionalDocument } = require('../utils/documentPages')
const { DEFAULT, gardenId } = require('./memorialGardens')
const world = require('../config/memorial-world.json')
const layout = require('../config/memorial-plots.json')
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)
const scope = id => id === DEFAULT ? '' : id + '|'
const plotKey = (garden, plot) => 'memorial_plot_' + hash(scope(garden) + plot)
const clean = row => { const { _id, ...data } = row; return data }
const filesIn = value => {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) =>
    ['fileId', 'sourceFileId', 'textFileId'].includes(key) && typeof child === 'string' && child.startsWith('cloud://') ? [child] : filesIn(child))
}
module.exports = context => {
  const { db, now, cloud } = context
  const gardens = require('./memorialGardens')(context), presence = require('./memorialPresence')(context)
  const read = (store, id) => readOptionalDocument(store, 'platform_configs', id)
  const put = (store, id, data) => store.collection('platform_configs').doc(id).set({ data })
  const clock = () => (context.nowMs || Date.now)()
  const recoveryPlotId = id => 'memorial_recovery_plot_' + hash(id)
  const response = app => ({ id: app._id, status: app.status, locationRevision: app.locationRevision || 0, gardenId: gardenId(app), plotId: app.plotId, ...(app.recoverUntil ? { recoverUntil: app.recoverUntil } : {}) })
  const recycleRow = app => ({ ...response(app), petName: app.petName, style: app.style || 'arch', lawn: app.lawn, owner: true, recoverUntil: app.recoverUntil, demolishedAt: app.demolishedAt })
  async function handle(openid, action, data) {
    if (action === 'listRecycle') {
      const result = await db.collection('platform_configs').where({ key: 'memorial_recycle', ownerOpenid: openid, recoverUntil: db.command.gt(clock()), ...(data.cursor ? { _id: db.command.gt(String(data.cursor)) } : {}) }).orderBy('_id', 'asc').limit(31).get()
      const rows = (result.data || []).slice(0, 30)
      return { list: await gardens.labelRows(rows.map(recycleRow)), hasMore: (result.data || []).length > 30, cursor: rows.length ? rows[rows.length - 1]._id : '', serverTime: clock() }
    }
    if (action === 'recycleDetail') {
      const app = await read(db, String(data.id || ''))
      if (!app || app.ownerOpenid !== openid || app.key !== 'memorial_recycle' || app.recoverUntil <= clock()) throw new Error('小筑不在恢复期内，请刷新回收站')
      const garden = await gardens.get(gardenId(app))
      return { ...recycleRow(app), gardenName: garden.name, serverTime: clock() }
    }
    if (!/^memorial_app_[a-f0-9]{32}$/.test(data.id || '') || !Number.isSafeInteger(data.locationRevision) || data.locationRevision < 0 || !/^[A-Za-z0-9_-]{8,80}$/.test(data.requestId || '')) throw new Error('操作信息无效，请重新打开小筑')
    if (action === 'demolish' && data.confirm !== true) throw new Error('请确认拆除及 7 天恢复期限')
    const restoring = action === 'restore'
    if (restoring && data.original !== undefined && typeof data.original !== 'boolean') throw new Error('恢复位置参数无效')
    const selecting = action === 'relocate' || restoring && !data.original
    let target = selecting ? world.cells.find(p => p.id === data.plotId) : null
    if (selecting && (!target || !layout.ids.includes(target.id) || data.version !== world.version || !['arch', 'cottage', 'moon'].includes(data.style))) throw new Error('请选择有效的位置和小筑样式')
    let destination = selecting ? await gardens.get(data.gardenId || DEFAULT) : null
    const fingerprint = hash(JSON.stringify([action, data.locationRevision, destination && destination._id, data.plotId || '', data.style || '', data.original === true, data.confirmName || '']))
    return db.runTransaction(async tx => {
      const app = await read(tx, data.id)
      if (!app || !['memorial_application', 'memorial_recycle', 'memorial_demolished'].includes(app.key) || app.ownerOpenid !== openid) throw new Error('只有主人可以管理这处时光小筑')
      if (app.lastOperation === data.requestId) {
        if (app.operationFingerprint !== fingerprint) throw new Error('操作内容已改变，请重新打开小筑')
        return response(app)
      }
      if (restoring) {
        if (app.key !== 'memorial_recycle' || app.recoverUntil <= clock()) throw new Error('已超过 7 天恢复期或小筑已恢复，请刷新')
        if (data.original) {
          target = world.cells.find(p => p.id === app.plotId)
          if (!target) throw new Error('原位置已不可用，请重新选址恢复')
          destination = await gardens.get(gardenId(app), tx)
        }
      } else if (app.status !== 'approved') throw new Error('这处小筑已拆除或尚未安放，请刷新')
      if ((app.locationRevision || 0) !== data.locationRevision) throw new Error('小筑位置已更新，请重新打开后操作')
      if (action === 'demolish' && String(data.confirmName || '').normalize('NFKC').trim() !== app.petName) throw new Error('宠物名字不匹配，请输入完整名字确认拆除')
      const source = await read(tx, restoring ? recoveryPlotId(app._id) : app.plotKey)
      if (!source || source.status !== 'approved' || source.applicationId !== app._id) throw new Error('小筑位置状态已变化，请刷新')
      const origin = gardenId(app), targetGarden = destination ? destination._id : origin
      const stamp = now(), revision = (app.locationRevision || 0) + 1
      const metadata = { locationRevision: revision, lastOperation: data.requestId, operationFingerprint: fingerprint, updatedAt: stamp }
      // Use the same garden locks as new applications, including adjacent plots.
      for (const id of [...new Set([origin, targetGarden])].sort()) {
        const lockId = 'memorial_layout_lock' + (id === DEFAULT ? '' : '_' + id), lock = await read(tx, lockId)
        await put(tx, lockId, { key: 'memorial_layout_lock', revision: (lock && lock.revision || 0) + 1 })
      }
      const memoryId = 'memorial_memory_' + hash(app._id), portraitId = 'memorial_portrait_' + hash(app._id)
      const memory = await read(tx, memoryId), portrait = await read(tx, portraitId)
      if (action === 'relocate' || restoring) {
        const garden = await gardens.get(targetGarden, tx)
        if (!garden.accepting) throw new Error('这个纪念园已暂停接收小筑，请选择其他园区')
        for (const cell of world.cells.filter(p => Math.abs(p.x - target.x) < layout.spacing && Math.abs(p.y - target.y) < layout.spacing)) {
          const claim = await read(tx, plotKey(targetGarden, cell.id))
          if (claim && claim.status !== 'released' && claim.applicationId !== app._id) throw new Error('这个位置或相邻位置已被占用，请重新选择')
        }
        if (restoring && app.ownerKey) {
          const owner = await read(tx, app.ownerKey)
          if (owner && owner.applicationId !== app._id && owner.status !== 'rejected') throw new Error('同名宠物已有其他小筑，请先处理后再恢复')
        }
        const location = { gardenId: targetGarden, plotKey: plotKey(targetGarden, target.id), plotId: target.id, lawn: target.lawn, x: target.x, y: target.y }
        if (!restoring && location.plotKey !== app.plotKey) await put(tx, app.plotKey, { key: 'memorial_plot', gardenId: origin, plotId: app.plotId, status: 'released', updatedAt: stamp })
        await put(tx, location.plotKey, { ...clean(source), ...location, key: 'memorial_plot', style: data.original ? app.style || 'arch' : data.style, footprint: data.original ? source.footprint || 1 : 2, updatedAt: stamp })
        const { recoverUntil, demolishedAt, ...appData } = clean(app)
        await put(tx, app._id, { ...appData, ...location, ...metadata, key: 'memorial_application', status: 'approved', style: data.original ? app.style || 'arch' : data.style })
        for (const row of [memory, portrait].filter(Boolean)) {
          await tx.collection('platform_configs').doc(row._id).update({ data: { ...location, key: row._id === memoryId ? 'memorial_memory' : 'memorial_portrait' } })
          if (restoring && row.status === 'pending') {
            const notice = 'admin_audit_' + (row._id === memoryId ? 'memorial_memory' : 'memorial_portrait') + '_' + row._id + ':' + row.revision
            if (await readOptionalDocument(tx, 'admin_notifications', notice)) await tx.collection('admin_notifications').doc(notice).update({ data: { resolved: false, updatedAt: stamp } })
          }
        }
        if (restoring) {
          if (app.ownerKey) await put(tx, app.ownerKey, { key: 'memorial_pet', applicationId: app._id, status: 'approved' })
          await tx.collection('platform_configs').doc(recoveryPlotId(app._id)).remove()
          await tx.collection('platform_configs').doc('memorial_cleanup_' + hash(app._id)).remove()
        }
        for (const id of [...new Set([origin, targetGarden])]) await presence.changed(tx, id)
        return { id: app._id, status: 'approved', locationRevision: revision, gardenId: targetGarden, plotId: target.id }
      }
      await put(tx, app.plotKey, { key: 'memorial_plot', gardenId: origin, plotId: app.plotId, status: 'released', updatedAt: stamp })
      const owner = app.ownerKey && await read(tx, app.ownerKey)
      if (owner && owner.applicationId === app._id) await tx.collection('platform_configs').doc(app.ownerKey).remove()
      for (const row of [memory, portrait].filter(Boolean)) {
        const notice = 'admin_audit_' + row.key + '_' + row._id + ':' + row.revision
        if (await readOptionalDocument(tx, 'admin_notifications', notice)) await tx.collection('admin_notifications').doc(notice).update({ data: { resolved: true, resolvedAt: stamp } })
        await tx.collection('platform_configs').doc(row._id).update({ data: { key: row.key + '_archived' } })
      }
      const recoverUntil = clock() + 7 * 86400000
      await put(tx, recoveryPlotId(app._id), { ...clean(source), key: 'memorial_recovery_plot' })
      await put(tx, app._id, { ...clean(app), key: 'memorial_recycle', status: 'demolished', demolishedAt: stamp, recoverUntil, ...metadata })
      await put(tx, 'memorial_cleanup_' + hash(app._id), { key: 'memorial_recycle_job', applicationId: app._id, portraitId, recoverUntil,
        fileIds: [...new Set(filesIn([memory, portrait, source]))], createdAt: stamp })
      await presence.changed(tx, origin)
      return { id: app._id, status: 'demolished', locationRevision: revision, gardenId: origin, plotId: app.plotId, recoverUntil }
    })
  }
  async function cleanupMemorials() {
    const due = await db.collection('platform_configs').where({ key: 'memorial_recycle_job', recoverUntil: db.command.lte(clock()) }).orderBy('_id', 'asc').limit(10).get()
    for (const job of due.data || []) {
      // Expiration and restoration contend on the same app/job documents.
      await db.runTransaction(async tx => {
        const current = await read(tx, job._id), app = await read(tx, job.applicationId)
        if (!current || current.key !== 'memorial_recycle_job' || current.recoverUntil > clock() || !app || app.key !== 'memorial_recycle' || app.recoverUntil > clock()) return
        await put(tx, app._id, { key: 'memorial_demolished', ownerOpenid: app.ownerOpenid, status: 'demolished', gardenId: gardenId(app), plotId: app.plotId, locationRevision: app.locationRevision, updatedAt: now() })
        await tx.collection('platform_configs').doc(job._id).update({ data: { key: 'memorial_cleanup' } })
      })
    }
    const jobs = await db.collection('platform_configs').where({ key: 'memorial_cleanup' }).orderBy('_id', 'asc').limit(10).get()
    for (const job of jobs.data || []) {
      try {
        const app = await read(db, job.applicationId)
        if (!app || app.key !== 'memorial_demolished' || app.status !== 'demolished') continue
        const rows = await db.collection('platform_configs').where({ applicationId: job.applicationId }).limit(40).get()
        // The job itself has applicationId and must be excluded from this page.
        const related = (rows.data || []).filter(r => r.key !== 'memorial_cleanup')
        const assets = await db.collection('platform_configs').where({ key: 'memorial_portrait_asset', requestId: job.portraitId }).limit(40).get()
        const documents = [...new Map(related.concat(assets.data || []).map(row => [row._id, row])).values()]
        const ids = [...new Set([...(job.fileIds || []), ...filesIn(documents)])]
        for (let i = 0; i < ids.length; i += 50) {
          const result = await cloud.deleteFile({ fileList: ids.slice(i, i + 50) })
          if (!result || !Array.isArray(result.fileList) || result.fileList.length !== ids.slice(i, i + 50).length || result.fileList.some(f => Number(f.status) !== 0 && !/not.?exist|not.?found|不存在/i.test(f.errMsg || ''))) throw new Error('部分纪念文件删除失败')
        }
        for (const row of documents) await db.collection('platform_configs').doc(row._id).remove()
        if (!documents.length) await db.collection('platform_configs').doc(job._id).remove()
        else await db.collection('platform_configs').doc(job._id).update({ data: { fileIds: [], updatedAt: now() } })
      } catch (error) { console.error('[memorial-cleanup]', job._id, error.message) }
    }
  }
  return { handle, cleanupMemorials }
}
