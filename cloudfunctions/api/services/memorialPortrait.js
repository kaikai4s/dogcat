const crypto = require('crypto')
const { readOptionalDocument } = require('../utils/documentPages')
const { inspectPortrait, pngBuffer } = require('./playground-appearance-png')
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32)
const clean = v => String(v || '').normalize('NFKC').trim()
const placement = asset => asset && asset.layoutVersion === 1 ? { layoutVersion: 1, width: asset.width, height: asset.height, bounds: asset.bounds, scale: asset.scale } : {}
const rowId = id => 'memorial_portrait_' + hash(id)
module.exports = context => {
  const { db, cloud, now, checkTextSecurity } = context
  const gardens = require('./memorialGardens')(context)
  const { gardenId } = require('./memorialGardens')
  const presence = require('./memorialPresence')(context)
  const read = (store, id) => readOptionalDocument(store, 'platform_configs', id)
  const put = (store, id, data) => store.collection('platform_configs').doc(id).set({ data })
  async function app(id, openid, owner, store = db) {
    const row = await read(store, clean(id))
    if (!row || row.key !== 'memorial_application' || row.status !== 'approved') throw new Error('时光小筑尚未安放')
    if (owner && row.ownerOpenid !== openid) throw new Error('只有主人可以申请宠物画像')
    return row
  }
  async function signed(media) {
    if (!media.length) return []
    const result = await cloud.getTempFileURL({ fileList: media.map(m => ({ fileID: m.fileId, maxAge: 600 })) })
    const urls = new Map((result.fileList || []).map(f => [f.fileID, f.tempFileURL || '']))
    return media.map(m => ({ uploadId: m.uploadId, ...placement(m), url: urls.get(m.fileId) || '' }))
  }
  async function publicRow(row, references) {
    const a = await read(db, row.applicationId), plot = a && await read(db, a.plotKey)
    return { _id: row._id, applicationId: row.applicationId, gardenId: gardenId(row), petName: row.petName, lawn: row.lawn, plotId: row.plotId,
      style: plot && plot.style || a && a.style || 'arch', legacy: !plot || plot.footprint !== 2, pose: row.pose || 'sitting',
      applicant: row.applicant, revision: row.revision, status: row.status, reason: row.reason || '', note: row.note,
      createdAt: row.updatedAt, ...(references ? { photos: await signed(row.photos) } : {}),
      result: row.asset ? (await signed([row.asset]))[0] : null }
  }
  async function inspectUpload(openid, row, data) {
    const ticket = await read(db, clean(data.uploadId)), fileId = clean(data.fileId)
    if (!ticket || ticket.key !== 'memorial_portrait_asset' || ticket.ownerOpenid !== openid || ticket.requestId !== row._id || ticket.revision !== row.revision || !/^cloud:\/\/[^/]+\//.test(fileId) || fileId.split('/').slice(3).join('/') !== ticket.path) throw new Error('请上传当前申请的画像成品')
    const file = await cloud.downloadFile({ fileID: fileId }), bytes = pngBuffer(file && file.fileContent)
    if (bytes.length > 1024 * 1024) throw new Error('成品必须为不超过 1MB 的透明 PNG')
    const inspected = inspectPortrait(bytes)
    return { ...inspected, bytes: bytes.subarray(0, inspected.pngBytes) }
  }
  return async (openid, action, data, user) => {
    if (action === 'portraitDetail' || action === 'portraitDetailAdmin') {
      const a = await app(data.id, openid, action === 'portraitDetail'), row = await read(db, rowId(a._id))
      return row ? publicRow(row, true) : { revision: 0, status: 'empty', photos: [], result: null }
    }
    if (action === 'submitPortrait') {
      const a = await app(data.id, openid, true), note = clean(data.note), pose = data.pose === undefined ? 'sitting' : data.pose
      if (!['sitting', 'sleeping'].includes(pose)) throw new Error('请选择坐着或趴睡的画像姿势')
      if (!Number.isSafeInteger(data.revision) || data.revision < 0 || note.length > 500) throw new Error('申请版本或备注无效')
      if (typeof data.front !== 'string' || typeof data.side !== 'string' || data.front === data.side) throw new Error('请分别上传正面和侧面照片')
      const photos = await Promise.all([data.front, data.side].map(id => read(db, id)))
      if (photos.some(m => !m || m.key !== 'memorial_media' || m.kind !== 'image' || m.status !== 'ready' || m.applicationId !== a._id || m.ownerOpenid !== openid)) throw new Error('只能使用为这个小筑上传完成的照片')
      await checkTextSecurity(openid, note, { label: '宠物画像备注' })
      const fingerprint = hash(JSON.stringify([data.revision, data.front, data.side, note, pose]))
      return db.runTransaction(async tx => {
        const a = await app(data.id, openid, true, tx)
        const id = rowId(a._id), old = await read(tx, id)
        if (old && old.revision === data.revision + 1 && old.fingerprint === fingerprint) return { revision: old.revision, status: old.status }
        if ((old && old.revision || 0) !== data.revision) throw new Error('申请已更新，请刷新')
        if (old && old.status === 'pending') throw new Error('画像正在制作中，请等待审核员处理')
        const revision = data.revision + 1
        await put(tx, id, { key: 'memorial_portrait', gardenId: gardenId(a), applicationId: a._id, ownerOpenid: openid, plotKey: a.plotKey,
          petName: a.petName, lawn: a.lawn, plotId: a.plotId, applicant: user.nickname || '用户',
          revision, fingerprint, note, pose, photos: photos.map(m => ({ uploadId: m._id, fileId: m.fileId })),
          asset: old && old.asset || null, status: 'pending', reason: '', createdAt: old && old.createdAt || now(), updatedAt: now() })
        await context.enqueueAdminAuditNotification(tx, { auditType: 'memorial_portrait', targetId: id + ':' + revision,
          applicant: user.nickname || '用户', type: '宠物画像制作', reason: a.petName, page: 'pages/admin/memorial/index?mode=portraits' })
        return { revision, status: 'pending' }
      })
    }
    if (action === 'listPortraitsAdmin') {
      if (data.pendingCountsOnly) return { pendingCount: (await db.collection('platform_configs').where({ key: 'memorial_portrait', status: 'pending' }).count()).total }
      const result = await db.collection('platform_configs').where({ key: 'memorial_portrait', status: ['pending', 'approved', 'rejected'].includes(data.status) ? data.status : 'pending',
        ...(data.cursor ? { _id: db.command.gt(clean(data.cursor)) } : {}) }).orderBy('_id', 'asc').limit(31).get()
      const rows = (result.data || []).slice(0, 30)
      return { list: await gardens.labelRows(await Promise.all(rows.map(async row => ({ ...await publicRow(row, true), ownerOpenid: row.ownerOpenid })))), hasMore: (result.data || []).length > 30, cursor: rows.length ? rows[rows.length - 1]._id : '' }
    }
    if (action === 'preparePortraitAsset') {
      const row = await read(db, clean(data.id))
      if (!row || row.key !== 'memorial_portrait' || row.status !== 'pending' || row.revision !== data.revision) throw new Error('申请已变化，请刷新')
      if (data.uploadId) {
        const { width, height, bounds, digest } = await inspectUpload(openid, row, data)
        return { layoutVersion: 1, width, height, bounds, previewDigest: digest, scale: 1 }
      }
      const id = 'memorial_portrait_asset_' + crypto.randomBytes(16).toString('hex'), path = 'memorial-memories/uploads/' + hash(openid) + '/' + id + '.png'
      await db.runTransaction(async tx => {
        await app(row.applicationId, openid, false, tx)
        const latest = await read(tx, row._id)
        if (!latest || latest.status !== 'pending' || latest.revision !== row.revision) throw new Error('申请已变化，请刷新')
        await put(tx, id, { key: 'memorial_portrait_asset', applicationId: row.applicationId, ownerOpenid: openid, requestId: row._id, revision: row.revision, path, status: 'uploading', createdAt: now() })
      })
      return { uploadId: id, cloudPath: path, maxBytes: 1024 * 1024 }
    }
    if (action === 'reviewPortrait') {
      const reason = clean(data.reason)
      if (!['approved', 'rejected'].includes(data.status) || reason.length > 200 || data.status === 'rejected' && !reason) throw new Error('请填写有效审核意见')
      if (!Number.isSafeInteger(data.revision) || data.revision < 1) throw new Error('申请版本无效')
      const row = await read(db, clean(data.id))
      if (!row || row.key !== 'memorial_portrait') throw new Error('申请不存在')
      const scale = data.scale === undefined ? 1 : data.scale
      if (data.status === 'approved' && (typeof scale !== 'number' || !Number.isFinite(scale) || scale < .5 || scale > 1.4)) throw new Error('画像大小须在 50% 到 140% 之间')
      const decision = hash(JSON.stringify([data.revision, data.status, reason, data.uploadId || '', data.fileId || '', data.status === 'approved' ? scale : null, data.previewDigest || '']))
      if (row.revision === data.revision && row.decision === decision && row.status === data.status) return { status: row.status }
      if (row.status !== 'pending' || row.revision !== data.revision) throw new Error('申请已更新或处理，请刷新')
      await checkTextSecurity(openid, reason, { label: '画像审核意见' })
      let asset, generatedFile, retained = false
      try {
        if (data.status === 'approved') {
          const { bytes, width, height, bounds, digest } = await inspectUpload(openid, row, data)
          if (data.previewDigest !== digest) throw new Error('请重新上传并预览成品后再安放，文件与预览不一致')
          const uploaded = await cloud.uploadFile({ cloudPath: 'memorial-memories/vault/portrait-' + crypto.randomBytes(24).toString('hex') + '.png', fileContent: bytes })
          if (!uploaded || !uploaded.fileID) throw new Error('画像保存失败，请重试')
          generatedFile = uploaded.fileID
          await context.checkImageSecurity(openid, uploaded.fileID, { label: '宠物画像成品' })
          asset = { uploadId: data.uploadId, fileId: uploaded.fileID, width, height, bounds, scale, layoutVersion: 1 }
        }
        const result = await db.runTransaction(async tx => {
          await app(row.applicationId, openid, false, tx)
          const latest = await read(tx, row._id)
          if (latest && latest.revision === data.revision && latest.decision === decision && latest.status === data.status) return { status: latest.status, retainedFile: latest.asset && latest.asset.fileId }
          if (!latest || latest.status !== 'pending' || latest.revision !== data.revision) throw new Error('申请已更新或处理，请刷新')
          if (asset) {
            const a = await read(tx, row.applicationId), plot = a && await read(tx, a.plotKey)
            if (!a || a.status !== 'approved' || !plot || plot.status !== 'approved' || plot.applicationId !== a._id) throw new Error('小筑状态已变化，请刷新')
            // CloudBase expands plain objects into nested writes. Replace the
            // complete snapshot so a previous null (or legacy fields) is safe.
            await tx.collection('platform_configs').doc(a.plotKey).update({ data: { portrait: db.command.set(asset), updatedAt: now() } })
            await presence.changed(tx, gardenId(a))
          }
          await tx.collection('platform_configs').doc(row._id).update({ data: { status: data.status, reason, decision, reviewedBy: openid, updatedAt: now(), ...(asset ? { asset: db.command.set(asset) } : {}) } })
          const notice = 'admin_audit_memorial_portrait_' + row._id + ':' + row.revision
          if (await readOptionalDocument(tx, 'admin_notifications', notice)) await tx.collection('admin_notifications').doc(notice).update({ data: { resolved: true, resolvedAt: now() } })
          const stamp = now(), time = stamp instanceof Date ? stamp.toISOString() : String(stamp)
          await tx.collection('system_notifications').doc('memorial_portrait_result_' + hash(row._id + ':' + row.revision)).set({ data: {
            title: asset ? '宠物画像已安放' : '宠物画像申请需要调整', content: asset ? '“' + row.petName + '”的画像已安放在时光小筑平台上，回园看看它吧。' : '请调整画像照片：' + reason,
            target: 'client', targetOpenid: row.ownerOpenid, targetOpenids: [], type: 'notice', status: 'active', level: 'normal',
            targetUrl: '/packageMemorial/pages/memory?id=' + row.applicationId, createdAt: time, updatedAt: time
          } })
          return { status: data.status, retainedFile: asset && asset.fileId }
        })
        retained = !generatedFile || result.retainedFile === generatedFile
        return { status: result.status }
      } finally {
        if (generatedFile && !retained) await require('./memorialFileCleanup').discardFiles(context, [generatedFile], [row._id])
      }
    }
    throw new Error('未知画像操作')
  }
}
