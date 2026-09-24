module.exports = function createService({
  countByQuery,
  db,
  now,
  readScopedDocuments,
  removeByQuery,
  updateByQuery
}) {
  async function getUserManageStats(user) {
    const openid = user.openid
    const [pets, addresses, coupons, checkins, pointLogs, rewardMails, clientOrders, staffOrders, favorites, homeSecurity, retroLogs, invitesOut, invitesIn, staffProfiles] = await Promise.all([
      countByQuery('pets', { openid }),
      countByQuery('user_addresses', { openid }),
      countByQuery('user_coupons', { openid }),
      countByQuery('user_checkins', { openid }),
      countByQuery('point_logs', { openid }),
      countByQuery('reward_mails', { openid }),
      countByQuery('orders', { clientOpenid: openid }),
      countByQuery('orders', { staffOpenid: openid }),
      countByQuery('sitter_favorites', { openid }),
      countByQuery('home_security', { openid }),
      countByQuery('retro_card_logs', { openid }),
      countByQuery('user_invites', { inviterOpenid: openid }),
      countByQuery('user_invites', { invitedOpenid: openid }),
      countByQuery('staff_profiles', { openid })
    ])
    return { pets, addresses, coupons, checkins, pointLogs, rewardMails, clientOrders, staffOrders, favorites, homeSecurity, retroLogs, invitesOut, invitesIn, staffProfiles }
  }

  function normalizeEditableRoles(roles) {
    const allowed = ['client', 'staff', 'admin']
    const next = Array.isArray(roles) ? roles.filter((role) => allowed.includes(role)) : ['client']
    return Array.from(new Set(next.length ? next : ['client']))
  }

  async function countActiveAdmins(minRequired = 2) {
    let count = 0
    let cursor = ''
    while (true) {
      const query = {}
      if (cursor && db.command && typeof db.command.gt === 'function') {
        query._id = db.command.gt(cursor)
      }
      const page = (await db.collection('users').where(query).orderBy('_id', 'asc').limit(100).get()).data || []
      for (const user of page) {
        if (user.status !== 'deleted' && Array.isArray(user.roles) && user.roles.includes('admin')) {
          count++
          if (count >= minRequired) return count
        }
      }
      if (page.length < 100) break
      cursor = page[page.length - 1]._id
    }
    return count
  }

  async function assertAdminRoleChangeAllowed(target, roles, currentOpenid) {
    const hadAdmin = Array.isArray(target.roles) && target.roles.includes('admin')
    const hasAdmin = roles.includes('admin')
    if (target.openid === currentOpenid && hadAdmin !== hasAdmin) throw new Error('不能修改自己的管理员权限')
    if (hadAdmin && !hasAdmin) {
      const adminCount = await countActiveAdmins(2)
      if (adminCount <= 1) throw new Error('至少保留一个管理员')
    }
  }

  async function assertUserDeleteAllowed(target, currentOpenid, message = '不能删除自己的账号') {
    if (target.openid === currentOpenid) throw new Error(message)
    const targetRoles = Array.isArray(target.roles) ? target.roles : []
    if (targetRoles.includes('admin')) {
      const adminCount = await countActiveAdmins(2)
      if (adminCount <= 1) throw new Error('至少保留一个管理员')
    }

    const _ = db.command
    const inOp = _ && typeof _.in === 'function' ? _.in.bind(_) : (arr) => ({ $in: arr })

    // 1. 检查作为客户是否存在未完结或履约中的订单
    const activeClientStatuses = ['pending_pay', 'paid', 'assigned', 'in_service', 'day_completed']
    const activeClientOrderCount = await countByQuery('orders', {
      clientOpenid: target.openid,
      status: inOp(activeClientStatuses)
    }).catch(() => 0)

    if (activeClientOrderCount > 0) {
      throw new Error('该用户存在履约中或未完结的服务订单，无法删除')
    }

    // 检查是否存在退款处理中的订单
    const refundingOrderCount = await countByQuery('orders', {
      clientOpenid: target.openid,
      paymentStatus: 'refunding'
    }).catch(() => 0)

    if (refundingOrderCount > 0) {
      throw new Error('该用户存在退款处理中的订单，无法删除')
    }

    // 2. 检查作为宠托师是否存在尚未完成履约的订单
    const activeStaffStatuses = ['assigned', 'in_service', 'day_completed']
    const activeStaffOrderCount = await countByQuery('orders', {
      staffOpenid: target.openid,
      status: inOp(activeStaffStatuses)
    }).catch(() => 0)

    if (activeStaffOrderCount > 0) {
      throw new Error('该宠托师有尚未完成的履约订单，无法删除')
    }

    // 3. 检查是否存在待处理纠纷
    const activeIncidentStatuses = ['pending', 'processing']
    const clientIncidentCount = await countByQuery('order_incidents', {
      clientOpenid: target.openid,
      status: inOp(activeIncidentStatuses)
    }).catch(() => 0)
    const staffIncidentCount = await countByQuery('order_incidents', {
      staffOpenid: target.openid,
      status: inOp(activeIncidentStatuses)
    }).catch(() => 0)

    if (clientIncidentCount > 0 || staffIncidentCount > 0) {
      throw new Error('该用户存在处理中的纠纷或投诉，无法删除')
    }

    // 4. 检查作为宠托师是否存在待处理的提现申请
    const activeWithdrawStatuses = ['pending', 'approved']
    const activeWithdrawCount = await countByQuery('withdraw_requests', {
      staffOpenid: target.openid,
      status: inOp(activeWithdrawStatuses)
    }).catch(() => 0)

    if (activeWithdrawCount > 0) {
      throw new Error('该宠托师存在待处理的提现申请，无法删除')
    }
  }

  async function cleanupUserPersonalData(targetOpenid) {
    const cleanup = {}
    const openidWhere = { openid: targetOpenid }
    for (const name of ['pets', 'user_addresses', 'home_security', 'sitter_favorites', 'user_coupons', 'reward_mails', 'user_checkins', 'retro_card_logs', 'point_logs', 'lottery_records']) {
      cleanup[name] = await removeByQuery(name, openidWhere)
    }
    cleanup.userInvitesAsInviter = await removeByQuery('user_invites', { inviterOpenid: targetOpenid })
    cleanup.userInvitesAsInvited = await removeByQuery('user_invites', { invitedOpenid: targetOpenid })
    const staffProfiles = await readScopedDocuments('staff_profiles', { openid: targetOpenid })
    await Promise.all(staffProfiles.map((profile) => db.collection('staff_profiles').doc(profile._id).update({ data: { auditStatus: 'rejected', auditRemark: '用户已删除', isFeatured: false, featuredAt: '', featuredByOpenid: '', updatedAt: now() } })))
    cleanup.staffProfilesMarkedDeleted = staffProfiles.length
    const reviews = await readScopedDocuments('service_reviews', { clientOpenid: targetOpenid })
    await Promise.all(reviews.map((review) => db.collection('service_reviews').doc(review._id).update({ data: { clientName: '已删除用户', updatedAt: now() } })))
    cleanup.reviewsAnonymized = reviews.length
    return cleanup
  }

  async function detachUserFromHistoricalRecords(targetOpenid, deletedAt) {
    const cleanup = {}
    cleanup.ordersAsClient = await updateByQuery('orders', { clientOpenid: targetOpenid }, { deletedClientOpenid: targetOpenid, clientOpenid: '', clientUserId: '', clientDeletedAt: deletedAt, updatedAt: deletedAt })
    cleanup.ordersAsStaff = await updateByQuery('orders', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', staffUserId: '', staffDeletedAt: deletedAt, updatedAt: deletedAt })
    cleanup.ordersAsRequestedStaff = await updateByQuery('orders', { requestedStaffOpenid: targetOpenid }, { deletedRequestedStaffOpenid: targetOpenid, requestedStaffOpenid: '', updatedAt: deletedAt })
    cleanup.incidentsAsClient = await updateByQuery('order_incidents', { clientOpenid: targetOpenid }, { deletedClientOpenid: targetOpenid, clientOpenid: '', updatedAt: deletedAt })
    cleanup.incidentsAsStaff = await updateByQuery('order_incidents', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', updatedAt: deletedAt })
    cleanup.reviewsAsClient = await updateByQuery('service_reviews', { clientOpenid: targetOpenid }, { deletedClientOpenid: targetOpenid, clientOpenid: '', clientUserId: '', clientName: '已删除用户', updatedAt: deletedAt })
    cleanup.reviewsAsStaff = await updateByQuery('service_reviews', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', staffUserId: '', updatedAt: deletedAt })
    cleanup.checkinLogsAsStaff = await updateByQuery('checkin_logs', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', staffUserId: '', updatedAt: deletedAt })
    cleanup.trackLogsAsStaff = await updateByQuery('track_logs', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', staffUserId: '', updatedAt: deletedAt })
    cleanup.unlockLogsAsStaff = await updateByQuery('unlock_code_logs', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', staffUserId: '', updatedAt: deletedAt })
    return cleanup
  }

  return {
    getUserManageStats,
    normalizeEditableRoles,
    assertAdminRoleChangeAllowed,
    assertUserDeleteAllowed,
    cleanupUserPersonalData,
    detachUserFromHistoricalRecords
  }
}
