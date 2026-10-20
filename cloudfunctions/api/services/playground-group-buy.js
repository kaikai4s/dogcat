const world = require('./playground-world')
const { readConfig } = require('./playground-config')
const COLLECTION = 'pet_playground_groups'
const active = (o) => o && !o.deletedAt && !o.adminDeletedAt && !['cancelled', 'closed', 'refunded'].includes(o.status) && o.paymentStatus !== 'closed'
const participating = (order, stamp) => active(order) && !(order.status === 'pending_pay' && Number.isFinite(order.paymentDeadline) && order.paymentDeadline <= stamp)
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
    const group = data.groupBuyId ? await optional(db, COLLECTION, String(data.groupBuyId)) : null
    if (data.groupBuyId && !group) throw new Error('拼单不存在')
    if (group && (group.communityId !== own.id || group.deadline <= now())) throw new Error('拼单不属于本小区或已截止')
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
    const members = []
    for (const m of group.members || []) {
      const existing = await optional(tx, 'orders', m.orderId)
      if (participating(existing, now())) members.push({ ...m, order: existing })
    }
    if (members.some((m) => m.openid === order.clientOpenid || m.householdKey === prepared.householdKey)) throw new Error('每户只能参加同一拼单一次，请查看我的拼单')
    if (members.length >= 20) throw new Error('该拼单人数已满')
    members.push({ openid: order.clientOpenid, orderId, householdKey: prepared.householdKey, order })
    const formedAt = group.formedAt || (members.length >= group.rules.minHouseholds ? now() : 0)
    for (const m of members) {
      if (m.order.status !== 'pending_pay' || m.order.paymentStatus === 'paid') continue
      const patch = { groupBuyId: id, source: 'community_groupbuy', communityId: prepared.id, groupBuyStatus: formedAt ? 'formed' : 'recruiting',
        groupBuyRules: group.rules, paymentDeadline: m.order.groupBuyStatus==='formed' ? m.order.paymentDeadline : formedAt ? Math.min(group.deadline + 1800000, now() + 1800000) : group.deadline,
        ...(formedAt ? discounted(m.order, group.rules) : {}), updatedAt: order.updatedAt }
      if (m.orderId === orderId) order = { ...order, ...patch }
      else await tx.collection('orders').doc(m.orderId).update({ data: patch })
    }
    const { _id, ...clean } = group
    const history = (group.members || []).filter((old) => !members.some((m) => m.orderId === old.orderId))
    await tx.collection(COLLECTION).doc(id).set({ data: { ...clean, formedAt, members: [...history, ...members.map(({ openid, orderId, householdKey }) => ({ openid, orderId, ...(householdKey?{householdKey}:{}) }))], updatedAt: now() } })
    return order
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
        const allMembers = (group.members || []).map((m) => ({ ...m, order: orders.get(m.orderId) }))
        const members = allMembers.filter((m) => participating(m.order, stamp))
        const mine = members.find((m) => m.openid === openid)
        // Keep cancelled/expired own orders discoverable until they are deleted.
        const ownMember = mine || allMembers.slice().reverse().find((m) => m.openid === openid && m.order && !m.order.deletedAt && !m.order.adminDeletedAt)
        const status = group.formedAt ? 'formed' : group.deadline <= stamp ? 'expired' : 'recruiting'
        const item = { id: group._id, communityName: group.communityName, status, statusText: { formed: '已成团', expired: '未成团已截止', recruiting: '等待邻居参团' }[status],
          householdCount: members.length, minHouseholds: group.rules.minHouseholds, serviceSummary: group.serviceSummary, serviceSessions: group.serviceSessions,
          startTime: group.serviceSessions[0].startTime, deadline: group.deadline, rules: group.rules, mine: !!mine,
          ...(ownMember ? { orderId: ownMember.orderId, orderStatus: ownMember.order.status, payAmount: ownMember.order.payAmount,
            paymentDeadline: ownMember.order.paymentDeadline, paymentExpired: ownMember.order.status === 'pending_pay' && ownMember.order.paymentDeadline <= stamp,
            estimatedPayAmount: discounted(ownMember.order, group.rules).payAmount } : {}) }
        if (ownMember) myGroups.push(item)
        if (config.groupBuy.enabled && group.deadline > stamp && members.length < 20) groups.push(item)
      }
      cursor = page.length === 100 ? page[page.length - 1]._id : ''
    } while (cursor)
    groups.sort((a, b) => a.deadline - b.deadline)
    myGroups.sort((a, b) => b.deadline - a.deadline)
    return { communityId: own.id, community: own.community, communityName: own.community.name, groups: groups.slice(0, 30), myGroups: myGroups.slice(0, 30), availableCount: groups.filter((g) => !g.mine).length, rules: config.groupBuy }
  }
  return { prepare, attach, list, identity }
}
module.exports.isGroup = isGroup
module.exports.discounted = discounted
