module.exports = function createHandler(context) {
  const {
    cancelUnpaidOrders,
    reconcilePendingRefunds,
    retryFailedSubscriptions,
    retryStaffCancellationNotifications,
    expireDueUnacceptedOrders,
    autoAcceptDueDirectOrders,
    getMonthDays,
    processOverdueUnfinishedOrders,
    processOverdueUnstartedOrders,
    sendUpcomingServiceRemindersToStaff,
    settlePetBeautyMonthlyRanking,
    toCstParts
  } = context
  return async function runScheduledTasks() {
    const startedAt = Date.now()
    console.log('[scheduled] timer triggered, running scheduled tasks...')

    // 1. 并发执行相互独立的对账与补偿重试任务，避免慢网络累加串行耗时
    const retryTasks = [
      { name: 'refunds', fn: reconcilePendingRefunds },
      { name: 'subscriptions', fn: retryFailedSubscriptions },
      { name: 'staffCancellationNotifications', fn: retryStaffCancellationNotifications }
    ]
    await Promise.allSettled(retryTasks.map(async ({ name, fn }) => {
      try {
        if (typeof fn === 'function') await fn()
      } catch (error) {
        console.error('[scheduled-retry]', { task: name, message: error.message })
      }
    }))

    // 2. 核心订单生命周期超时流转（超时关单、未接单失效、指定单自动接单）
    try { await cancelUnpaidOrders() }
    catch (error) { console.error('[scheduled-error] cancelUnpaidOrders:', error.message) }

    try { await expireDueUnacceptedOrders() }
    catch (error) { console.error('[scheduled-error] expireDueUnacceptedOrders:', error.message) }

    if (typeof autoAcceptDueDirectOrders === 'function') {
      try { await autoAcceptDueDirectOrders() }
      catch (error) { console.error('[scheduled-error] autoAcceptDueDirectOrders:', error.message) }
    }

    // 3. 履约预警与临近服务触达
    let upcomingReminders = []
    try { upcomingReminders = (await sendUpcomingServiceRemindersToStaff()) || [] }
    catch (error) { console.error('[scheduled-error] sendUpcomingServiceRemindersToStaff:', error.message) }

    let overdueUnstarted = []
    try { overdueUnstarted = (await processOverdueUnstartedOrders()) || [] }
    catch (error) { console.error('[scheduled-error] processOverdueUnstartedOrders:', error.message) }

    let overdueUnfinished = []
    try { overdueUnfinished = (await processOverdueUnfinishedOrders()) || [] }
    catch (error) { console.error('[scheduled-error] processOverdueUnfinishedOrders:', error.message) }

    // 4. 月度选美结算（带耗时预算守护：若当前已执行超过 80 秒，记录告警留待下一周期）
    const today = toCstParts()
    let petBeautySettled = null
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs < 80000) {
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
    } else {
      console.warn(`[scheduled] tasks elapsed ${elapsedMs}ms, skipping non-urgent monthly beauty ranking this cycle to prevent timeout.`)
    }

    console.log('[scheduled] finished tasks summary:', {
      elapsedMs: Date.now() - startedAt,
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
