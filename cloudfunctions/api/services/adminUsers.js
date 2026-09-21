module.exports = function createService({
  countByQuery,
  db,
  now,
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

  async function assertAdminRoleChangeAllowed(target, roles, currentOpenid) {
    const hadAdmin = Array.isArray(target.roles) && target.roles.includes('admin')
    const hasAdmin = roles.includes('admin')
    if (target.openid === currentOpenid && hadAdmin !== hasAdmin) throw new Error('不能修改自己的管理员权限')
    if (hadAdmin && !hasAdmin) {
      const usersRes = await db.collection('users').get()
      const admins = (usersRes.data || []).filter((user) => user.status !== 'deleted' && Array.isArray(user.roles) && user.roles.includes('admin'))
      if (admins.length <= 1) throw new Error('至少保留一个管理员')
    }
  }

  async function assertUserDeleteAllowed(target, currentOpenid, message = '不能删除自己的账号') {
    if (target.openid === currentOpenid) throw new Error(message)
    const targetRoles = Array.isArray(target.roles) ? target.roles : []
    if (targetRoles.includes('admin')) {
      const usersRes = await db.collection('users').get()
      const admins = (usersRes.data || []).filter((user) => user.status !== 'deleted' && Array.isArray(user.roles) && user.roles.includes('admin'))
      if (admins.length <= 1) throw new Error('至少保留一个管理员')
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
    const staffProfiles = (await db.collection('staff_profiles').where({ openid: targetOpenid }).get()).data || []
    await Promise.all(staffProfiles.map((profile) => db.collection('staff_profiles').doc(profile._id).update({ data: { auditStatus: 'rejected', auditRemark: '用户已删除', isFeatured: false, featuredAt: '', featuredByOpenid: '', updatedAt: now() } })))
    cleanup.staffProfilesMarkedDeleted = staffProfiles.length
    const reviews = (await db.collection('service_reviews').where({ clientOpenid: targetOpenid }).get()).data || []
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
