module.exports = function createHandler(context) {
  const {
    cancelUnpaidOrders,
    expireDueUnacceptedOrders,
    getMonthDays,
    processOverdueUnfinishedOrders,
    processOverdueUnstartedOrders,
    sendUpcomingServiceRemindersToStaff,
    settlePetBeautyMonthlyRanking,
    toCstParts
  } = context
  return async function runScheduledTasks() {
      await cancelUnpaidOrders()
      await expireDueUnacceptedOrders()
      const upcomingReminders = await sendUpcomingServiceRemindersToStaff()
      const overdueUnstarted = await processOverdueUnstartedOrders()
      const overdueUnfinished = await processOverdueUnfinishedOrders()
      const today = toCstParts()
      let petBeautySettled = null
      const isLastDayOfMonth = today.dayNumber === getMonthDays(today.monthKey)
      if (isLastDayOfMonth) {
        petBeautySettled = await settlePetBeautyMonthlyRanking(today.monthKey, { source: 'timer' })
      }
      if (today.dayNumber <= 2) {
        const prevMonth = today.month === '01'
          ? `${today.year - 1}-12`
          : `${today.year}-${String(Number(today.month) - 1).padStart(2, '0')}`
        const prevSettled = await settlePetBeautyMonthlyRanking(prevMonth, { source: 'timer_catchup' })
        if (!petBeautySettled) petBeautySettled = prevSettled
      }
      return ({
        expired: true,
        upcomingRemindersCount: upcomingReminders.length,
        overdueUnstartedCount: overdueUnstarted.length,
        overdueUnfinishedCount: overdueUnfinished.length,
        petBeautySettled
      })
    
  }
}
