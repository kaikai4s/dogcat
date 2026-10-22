// One safe household roster for every order entry point. Never expose sibling
// credentials or contact information through a bundle summary.
module.exports = function createGroupView({ db }) {
  function refundState(order = {}) {
    const paymentStatus = String(order.paymentStatus || '').toLowerCase()
    const refundStatus = String(order.refundStatus || '').toLowerCase()
    if (paymentStatus === 'refunded' || ['success', 'refunded', 'full_refunded'].includes(refundStatus) || order.status === 'refunded') return 'refunded'
    if (paymentStatus === 'refunding' || ['processing', 'approved'].includes(refundStatus)) return 'refunding'
    if (refundStatus === 'partially_refunded' || Number(order.refundedAmount || 0) > 0) return 'partial'
    return ''
  }

  function refundStateText(state) {
    return ({ refunded: '已退款', refunding: '退款中', partial: '部分退款' })[state] || ''
  }

  async function attach(order, options = {}) {
    if (!order || !order.groupBuyId) return order
    const siblings = []
    let cursor = ''
    do {
      const where = { groupBuyId: order.groupBuyId, ...(cursor ? { _id: db.command.gt(cursor) } : {}) }
      const page = (await db.collection('orders').where(where).orderBy('_id', 'asc').limit(100).get()).data || []
      siblings.push(...page.filter((o) => !o.deletedAt && !o.adminDeletedAt && !o.groupBuyActivationFailed && o.status !== 'pending_pay' &&
        (o.paymentStatus === 'paid' || o.paidAt || o.paymentStatus === 'refunding' || o.paymentStatus === 'refunded')))
      cursor = page.length === 100 ? page[page.length - 1]._id : ''
    } while (cursor)
    siblings.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a._id.localeCompare(b._id))
    const members = siblings.map((sib, index) => {
      const client = sib.clientSnapshot || {}
      const pets = Array.isArray(sib.petSnapshots) && sib.petSnapshots.length ? sib.petSnapshots : [sib.petSnapshot].filter(Boolean)
      const state = refundState(sib)
      return { orderId: sib._id, householdIndex: index + 1, householdLabel: `住户 ${index + 1}`,
        clientName: (client.displayName || client.nickname) ? String(client.displayName || client.nickname).slice(0, 1) + '**' : '宠物主',
        clientAvatar: client.avatarUrl || '', petName: sib.petName || pets.map((p) => p.name).join('、') || '宠物',
        petSnapshots: pets.map((p) => ({ name: p.name || '宠物', avatarFileId: p.avatarFileId || '', species: p.species || '',
          breed: p.breed || '', gender: p.gender || '', weight: p.weight || '', personality: p.personality || '',
          specialNotes: p.specialNotes || '', healthNotes: p.healthNotes || '', favoriteFood: p.favoriteFood || '', dislikes: p.dislikes || '' })),
        serviceSummary: sib.serviceSummary || '', serviceType: sib.serviceType || '', startTime: sib.startTime || '', endTime: sib.endTime || '',
        status: sib.status, isCompleted: ['completed', 'day_completed'].includes(sib.status),
        refundState: state, refundStatusText: refundStateText(state) }
    })
    if (options.publicView) for (const member of members) {
      member.clientAvatar = ''
      member.petSnapshots = member.petSnapshots.map(pet => ({ name: pet.name, species: pet.species, breed: pet.breed }))
    }
    const { groupBuyIntent, groupBuyHouseholdKey, ...displayOrder } = order
    return { ...displayOrder, isGroupBuy: true, householdCount: members.length, subOrders: members,
      groupBuyBundle: { groupBuyId: order.groupBuyId, householdCount: members.length, members } }
  }
  return { attach }
}
