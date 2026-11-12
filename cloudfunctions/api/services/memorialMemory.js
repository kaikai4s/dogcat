const crypto = require('crypto')
const { readOptionalDocument } = require('../utils/documentPages')
const digest = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32)
const clean = v => String(v || '').normalize('NFKC').trim()
const LIMITS = { image: 1024 * 1024, video: 30 * 1024 * 1024, music: 10 * 1024 * 1024 }
module.exports = context => {
  const { db, cloud, now, checkTextSecurity, checkImageSecurity } = context
  const gardens = require('./memorialGardens')(context)
  const { gardenId } = require('./memorialGardens')
  const read = (store, id) => readOptionalDocument(store, 'platform_configs', id)
  const put = (store, id, data) => store.collection('platform_configs').doc(id).set({ data })
  const memoryId = id => 'memorial_memory_' + digest(id)
  async function application(id, openid, owner = false) {
    const app = await read(db, clean(id))
    if (!app || app.key !== 'memorial_application' || app.status !== 'approved') throw new Error('这处时光小筑暂不可查看，请刷新')
    if (owner && app.ownerOpenid !== openid) throw new Error('只有主人可以编辑这份回忆')
    return app
  }
  const content = row => ({ text: row.text || '', images: row.images || [], videos: row.videos || [], music: row.music || null })
  async function hydrate(value) {
    const result = content(value || {})
    if (value && value.textFileId) {
      const file = await cloud.downloadFile({ fileID: value.textFileId })
      if (!file || !Buffer.isBuffer(file.fileContent)) throw new Error('回忆文字暂时未能读取，请重试')
      result.text = file.fileContent.toString('utf8')
    }
    const media = result.images.concat(result.videos, result.music ? [result.music] : [])
    if (!media.length) return result
    const response = await cloud.getTempFileURL({ fileList: media.map(m => ({ fileID: m.fileId, maxAge: 600 })) })
    const urls = new Map((response.fileList || []).map(f => [f.fileID, f.tempFileURL || '']))
    const safe = m => ({ uploadId: m.uploadId, name: m.name, kind: m.kind, entrance: m.entrance === true, url: urls.get(m.fileId) || '' })
    return { text: result.text, images: result.images.map(safe), videos: result.videos.map(safe), music: result.music ? safe(result.music) : null }
  }
  return async (openid, action, data, user) => {
    if (action === 'entrance') {
      const app = await application(data.id, openid), row = await read(db, memoryId(app._id))
      const published = row && row.isPublic && row.publicContent
      // Only sign selected media from the approved snapshot, never the draft.
      const selected = published ? await hydrate({ images: (published.images || []).filter(m => m.entrance === true), videos: (published.videos || []).filter(m => m.entrance === true) }) : { images: [], videos: [] }
      return { images: selected.images, videos: selected.videos }
    }
    if (action === 'getMemorialAdmin') {
      const app = await read(db, clean(data.id))
      if (!app || app.key !== 'memorial_application') throw new Error('时光小筑申请不存在')
      const row = await read(db, memoryId(app._id)), garden = await gardens.get(gardenId(app))
      return { id: app._id, ownerOpenid: app.ownerOpenid, applicant: app.applicant, petName: app.petName, epitaph: app.epitaph,
        date: app.date, lawn: app.lawn, plotId: app.plotId, x: app.x, y: app.y, gardenId: garden._id, gardenName: garden.name,
        status: app.status, createdAt: app.createdAt, reviewedAt: app.reviewedAt || (app.status !== 'pending' ? app.updatedAt : ''),
        reason: app.reason || '', style: app.style || 'arch', isPublic: !!(row && row.isPublic), reviewStatus: row && row.status || 'empty',
        memoryUpdatedAt: row && row.updatedAt, memoryReason: row && row.reason || '',
        draft: row ? await hydrate(row.draft) : null, story: row && row.isPublic && row.publicContent ? await hydrate(row.publicContent) : null,
        portrait: app.status === 'approved' ? await require('./memorialPortrait')(context)(openid, 'portraitDetailAdmin', { id: app._id }, user) : null }
    }
    if (action === 'detail') {
      const app = await application(data.id, openid)
      const garden = await gardens.get(gardenId(app))
      const owner = app.ownerOpenid === openid, row = await read(db, memoryId(app._id))
      const visible = !!(row && row.isPublic && row.publicContent)
      return { id: app._id, gardenId: garden._id, gardenName: garden.name, petName: app.petName, epitaph: app.epitaph, date: app.date, lawn: app.lawn, plotId: app.plotId,
        style: app.style || 'arch', owner, isPublic: !!(row && row.isPublic), hasPublicStory: visible,
        story: visible ? await hydrate(row.publicContent) : null,
        ...(owner ? { revision: row && row.revision || 0, reviewStatus: row && row.status || 'empty', reason: row && row.reason || '', draft: await hydrate(row && row.draft) } : {}) }
    }
    if (action === 'prepareMedia') {
      const app = await application(data.id, openid, true), kind = clean(data.kind)
      if (!Object.prototype.hasOwnProperty.call(LIMITS, kind)) throw new Error('不支持的媒体类型')
      const ext = clean(data.extension).toLowerCase()
      if (!(kind === 'image' ? ['jpg', 'png'] : kind === 'video' ? ['mp4', 'mov'] : ['mp3', 'm4a', 'wav']).includes(ext)) throw new Error('文件格式不支持')
      const token = crypto.randomBytes(16).toString('hex'), id = 'memorial_media_' + token
      const path = 'memorial-memories/uploads/' + digest(openid) + '/' + token + '.' + ext
      await put(db, id, { key: 'memorial_media', ownerOpenid: openid, applicationId: app._id, kind, path, name: clean(data.name).slice(0, 80), status: 'uploading', createdAt: now() })
      return { uploadId: id, cloudPath: path, maxBytes: LIMITS[kind] }
    }
    if (action === 'finishMedia') {
      const upload = await read(db, clean(data.uploadId)), fileId = clean(data.fileId)
      if (!upload || upload.key !== 'memorial_media' || upload.ownerOpenid !== openid) throw new Error('上传凭证无效')
      if (!Object.prototype.hasOwnProperty.call(LIMITS, upload.kind)) throw new Error('不支持的媒体类型')
      await application(upload.applicationId, openid, true)
      if (!/^cloud:\/\/[^/]+\//.test(fileId) || fileId.split('/').slice(3).join('/') !== upload.path) throw new Error('上传文件与凭证不匹配')
      if (upload.status === 'ready') {
        if (upload.sourceFileId !== fileId) throw new Error('上传文件不可替换')
        return { uploadId: upload._id, kind: upload.kind, name: upload.name }
      }
      const file = await cloud.downloadFile({ fileID: fileId }), bytes = file && file.fileContent
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS[upload.kind]) throw new Error('文件为空或超过大小限制')
      const isImage = bytes[0] === 137 && bytes[1] === 80 || bytes[0] === 255 && bytes[1] === 216
      const isVideo = bytes.toString('ascii', 4, 8) === 'ftyp'
      const isAudio = isVideo || bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224 || bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
      if (!(upload.kind === 'image' ? isImage : upload.kind === 'video' ? isVideo : isAudio)) throw new Error('文件内容与媒体类型不符')
      // Freeze the validated bytes in a server-only path; the uploader cannot
      // replace approved content by overwriting the client upload afterward.
      const vault = await cloud.uploadFile({ cloudPath: 'memorial-memories/vault/' + crypto.randomBytes(24).toString('hex') + '.' + upload.path.split('.').pop(), fileContent: bytes })
      if (!vault || !vault.fileID) throw new Error('媒体保存失败，请重试')
      if (upload.kind === 'image') await checkImageSecurity(openid, vault.fileID, { label: '纪念相册' })
      await db.runTransaction(async tx => {
        const current = await read(tx, upload._id)
        if (!current || current.ownerOpenid !== openid) throw new Error('上传凭证无效')
        if (current.status === 'ready') {
          if (current.sourceFileId !== fileId) throw new Error('上传文件不可替换')
          return
        }
        await tx.collection('platform_configs').doc(upload._id).update({ data: { status: 'ready', fileId: vault.fileID, sourceFileId: fileId, bytes: bytes.length, updatedAt: now() } })
      })
      return { uploadId: upload._id, kind: upload.kind, name: upload.name }
    }
    if (action === 'saveMemory') {
      const app = await application(data.id, openid, true), story = typeof data.text === 'string' ? data.text : ''
      if (typeof data.isPublic !== 'boolean' || !Number.isInteger(data.revision) || data.revision < 0) throw new Error('回忆版本或公开设置无效')
      if (!Array.isArray(data.images) || data.images.length > 12 || !Array.isArray(data.videos) || data.videos.length > 6) throw new Error('最多上传 12 张图片和 6 个视频')
      const ids = data.images.concat(data.videos, data.music ? [data.music] : [])
      if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('媒体列表重复或无效')
      const selections = {}
      for (const [field, refs] of [['entranceImages', data.images], ['entranceVideos', data.videos]]) {
        const chosen = data[field] === undefined ? [] : data[field]
        if (!Array.isArray(chosen) || chosen.some(id => typeof id !== 'string' || !refs.includes(id)) || new Set(chosen).size !== chosen.length) throw new Error('入口展示只能选择这份回忆中的照片和视频')
        selections[field] = new Set(chosen)
      }
      const media = await Promise.all(ids.map(id => read(db, id)))
      if (media.some(m => !m || m.key !== 'memorial_media' || m.status !== 'ready' || m.ownerOpenid !== openid || m.applicationId !== app._id)) throw new Error('只能使用为这处时光小筑上传完成的媒体')
      const lookup = new Map(media.map(m => [m._id, m]))
      function pick(id, kind) {
        const m = lookup.get(id)
        if (!m || m.kind !== kind) throw new Error('媒体类型不匹配')
        return { uploadId: m._id, fileId: m.fileId, name: m.name, kind, ...(kind !== 'music' ? { entrance: selections[kind === 'image' ? 'entranceImages' : 'entranceVideos'].has(id) } : {}) }
      }
      const draft = { text: story, images: data.images.map(id => pick(id, 'image')), videos: data.videos.map(id => pick(id, 'video')), music: data.music ? pick(data.music, 'music') : null }
      const saveFingerprint = digest(JSON.stringify([data.revision, story, data.isPublic, data.images, data.videos, data.music || null,
        data.images.filter(id => selections.entranceImages.has(id)), data.videos.filter(id => selections.entranceVideos.has(id))]))
      // Check bounded UTF-8 chunks without truncating the user's story. Long
      // text lives in immutable storage so it cannot overflow the memory document.
      let part = '', size = 0
      for (const char of story) {
        const bytes = Buffer.byteLength(char)
        if (size + bytes > 1800) { await checkTextSecurity(openid, part, { label: '宠物回忆' }); part = Array.from(part).slice(-80).join(''); size = Buffer.byteLength(part) }
        part += char; size += bytes
      }
      if (part) await checkTextSecurity(openid, part, { label: '宠物回忆' })
      if (Buffer.byteLength(story) > 16000) {
        const saved = await cloud.uploadFile({ cloudPath: 'memorial-memories/vault/' + crypto.randomBytes(24).toString('hex') + '.txt', fileContent: Buffer.from(story) })
        if (!saved || !saved.fileID) throw new Error('回忆文字保存失败，请重试')
        draft.text = ''; draft.textFileId = saved.fileID
      }
      return db.runTransaction(async tx => {
        const id = memoryId(app._id), previous = await read(tx, id)
        if (previous && previous.revision === data.revision + 1 && previous.saveFingerprint === saveFingerprint) {
          return { revision: previous.revision, status: previous.status }
        }
        if ((previous && previous.revision || 0) !== data.revision) throw new Error('回忆已在其他页面更新，请重新打开后编辑')
        if (previous && previous.status === 'pending') {
          const oldNotice = 'admin_audit_memorial_memory_' + id + ':' + previous.revision
          if (await readOptionalDocument(tx, 'admin_notifications', oldNotice)) await tx.collection('admin_notifications').doc(oldNotice).update({ data: { resolved: true, resolvedAt: now() } })
        }
        const revision = data.revision + 1
        await put(tx, id, { key: 'memorial_memory', gardenId: gardenId(app), applicationId: app._id, ownerOpenid: openid,
          petName: app.petName, applicant: user.nickname || '用户', lawn: app.lawn, plotId: app.plotId,
          revision, saveFingerprint, draft, isPublic: data.isPublic, status: data.isPublic ? 'pending' : 'private', reason: '',
          publicContent: previous && previous.publicContent || null, createdAt: previous && previous.createdAt || now(), updatedAt: now() })
        if (data.isPublic) await context.enqueueAdminAuditNotification(tx, { auditType: 'memorial_memory', targetId: id + ':' + revision,
          applicant: user.nickname || '用户', type: '纪念回忆审核', reason: app.petName, page: 'pages/admin/memorial/index?mode=memories' })
        return { revision, status: data.isPublic ? 'pending' : 'private' }
      })
    }
    if (action === 'listMemoriesAdmin') {
      if (data.pendingCountsOnly) return { pendingCount: (await db.collection('platform_configs').where({ key: 'memorial_memory', status: 'pending' }).count()).total }
      const where = { key: 'memorial_memory', status: ['pending', 'approved', 'rejected'].includes(data.status) ? data.status : 'pending' }
      if (data.cursor) where._id = db.command.gt(clean(data.cursor))
      const result = await db.collection('platform_configs').where(where).orderBy('_id', 'asc').limit(31).get()
      return { list: await gardens.labelRows(await Promise.all((result.data || []).slice(0, 30).map(async row => ({ _id: row._id, applicationId: row.applicationId, ownerOpenid: row.ownerOpenid, gardenId: gardenId(row),
        petName: row.petName, applicant: row.applicant, lawn: row.lawn, plotId: row.plotId, createdAt: row.updatedAt,
        status: row.status, reason: row.reason, revision: row.revision, memory: await hydrate(row.draft) })))),
        cursor: result.data && result.data.length ? result.data[Math.min(29, result.data.length - 1)]._id : '', hasMore: (result.data || []).length > 30 }
    }
    if (action === 'reviewMemory') {
      if (!['approved', 'rejected'].includes(data.status)) throw new Error('审核状态无效')
      const reason = clean(data.reason)
      if (reason.length > 200 || data.status === 'rejected' && !reason) throw new Error('请填写调整原因（200字以内）')
      await checkTextSecurity(openid, reason, { label: '回忆审核意见' })
      return db.runTransaction(async tx => {
        const row = await read(tx, clean(data.id))
        if (row && row.key === 'memorial_memory' && row.revision === data.revision && row.status === data.status && row.reason === reason) return { status: row.status }
        if (!row || row.key !== 'memorial_memory' || row.status !== 'pending' || row.revision !== data.revision) throw new Error('回忆已更新或已审核，请刷新')
        await tx.collection('platform_configs').doc(row._id).update({ data: { status: data.status, reason, reviewedBy: openid, updatedAt: now(),
          // Published content is an immutable full snapshot, initially null.
          ...(data.status === 'approved' ? { publicContent: db.command.set(row.draft) } : {}) } })
        const noticeId = 'admin_audit_memorial_memory_' + row._id + ':' + row.revision
        if (await readOptionalDocument(tx, 'admin_notifications', noticeId)) await tx.collection('admin_notifications').doc(noticeId).update({ data: { resolved: true, resolvedAt: now() } })
        const stamp = now(), time = stamp instanceof Date ? stamp.toISOString() : String(stamp)
        await tx.collection('system_notifications').doc('memorial_memory_result_' + digest(row._id + ':' + row.revision)).set({ data: {
          title: data.status === 'approved' ? '纪念回忆已公开' : '纪念回忆需要调整',
          content: data.status === 'approved' ? '“' + row.petName + '”的回忆已通过审核，大家可以阅读了。' : '“' + row.petName + '”的回忆需要调整：' + reason,
          target: 'client', targetOpenid: row.ownerOpenid, targetOpenids: [], type: 'notice', status: 'active', level: 'normal',
          targetUrl: '/packageMemorial/pages/memory?id=' + row.applicationId, createdAt: time, updatedAt: time
        } })
        return { status: data.status }
      })
    }
    throw new Error('未知回忆操作')
  }
}
