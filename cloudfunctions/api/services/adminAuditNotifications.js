const { documentPages, readOptionalDocument } = require('../utils/documentPages')

function buildAdminPendingAuditData({ applicant = '', type = '', reason = '' } = {}) {
  const sanitize = value => String(value || '').replace(/[\r\n\t]+/g, ' ').trim()
  return {
    thing1: { value: sanitize(applicant).slice(0, 20) || '申请人' },
    thing2: { value: sanitize(type).slice(0, 20) || '待审核事项' },
    thing3: { value: sanitize(reason).slice(0, 20) || '待管理员审核处理' }
  }
}

async function isAuditTargetHandled(db, auditType, targetId) {
  if (!auditType || !targetId || !db) return false
  const collections = {
    staff_audit: 'staff_profiles',
    staff_video: 'staff_profiles',
    staff_promotion: 'staff_promotion_applications',
    pet_vaccine: 'pet_vaccine_certifications',
    withdraw: 'withdraw_requests',
    supply_reimbursement: 'staff_supply_reimbursements',
    deposit_refund: 'staff_deposits',
    community_application: 'platform_configs',
    memorial_application: 'platform_configs',
    memorial_memory: 'platform_configs',
    memorial_portrait: 'platform_configs',
    appearance_customization: 'pet_playground_appearance_requests',
    incident: 'order_incidents',
    mall_after_sale: 'mall_orders',
    user_feedback: 'user_feedback',
    staff_cancellation_penalty: 'staff_deposit_evidences'
  }
  const collection = collections[auditType]
  if (!collection) return false
  const lookupId = ['memorial_memory', 'memorial_portrait'].includes(auditType) ? targetId.split(':')[0] : targetId
  const doc = await readOptionalDocument(db, collection, lookupId)
  if (!doc) return true
  if (auditType === 'staff_audit') return doc.auditStatus !== 'pending'
  if (auditType === 'staff_video') return doc.videoAuditStatus !== 'pending'
  if (auditType === 'staff_promotion') return doc.status !== 'pending'
  if (auditType === 'pet_vaccine') return doc.status !== 'pending'
  if (auditType === 'withdraw') return doc.status !== 'pending'
  if (auditType === 'supply_reimbursement') return doc.status !== 'pending'
  if (auditType === 'deposit_refund') return doc.refundStatus !== 'requested'
  if (['memorial_memory', 'memorial_portrait'].includes(auditType)) return doc.status !== 'pending' || doc.revision !== Number(targetId.split(':')[1])
  if (auditType === 'memorial_application') return doc.status !== 'pending'
  if (auditType === 'community_application') return doc.status !== 'pending'
  if (auditType === 'appearance_customization') return !['pending', 'processing'].includes(doc.status)
  if (auditType === 'incident') return doc.status !== 'open'
  if (auditType === 'mall_after_sale') return doc.refundStatus !== 'applied'
  if (auditType === 'user_feedback') return doc.status !== 'pending'
  if (auditType === 'staff_cancellation_penalty') return doc.status !== 'pending' || doc.amountPendingReview === false
  return false
}

module.exports = function createService(context) {
  const { db, crypto, now, enqueueSubscription, sendSubscribeMessage } = context
  const templateKey = 'adminPendingAudit'

  async function getActiveAdminOpenids(store = db) {
    const openids = []
    for await (const users of documentPages(store, db.command, 'users', { roles: db.command.in(['admin']) })) {
      for (const user of users) {
        if (!user.openid || ['disabled', 'deleted'].includes(user.status)) continue
        if (!openids.includes(user.openid)) openids.push(user.openid)
      }
    }
    return openids
  }

  function deliveryKey(auditType, targetId, openid) {
    return `admin_audit:${auditType}:${targetId}:${openid}`
  }

  async function checkHandled(auditType, targetId) {
    return isAuditTargetHandled(db, auditType, targetId)
  }

  async function enqueueAdminAuditNotification(tx, auditInfo = {}) {
    const {
      auditType = 'general',
      targetId = '',
      applicant = '',
      type = '待审核事项',
      reason = '待管理员审核处理',
      page = 'pages/admin/home/index',
      level = 'warning'
    } = auditInfo

    const data = buildAdminPendingAuditData({ applicant, type, reason })
    const recipients = []
    const admins = await getActiveAdminOpenids(tx)

    for (const openid of admins) {
      recipients.push(openid)
      await enqueueSubscription(tx, {
        openid,
        templateKey,
        orderId: targetId,
        page,
        messageData: data,
        auditType,
        auditTargetId: targetId,
        deliveryKey: deliveryKey(auditType, targetId, openid)
      })
    }

    const time = now()
    const notificationId = `admin_audit_${auditType}_${targetId}`
    if (crypto && !(await readOptionalDocument(tx, 'admin_notifications', notificationId))) {
      await tx.collection('admin_notifications').doc(notificationId).set({
        data: {
          type: `audit_${auditType}`,
          title: `新的${type}`,
          content: `${applicant || '用户'}提交了${type}（${reason}），请及时审核。`,
          level,
          targetType: auditType,
          targetId,
          actionUrl: '/' + page,
          read: false,
          readBy: [],
          idempotencyKey: notificationId,
          createdAt: time,
          updatedAt: time
        }
      }).catch(() => {})
    }

    return recipients
  }

  async function notifyAdminAudit(auditInfo = {}, recipients = null) {
    const {
      auditType = 'general',
      targetId = '',
      applicant = '',
      type = '待审核事项',
      reason = '待管理员审核处理',
      page = 'pages/admin/home/index'
    } = auditInfo

    const data = buildAdminPendingAuditData({ applicant, type, reason })
    const targetOpenids = Array.isArray(recipients) && recipients.length
      ? recipients
      : await getActiveAdminOpenids(db)

    const results = []
    for (const openid of targetOpenids) {
      try {
        const res = await sendSubscribeMessage(
          openid,
          templateKey,
          page,
          data,
          targetId,
          deliveryKey(auditType, targetId, openid)
        )
        results.push({ openid, ...res })
      } catch (err) {
        results.push({ openid, status: 'failed', error: err.message })
      }
    }
    return results
  }

  return {
    buildAdminPendingAuditData,
    getActiveAdminOpenids,
    isAuditTargetHandled: (auditType, targetId) => isAuditTargetHandled(db, auditType, targetId),
    enqueueAdminAuditNotification,
    notifyAdminAudit
  }
}
module.exports.buildAdminPendingAuditData = buildAdminPendingAuditData
module.exports.isAuditTargetHandled = isAuditTargetHandled
