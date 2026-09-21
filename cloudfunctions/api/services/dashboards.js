module.exports = function createService({
  getMonthDays,
  isPaidOrder,
  parseDateValue,
  toCstParts
}) {
  function buildMonthlyDashboard(orders = [], users = []) {
    const monthKey = toCstParts().monthKey
    const dayCount = getMonthDays(monthKey)
    const days = Array.from({ length: dayCount }, (_, index) => ({ day: index + 1, label: `${index + 1}日`, orders: 0, registrations: 0, revenue: 0 }))
    orders.forEach((order) => {
      const createdDate = parseDateValue(order.createdAt)
      if (createdDate) {
        const createdParts = toCstParts(createdDate)
        if (createdParts.monthKey === monthKey && days[createdParts.dayNumber - 1]) days[createdParts.dayNumber - 1].orders += 1
      }
      const paidDate = parseDateValue(order.paidAt || order.createdAt)
      if (!paidDate || !isPaidOrder(order)) return
      const paidParts = toCstParts(paidDate)
      if (paidParts.monthKey === monthKey && days[paidParts.dayNumber - 1]) days[paidParts.dayNumber - 1].revenue += Number(order.payAmount || 0)
    })
    users.forEach((user) => {
      const date = parseDateValue(user.createdAt)
      if (!date) return
      const parts = toCstParts(date)
      if (parts.monthKey === monthKey && days[parts.dayNumber - 1]) days[parts.dayNumber - 1].registrations += 1
    })
    const maxOrders = Math.max(...days.map((item) => item.orders), 1)
    const maxRegistrations = Math.max(...days.map((item) => item.registrations), 1)
    const maxRevenue = Math.max(...days.map((item) => item.revenue), 1)
    const revenueTotal = days.reduce((sum, item) => sum + item.revenue, 0)
    const paidOrders = orders.filter((order) => isPaidOrder(order)).filter((order) => {
      const paidDate = parseDateValue(order.paidAt || order.createdAt)
      return paidDate && toCstParts(paidDate).monthKey === monthKey
    })
    const withHeights = days.map((item) => ({
      ...item,
      revenueText: `¥${item.revenue}`,
      orderHeight: item.orders ? Math.max(Math.round((item.orders / maxOrders) * 100), 8) : 0,
      registrationHeight: item.registrations ? Math.max(Math.round((item.registrations / maxRegistrations) * 100), 8) : 0,
      revenueHeight: item.revenue ? Math.max(Math.round((item.revenue / maxRevenue) * 100), 8) : 0
    }))
    return {
      monthKey,
      days: withHeights,
      totals: {
        orders: days.reduce((sum, item) => sum + item.orders, 0),
        registrations: days.reduce((sum, item) => sum + item.registrations, 0),
        revenue: revenueTotal,
        paidOrders: paidOrders.length,
        averageOrderValue: paidOrders.length ? Math.round(revenueTotal / paidOrders.length) : 0
      },
      max: { orders: maxOrders, registrations: maxRegistrations, revenue: maxRevenue }
    }
  }

  return {
    buildMonthlyDashboard
  }
}
