module.exports = function createHandler(context) {
  const {
    cancelUnpaidOrders,
    reconcilePendingRefunds,
    retryFailedSubscriptions,
    retryStaffCancellationNotifications,
    expireDueUnacceptedOrders,
    getMonthDays,
    processOverdueUnfinishedOrders,
    processOverdueUnstartedOrders,
    sendUpcomingServiceRemindersToStaff,
    settlePetBeautyMonthlyRanking,
    toCstParts
  } = context
  return async function runScheduledTasks() {
    console.log('[scheduled] timer triggered, running scheduled tasks...')
    for (const [name, task] of [['refunds', reconcilePendingRefunds], ['subscriptions', retryFailedSubscriptions], ['staffCancellationNotifications', retryStaffCancellationNotifications]]) {
      try { await task() }
      catch (error) { console.error('[scheduled-retry]', { task: name, message: error.message }) }
    }
    try { await cancelUnpaidOrders() }
    catch (error) { console.error('[scheduled-error] cancelUnpaidOrders:', error.message) }

    try { await expireDueUnacceptedOrders() }
    catch (error) { console.error('[scheduled-error] expireDueUnacceptedOrders:', error.message) }

    let upcomingReminders = []
    try { upcomingReminders = (await sendUpcomingServiceRemindersToStaff()) || [] }
    catch (error) { console.error('[scheduled-error] sendUpcomingServiceRemindersToStaff:', error.message) }

    let overdueUnstarted = []
    try { overdueUnstarted = (await processOverdueUnstartedOrders()) || [] }
    catch (error) { console.error('[scheduled-error] processOverdueUnstartedOrders:', error.message) }

    let overdueUnfinished = []
    try { overdueUnfinished = (await processOverdueUnfinishedOrders()) || [] }
    catch (error) { console.error('[scheduled-error] processOverdueUnfinishedOrders:', error.message) }

    const today = toCstParts()
    let petBeautySettled = null
    const isLastDayOfMonth = today.dayNumber === getMonthDays(today.monthKey)
    if (isLastDayOfMonth) {
      try { petBeautySettled = await settlePetBeautyMonthlyRanking(today.monthKey, { source: 'timer' }) }
      catch (error) { console.error('[scheduled-error] settlePetBeautyMonthlyRanking:', error.message) }
    }
    if (today.dayNumber <= 2) {
      const prevMonth = today.month === '01'
        ? `${today.year - 1}-12`
        : `${today.year}-${String(Number(today.month) - 1).padStart(2, '0')}`
      try {
        const prevSettled = await settlePetBeautyMonthlyRanking(prevMonth, { source: 'timer_catchup' })
        if (!petBeautySettled) petBeautySettled = prevSettled
      } catch (error) { console.error('[scheduled-error] settlePetBeautyMonthlyRanking prevMonth:', error.message) }
    }
    console.log('[scheduled] finished tasks summary:', {
      upcomingRemindersCount: upcomingReminders.length,
      overdueUnstartedCount: overdueUnstarted.length,
      overdueUnfinishedCount: overdueUnfinished.length
    })
    return ({
      expired: true,
      upcomingRemindersCount: upcomingReminders.length,
      overdueUnstartedCount: overdueUnstarted.length,
      overdueUnfinishedCount: overdueUnfinished.length,
      petBeautySettled
    })
  }
}
