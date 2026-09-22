module.exports = function createService({
  checkTextSecurity,
  authorizeAdmin,
  db,
  getUser,
  now,
  safeText
}) {
  function normalizeIncidentStatus(value, fallback = 'open') {
    const status = safeText(value).trim()
    const allowed = ['open', 'triaging', 'waiting_client', 'waiting_staff', 'processing', 'refund_pending', 'resolved', 'rejected', 'closed']
    return allowed.includes(status) ? status : fallback
  }

  function normalizeIncidentType(value, fallback = 'complaint') {
    const type = safeText(value).trim()
    return ['sos', 'complaint', 'service_issue', 'refund_dispute', 'safety'].includes(type) ? type : fallback
  }

  async function recordIncidentAction(incidentId, action, actorRole, actorOpenid, detail = {}) {
    const time = now()
    await db.collection('incident_actions').add({ data: { incidentId, action, actorRole, actorOpenid, detail, createdAt: time } })
  }

  async function getIncidentForAccess(openid, incidentId) {
    const user = await getUser(openid)
    if (user.roles.includes('admin')) await authorizeAdmin(user)
    const incident = (await db.collection('order_incidents').doc(incidentId).get()).data
    if (!incident) throw new Error('纠纷不存在')
    if (user.roles.includes('admin') || incident.clientOpenid === openid || incident.staffOpenid === openid) return { user, incident }
    throw new Error('无权访问纠纷')
  }

  async function appendIncidentComment(incidentId, actorRole, actorOpenid, content, mediaFileIds = []) {
    const text = safeText(content).trim()
    const files = Array.isArray(mediaFileIds) ? mediaFileIds.filter(Boolean).slice(0, 9) : []
    if (!text && !files.length) throw new Error('请填写留言或上传证据')
    if (text) {
      await checkTextSecurity(actorOpenid, text, { scene: 2, label: '留言内容' })
    }
    const time = now()
    const comment = { incidentId, actorRole, actorOpenid, content: text, mediaFileIds: files, createdAt: time }
    const created = await db.collection('incident_comments').add({ data: comment })
    return { _id: created._id, ...comment }
  }

  return {
    normalizeIncidentStatus,
    normalizeIncidentType,
    recordIncidentAction,
    getIncidentForAccess,
    appendIncidentComment
  }
}
