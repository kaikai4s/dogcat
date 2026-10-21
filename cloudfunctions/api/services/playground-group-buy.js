const world = require('./playground-world')
const { readConfig } = require('./playground-config')
const COLLECTION = 'pet_playground_groups'
const active = (o) => o && !o.deletedAt && !o.adminDeletedAt && !['cancelled', 'closed', 'refunded', 'expired'].includes(o.status) && o.paymentStatus !== 'closed'
const participating = (order) => active(order) && !order.groupBuyRefundRequired && order.status !== 'pending_pay' && order.paymentStatus === 'paid'
const optional = async (db, collection, id) => world.readDocument(db, collection, id, '读取拼单', true)
const isGroup = (data) => data.source === 'community_groupbuy' || !!data.groupBuyId
const keyOf = (sessions) => (sessions || []).map((s) => [s.date, require('../utils/time').toTimeValue(s.startTime)])
function discounted(order, rules) {
  const original = Math.round(Number(order.amount) * 100)
  const fee = rules.waiveVisitFee ? (order.priceSnapshot && order.priceSnapshot.services || []).filter((p) => p.key === 'visit_fee').reduce((sum, p) => sum + Math.round(Number(p.price || 0) * 100), 0) : 0
  const pay = Math.max(1, Math.round(Math.max(0, original - fee) * rules.discountRate))
  return { groupBuyDiscountAmount: (original - pay) / 100, discountAmount: (original - pay) / 100, payAmount: pay / 100,
    priceSnapshot: { ...order.priceSnapshot, originalAmount: original / 100, groupBuyRules: rules, discountAmount: (original - pay) / 100, payAmount: pay / 100 } }
}
module.exports = function createGroupBuy(context) {
  const { db } = context
  const now = () => context.nowMs ? context.nowMs() : context.now ? new Date(context.now()).getTime() : Date.now()
  const lateRefundReason = '拼单已截止或无法加入，全额原路退款'
  async function refundFailedGroupOrder(order) {
    if (typeof context.createRefundForOrder !== 'function') return
    return context.createRefundForOrder(order, order.payAmount, order.groupBuyRefundReason || lateRefundReason,
      'system_groupbuy_fail', order.clientOpenid, `groupbuy_fail_${order._id}`, { cancelStatus: 'expired' })
  }
  async function identity(openid) {
    const user = await context.getUser(openid)
    const raw = user && user.residentialCommunity
    const community = typeof raw === 'string' ? { name: raw } : raw
    const id = world.communityId({ residentialCommunity: community })
    if (!id) throw new Error('请先设置所属小区，再发起或参加拼单')
    return { user, community, id }
  }
  async function prepare(openid, data, pricing) {
    if (!isGroup(data)) return null
    const own = await identity(openid), config = await readConfig(db)
    if (!config.groupBuy.enabled) throw new Error('同小区拼单暂未开放')
    if (data.publishMode === 'direct') throw new Error('拼单由平台统一派单，请使用公开预约')
    if (data.couponId) throw new Error('拼单优惠不可与优惠券叠加')
    if (data.communityId !== own.id || String(data.serviceAddress || '').trim() !== own.community.name) throw new Error('拼单服务地点只能选择自己所属的小区')
    const sessions = Array.isArray(pricing.sessions) ? pricing.sessions : []
    if (!sessions.length) throw new Error('拼单服务时段不能为空')
    const dates = new Set(sessions.map((s) => s.date || (s.startTime ? String(s.startTime).slice(0, 10) : '')).filter(Boolean))
    if (dates.size > 1) throw new Error('同小区拼单仅支持同一自然日内的单日服务，不可跨天预约')
    const group = data.groupBuyId ? await optional(db, COLLECTION, String(data.groupBuyId)) : null
    if (data.groupBuyId && !group) throw new Error('拼单不存在')
    if (group && (group.communityId !== own.id || group.deadline <= now())) throw new Error('拼单不属于本小区或已截止')
    if (group && group.status === 'cancelled') throw new Error('拼单已取消')
    if (group && JSON.stringify(keyOf(group.serviceSessions)) !== JSON.stringify(keyOf(pricing.sessions))) throw new Error('参加拼单须使用该拼单的服务日期和时段')
    const firstStart = require('../utils/time').toTimeValue(pricing.sessions[0].startTime)
    const deadline = group ? group.deadline : Math.min(now() + config.groupBuy.recruitHours * 3600000, firstStart - 2 * 3600000)
    if (!Number.isFinite(deadline) || deadline <= now() + 60000) throw new Error('拼单服务时间至少需要预留2小时及募集时间')
    const rules = group ? group.rules : config.groupBuy
    return { ...own, group, rules, deadline, householdKey: world.hash([own.id, String(data.addressDetail||'').replace(/\s/g,''), String(data.doorplate||'').replace(/\s/g,'')].join('|')), estimated: discounted({ amount: pricing.amount, priceSnapshot: pricing.priceSnapshot }, rules) }
  }
  async function attach(tx, order, orderId, prepared) {
    if (!prepared) return order
    const currentUser=await optional(tx,'users',prepared.user._id)
    const currentCommunity=currentUser&&currentUser.residentialCommunity
    if(!currentCommunity||world.communityId({residentialCommunity:typeof currentCommunity==='string'?{name:currentCommunity}:currentCommunity})!==prepared.id)throw new Error('所属小区已变更，请重新发起拼单')
    const id = prepared.group ? prepared.group._id : 'group_' + world.hash(orderId)
    let group = await optional(tx, COLLECTION, id)
    if (!group) {
      if (prepared.group) throw new Error('拼单不存在')
      group = { communityId: prepared.id, communityName: prepared.community.name, creatorOpenid: order.clientOpenid, rules: prepared.rules,
        deadline: prepared.deadline, serviceSessions: order.serviceSessions, serviceSummary: order.serviceSummary, members: [], createdAt: now(), formedAt: 0 }
    }
    if (group.communityId !== prepared.id || group.deadline <= now()) throw new Error('拼单已截止，请重新发起')
    if (group.status === 'cancelled') throw new Error('拼单已取消')
    const members = []
    for (const m of group.members || []) {
      const existing = await optional(tx, 'orders', m.orderId)
      if (participating(existing, now())) members.push({ ...m, order: existing })
    }
    if (members.some((m) => m.openid === order.clientOpenid || m.householdKey === prepared.householdKey)) throw new Error('每户只能参加同一拼单一次，请查看我的拼单')
    if (members.length >= 20) throw new Error('该拼单人数已满')
    if (members.some(m => m.order.staffOpenid)) throw new Error('拼单已被接单，不可继续加入')
    const pending = (await tx.collection('orders').where({ groupBuyId: id, status: 'pending_pay' }).limit(100).get()).data || []
    if (pending.some((o) => o._id !== orderId && active(o) && o.paymentDeadline > now() && (o.clientOpenid === order.clientOpenid || o.groupBuyHouseholdKey === prepared.householdKey))) throw new Error('每户只能参加同一拼单一次，请先处理待付款订单')
    // Only a private order intent exists before payment. No group or member is
    // published until the verified payment transaction activates this order.
    return { ...order, ...discounted(order, group.rules), groupBuyId: id, source: 'community_groupbuy',
      communityId: prepared.id, groupBuyStatus: 'pending_payment', groupBuyRules: group.rules,
      groupBuyHouseholdKey: prepared.householdKey, groupBuyIntent: { communityName: prepared.community.name,
        creatorOpenid: group.creatorOpenid, deadline: group.deadline, serviceSessions: order.serviceSessions, serviceSummary: group.serviceSummary },
      paymentDeadline: Math.min(now() + 30 * 60 * 1000, group.deadline) }
  }
  async function onOrderCancelled(orderId, groupBuyId) {
    const id = groupBuyId || (orderId ? ((await db.collection('orders').doc(orderId).get().catch(() => ({ data: {} }))).data || {}).groupBuyId : '')
    if (!id) return
    const toRefundMembers = []

    await db.runTransaction(async (tx) => {
      toRefundMembers.length = 0
      const group = await optional(tx, COLLECTION, id)
      if (!group || group.status === 'cancelled') return

      const members = group.members || []
      const ids = members.map((m) => m.orderId).filter(Boolean)
      if (!ids.length) {
        await tx.collection(COLLECTION).doc(id).update({
          data: { status: 'cancelled', deadline: now(), cancelReason: '拼单全部成员已取消', updatedAt: now() }
        }).catch(() => {})
        return
      }

      const activeMembers = []
      for (const m of members) {
        if (m.orderId === orderId) continue
        const ord = await optional(tx, 'orders', m.orderId)
        if (participating(ord, now())) {
          activeMembers.push({ ...m, order: ord })
        }
      }

      // 当拼单最后一人也取消的时候，有效人数归零，立即取消该拼单团！
      const time = now()
      const minHouseholds = (group.rules && group.rules.minHouseholds) || 2
      if (activeMembers.length === 0) {
        await tx.collection(COLLECTION).doc(id).update({
          data: {
            status: 'cancelled',
            deadline: time,
            cancelReason: '拼单全部成员已取消，自动作废',
            updatedAt: time
          }
        })
      } else if (activeMembers.length < minHouseholds && group.formedAt) {
        // 曾成团，但因成员取消/未支付超时取消跌破最低成团门槛
        if (group.deadline <= time) {
          // 招募已截止，整团作废并退款
          await tx.collection(COLLECTION).doc(id).update({
            data: {
              status: 'cancelled',
              formedAt: 0,
              cancelReason: '因部分成员取消或未支付，成团人数不足且已过招募截止时间，拼单自动作废',
              members: activeMembers.map(({ openid, orderId, householdKey }) => ({ openid, orderId, ...(householdKey ? { householdKey } : {}) })),
              updatedAt: time
            }
          })
          for (const m of activeMembers) {
            const refundRequired = m.order && m.order.paymentStatus === 'paid' && Number(m.order.payAmount || 0) > 0
            const patch = { groupBuyStatus: 'cancelled', updatedAt: time,
              ...(refundRequired ? { status: 'expired', groupBuyRefundRequired: true,
                groupBuyRefundReason: '拼单人数不足且招募已截止，系统自动全额退款' } : {}) }
            await tx.collection('orders').doc(m.orderId).update({
              data: patch
            })
            if (refundRequired) toRefundMembers.push({ ...m.order, ...patch })
          }
        } else {
          // 尚未过截止时间，团退回招募中状态（formedAt: 0），等待新邻居加入！
          // 同时将剩余成员的订单 groupBuyStatus 退回 recruiting，杜绝被宠托师按成团抢走！
          await tx.collection(COLLECTION).doc(id).update({
            data: {
              formedAt: 0,
              status: 'recruiting',
              members: activeMembers.map(({ openid, orderId, householdKey }) => ({ openid, orderId, ...(householdKey ? { householdKey } : {}) })),
              updatedAt: time
            }
          })
          for (const m of activeMembers) {
            await tx.collection('orders').doc(m.orderId).update({
              data: {
                groupBuyStatus: 'recruiting',
                updatedAt: time
              }
            }).catch(() => {})
          }
        }
      } else {
        await tx.collection(COLLECTION).doc(id).update({
          data: {
            members: activeMembers.map(({ openid, orderId, householdKey }) => ({ openid, orderId, ...(householdKey ? { householdKey } : {}) })),
            updatedAt: time
          }
        })
      }
    }).catch((e) => {
      toRefundMembers.length = 0
      console.error('[onOrderCancelled] atomic transaction error:', e)
    })

    // 事务外安全退款，避免长事务和嵌套事务
    for (const ord of toRefundMembers) {
      await refundFailedGroupOrder(ord).catch((err) => console.error('[onOrderCancelled] auto refund fail:', ord._id, err.message))
    }
  }

  async function activatePaidOrder(tx, order) {
    if (!order.groupBuyId || !participating(order)) return order
    const id = order.groupBuyId, time = now()
    let group = await optional(tx, COLLECTION, id)
    if (!group) {
      const intent = order.groupBuyIntent
      if (!intent) throw new Error('拼单支付意图缺失，请联系客服')
      group = { ...intent, communityId: order.communityId, rules: order.groupBuyRules,
        creatorOpenid: order.clientOpenid, members: [], createdAt: time, formedAt: 0 }
    }
    const members = []
    for (const m of group.members || []) {
      if (m.orderId === order._id) continue
      const existing = await optional(tx, 'orders', m.orderId)
      if (participating(existing)) members.push({ ...m, order: existing })
    }
    const registered = order.groupBuyStatus !== 'pending_payment' && (group.members || []).some((m) => m.orderId === order._id)
    const conflict = members.some((m) => m.openid === order.clientOpenid || order.groupBuyHouseholdKey && m.householdKey === order.groupBuyHouseholdKey)
    if (order.groupBuyRefundRequired || group.status === 'cancelled' || (!registered && (group.deadline <= time || members.length >= 20 || conflict || members.some((m) => m.order.staffOpenid)))) {
      const patch = { groupBuyStatus: 'cancelled', groupBuyActivationFailed: true, groupBuyRefundRequired: true, groupBuyRefundReason: lateRefundReason, updatedAt: time }
      await tx.collection('orders').doc(order._id).update({ data: patch })
      return { ...order, ...patch }
    }
    members.push({ openid: order.clientOpenid, orderId: order._id, householdKey: order.groupBuyHouseholdKey || '', order })
    const formedAt = group.formedAt || (members.length >= (group.rules.minHouseholds || 2) ? time : 0)
    const status = formedAt ? 'formed' : 'recruiting'
    const history = (group.members || []).filter((m) => !members.some((n) => n.orderId === m.orderId))
    const { _id, ...clean } = group
    await tx.collection(COLLECTION).doc(id).set({ data: { ...clean, formedAt, status,
      members: [...history, ...members.map(({ openid, orderId, householdKey }) => ({ openid, orderId, householdKey }))], updatedAt: time } })
    for (const m of members) await tx.collection('orders').doc(m.orderId).update({ data: { groupBuyStatus: status, updatedAt: time } })
    return { ...order, groupBuyStatus: status }
  }
  async function onOrderPaid(orderId) {
    return require('./playground-transaction').transaction(db, async (tx) => {
      const order = await optional(tx, 'orders', orderId)
      return order ? activatePaidOrder(tx, order) : null
    })
  }

  async function expireGroupBuyIfDue(groupBuyId, time = now()) {
    if (!groupBuyId) return
    const stamp = typeof time === 'number' ? time : (time instanceof Date ? time.getTime() : new Date(time || 0).getTime())
    const toRefundOrders = []
    const cancelReason = '拼单截止未成团，系统已自动取消并全额退款'

    const success = await db.runTransaction(async (tx) => {
      toRefundOrders.length = 0
      const group = await optional(tx, COLLECTION, groupBuyId)
      if (!group || group.status === 'cancelled') return false
      if (group.formedAt || group.deadline > stamp) return false

      const members = group.members || []
      const activeMembers = []
      for (const m of members) {
        const ord = await optional(tx, 'orders', m.orderId)
        if (ord && !ord.deletedAt && !ord.adminDeletedAt && !['cancelled', 'closed', 'refunded'].includes(ord.status)) {
          activeMembers.push({ ...m, order: ord })
        }
      }

      await tx.collection(COLLECTION).doc(groupBuyId).update({
        data: {
          status: 'cancelled',
          deadline: stamp,
          cancelReason,
          updatedAt: stamp
        }
      })

      for (const m of activeMembers) {
        const ord = m.order
        const isPaid = ord && ord.paymentStatus === 'paid' && Number(ord.payAmount || 0) > 0
        if (isPaid) {
          const patch = { status: 'expired', groupBuyStatus: 'cancelled', groupBuyRefundRequired: true,
            groupBuyRefundReason: '拼单截止未成团，系统自动全额退款', cancelReason, updatedAt: stamp }
          await tx.collection('orders').doc(ord._id).update({ data: patch })
          toRefundOrders.push({ ...ord, ...patch })
        } else if (ord) {
          await tx.collection('orders').doc(ord._id).update({
            data: {
              status: 'cancelled',
              paymentStatus: 'closed',
              groupBuyStatus: 'cancelled',
              cancelReason: '拼单招募已截止',
              updatedAt: stamp
            }
          }).catch(() => {})
        }
      }
      return true
    }).catch((e) => {
      console.error('[expireGroupBuyIfDue] transaction error:', e)
      return false
    })

    if (!success) return

    // 事务成功提交后再执行退款，彻底杜绝事务嵌套死锁
    for (const ord of toRefundOrders) {
      await refundFailedGroupOrder(ord).catch((err) => console.error('[expireGroupBuyIfDue] auto refund failed:', ord._id, err.message))
    }
  }

  async function expireDueGroupBuys(time = now()) {
    const stamp = typeof time === 'number' ? time : (time instanceof Date ? time.getTime() : new Date(time || 0).getTime())
    // Payment callbacks may arrive after recruitment closed. Retry any refund
    // that could not be submitted immediately after the payment transaction.
    if (typeof context.createRefundForOrder === 'function') {
      let cursor = ''
      do {
        const pending = (await db.collection('orders').where({ groupBuyRefundRequired: true, paymentStatus: 'paid',
          ...(cursor ? { _id: db.command.gt(cursor) } : {}) }).orderBy('_id', 'asc').limit(100).get()).data || []
        for (const order of pending) {
          try { await refundFailedGroupOrder(order) }
          catch (error) { console.error('[expireDueGroupBuys] retry refund failed:', order._id, error.message) }
        }
        cursor = pending.length === 100 ? pending[pending.length - 1]._id : ''
      } while (cursor)
    }
    let cursor = ''
    do {
      const groups = (await db.collection(COLLECTION).where({
        status: db.command ? db.command.neq('cancelled') : 'recruiting',
        deadline: db.command ? db.command.lte(stamp) : stamp,
        ...(cursor ? { _id: db.command.gt(cursor) } : {})
      }).orderBy('_id', 'asc').limit(100).get()).data || []
      for (const g of groups) {
        if (!g.formedAt && g.deadline <= stamp && g.status !== 'cancelled') {
          try {
            await expireGroupBuyIfDue(g._id, stamp)
          } catch (err) {
            console.error('[expireDueGroupBuys] item error:', g._id, err.message)
          }
        }
      }
      cursor = groups.length === 100 ? groups[groups.length - 1]._id : ''
    } while (cursor)
  }

  async function list(openid) {
    let own
    try { own = await identity(openid) } catch (_) { return { communityName: '', groups: [], myGroups: [], availableCount: 0, rules: (await readConfig(db)).groupBuy } }
    const config = await readConfig(db)
    const stamp = now()
    const groups = [], myGroups = []
    let cursor = ''
    do {
      const where = { communityId: own.id, ...(cursor ? { _id: db.command.gt(cursor) } : {}) }
      const page = (await db.collection(COLLECTION).where(where).orderBy('_id', 'asc').limit(100).get()).data || []
      // Old neighbor groups cannot be joined. Avoid reading their entire order history.
      const relevant = page.filter((g) => (config.groupBuy.enabled && g.deadline > stamp) || (g.members || []).some((m) => m.openid === openid))
      const ids = [...new Set(relevant.flatMap((g) => (g.members || []).map((m) => m.orderId)))]
      const orders = new Map()
      for (let i = 0; i < ids.length; i += 100) {
        const result = await db.collection('orders').where({ _id: db.command.in(ids.slice(i, i + 100)) }).limit(100).get()
        for (const order of result.data || []) orders.set(order._id, order)
      }
      for (const group of relevant) {
        if (group.deadline <= stamp && !group.formedAt && group.status !== 'cancelled') {
          expireGroupBuyIfDue(group._id, stamp).catch(() => {})
        }
        const allMembers = (group.members || []).map((m) => ({ ...m, order: orders.get(m.orderId) }))
        const members = allMembers.filter((m) => participating(m.order, stamp))
        const mine = members.find((m) => m.openid === openid)
        // Keep cancelled/expired own orders discoverable until they are deleted.
        const ownMember = mine || allMembers.slice().reverse().find((m) => m.openid === openid && m.order && !m.order.deletedAt && !m.order.adminDeletedAt)
        const status = group.status === 'cancelled' ? 'cancelled' : group.formedAt ? 'formed' : group.deadline <= stamp ? 'expired' : 'recruiting'
        const item = { id: group._id, communityName: group.communityName, status, statusText: { formed: '已成团', expired: '未成团已截止', recruiting: '等待邻居参团', cancelled: '已取消' }[status],
          householdCount: members.length, minHouseholds: group.rules.minHouseholds, serviceSummary: group.serviceSummary, serviceSessions: group.serviceSessions,
          startTime: group.serviceSessions[0].startTime, deadline: group.deadline, rules: group.rules, mine: !!mine,
          ...(ownMember ? { orderId: ownMember.orderId, orderStatus: ownMember.order.status, payAmount: ownMember.order.payAmount,
            paymentDeadline: ownMember.order.paymentDeadline, paymentExpired: ownMember.order.status === 'pending_pay' && ownMember.order.paymentDeadline <= stamp,
            estimatedPayAmount: discounted(ownMember.order, group.rules).payAmount } : {}) }
        if (ownMember && (ownMember.order.paymentStatus === 'paid' || ownMember.order.paidAt || ['refunding', 'refunded'].includes(ownMember.order.paymentStatus))) myGroups.push(item)
        if (config.groupBuy.enabled && status === 'recruiting' && group.deadline > stamp && members.length > 0 && members.length < 20) groups.push(item)
      }
      cursor = page.length === 100 ? page[page.length - 1]._id : ''
    } while (cursor)
    groups.sort((a, b) => a.deadline - b.deadline)
    myGroups.sort((a, b) => b.deadline - a.deadline)
    return { communityId: own.id, community: own.community, communityName: own.community.name, groups: groups.slice(0, 30), myGroups: myGroups.slice(0, 30), availableCount: groups.filter((g) => !g.mine).length, rules: config.groupBuy }
  }
  return { prepare, attach, list, identity, onOrderCancelled, onOrderPaid, activatePaidOrder, expireGroupBuyIfDue, expireDueGroupBuys }
}
module.exports.isGroup = isGroup
module.exports.discounted = discounted
