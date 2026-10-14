module.exports = function createService({
  crypto,
  db,
  getSystemSettings,
  now,
  safeText,
  toCstParts
}) {
  const LIMIT_MESSAGE = '当日全平台转帐额度受限,请明日再申请'

  function cents(value, allowEmpty = false) {
    if ((value === undefined || value === null || value === '') && allowEmpty) return null
    const number = Number(value)
    const result = Math.round(number * 100)
    if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(result) || Math.abs(number * 100 - result) > 0.000001) throw new Error('微信转账额度配置不正确')
    return result
  }

  function yuan(fen) {
    if (fen === null || fen === undefined) return null
    return Math.round(Number(fen || 0)) / 100
  }

  function hashOpenid(openid) {
    const text = safeText(openid).trim()
    if (!text) throw new Error('微信提现收款用户缺失')
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)
  }

  function scopeIds(dateKey, openid) {
    const recipientHash = hashOpenid(openid)
    return {
      dateKey,
      recipientHash,
      platformDailyId: `platform:${dateKey}`,
      recipientDailyId: `recipient:${dateKey}:${recipientHash}`,
      platformInflightId: 'platform',
      recipientInflightId: `recipient:${recipientHash}`
    }
  }

  async function readDoc(reader, collectionName, id) {
    const res = await reader.collection(collectionName).doc(id).get().catch((error) => {
      if (String(error.message || error.errMsg || error).includes(`document with _id ${id} does not exist`)) return { data: null }
      throw error
    })
    return (res && res.data) || null
  }

  async function saveLedgerDoc(writer, withdrawId, payload) {
    const { _id, ...clean } = payload
    await writer.collection('wechat_transfer_quota_ledger').doc(withdrawId).set({ data: clean })
  }

  async function setCounter(reader, collectionName, id, patch, base = {}) {
    const current = await readDoc(reader, collectionName, id)
    const time = now()
    const { _id: _ignoredBaseId, ...cleanBase } = base
    const data = {
      ...cleanBase,
      successfulFen: Math.max(0, Number(current?.successfulFen || 0) + Number(patch.successfulFen || 0)),
      reservedFen: Math.max(0, Number(current?.reservedFen || 0) + Number(patch.reservedFen || 0)),
      outstandingFen: Math.max(0, Number(current?.outstandingFen || 0) + Number(patch.outstandingFen || 0)),
      updatedAt: time
    }
    if (!current) data.createdAt = time
    await reader.collection(collectionName).doc(id).set({ data })
    return data
  }

  function parseLimitFen(value) {
    if (value === undefined || value === null || value === '') return null
    return cents(value, true)
  }

  function getEnvSingleLimitFen() {
    const raw = process.env.WECHAT_TRANSFER_MAX_AMOUNT
    if (raw === undefined || raw === null || raw === '') return null
    return cents(raw, true)
  }

  function getQuotaConfig(settings = {}) {
    const transfer = (settings.staffSupplies && settings.staffSupplies.transfer) || (settings.payment && settings.payment.transfer) || {}
    const adminSingle = parseLimitFen(transfer.maxAmount)
    const envSingle = getEnvSingleLimitFen()
    const candidates = [adminSingle, envSingle].filter(value => value !== null)
    return {
      platformDailyMaxFen: parseLimitFen(transfer.platformDailyMaxAmount),
      singleMaxFen: candidates.length ? Math.min(...candidates) : null,
      recipientDailyMaxFen: parseLimitFen(transfer.recipientDailyMaxAmount)
    }
  }

  function amountFenOf(request, fallback) {
    const amountFen = Number(request && request.amountFen) || (request && request.amount !== undefined ? Math.round(Number(request.amount) * 100) : Number(fallback || 0))
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0) throw new Error('微信提现金额不正确')
    return amountFen
  }

  function assertQuotaAvailable(config, counters, amountFen) {
    if (config.singleMaxFen !== null && amountFen > config.singleMaxFen) throw new Error(`微信提现金额超过单笔上限 ¥${yuan(config.singleMaxFen).toFixed(2)}`)
    if (config.platformDailyMaxFen !== null && counters.platformUsedFen + amountFen > config.platformDailyMaxFen) {
      const error = new Error(LIMIT_MESSAGE)
      error.code = 'WECHAT_TRANSFER_PLATFORM_DAILY_LIMIT'
      throw error
    }
    if (config.recipientDailyMaxFen !== null && counters.recipientUsedFen + amountFen > config.recipientDailyMaxFen) {
      const error = new Error('当日个人微信转账额度受限,请明日再申请')
      error.code = 'WECHAT_TRANSFER_RECIPIENT_DAILY_LIMIT'
      throw error
    }
  }

  async function readCounters(reader, ids) {
    const platformDaily = await readDoc(reader, 'wechat_transfer_quota_daily', ids.platformDailyId)
    const recipientDaily = await readDoc(reader, 'wechat_transfer_quota_daily', ids.recipientDailyId)
    const platformInflight = await readDoc(reader, 'wechat_transfer_quota_inflight', ids.platformInflightId)
    const recipientInflight = await readDoc(reader, 'wechat_transfer_quota_inflight', ids.recipientInflightId)
    return {
      platformDaily,
      recipientDaily,
      platformInflight,
      recipientInflight,
      platformUsedFen: Number(platformDaily?.successfulFen || 0) + Number(platformDaily?.reservedFen || 0) + Number(platformInflight?.outstandingFen || 0),
      recipientUsedFen: Number(recipientDaily?.successfulFen || 0) + Number(recipientDaily?.reservedFen || 0) + Number(recipientInflight?.outstandingFen || 0)
    }
  }

  async function getWechatTransferQuotaOverview() {
    const settings = await getSystemSettings().catch(() => ({}))
    const config = getQuotaConfig(settings)
    const dateKey = toCstParts(now()).dateKey
    const platformDaily = await readDoc(db, 'wechat_transfer_quota_daily', `platform:${dateKey}`)
    const platformInflight = await readDoc(db, 'wechat_transfer_quota_inflight', 'platform')
    const usedFen = Number(platformDaily?.successfulFen || 0) + Number(platformDaily?.reservedFen || 0) + Number(platformInflight?.outstandingFen || 0)
    const remainingFen = config.platformDailyMaxFen === null ? null : Math.max(0, config.platformDailyMaxFen - usedFen)
    return {
      dateKey,
      platformDailyMaxAmount: yuan(config.platformDailyMaxFen),
      platformDailySuccessfulAmount: yuan(platformDaily?.successfulFen || 0),
      platformDailyReservedAmount: yuan(platformDaily?.reservedFen || 0),
      platformInflightAmount: yuan(platformInflight?.outstandingFen || 0),
      platformDailyRemainingAmount: yuan(remainingFen),
      singleMaxAmount: yuan(config.singleMaxFen),
      recipientDailyMaxAmount: yuan(config.recipientDailyMaxFen)
    }
  }

  async function getWechatTransferQuotaSnapshot(openid, amountFen = 0) {
    const settings = await getSystemSettings().catch(() => ({}))
    const config = getQuotaConfig(settings)
    const dateKey = toCstParts(now()).dateKey
    const ids = scopeIds(dateKey, openid)
    const counters = await readCounters(db, ids)
    const platformRemainingFen = config.platformDailyMaxFen === null ? null : Math.max(0, config.platformDailyMaxFen - counters.platformUsedFen)
    const recipientRemainingFen = config.recipientDailyMaxFen === null ? null : Math.max(0, config.recipientDailyMaxFen - counters.recipientUsedFen)
    const effectiveCandidates = [config.singleMaxFen, platformRemainingFen, recipientRemainingFen].filter(value => value !== null)
    const effectiveRemainingFen = effectiveCandidates.length ? Math.max(0, Math.min(...effectiveCandidates)) : null
    const requestedFen = Number(amountFen || 0)
    const platformLimited = platformRemainingFen !== null && requestedFen > 0 && requestedFen > platformRemainingFen
    const recipientLimited = recipientRemainingFen !== null && requestedFen > 0 && requestedFen > recipientRemainingFen
    return {
      dateKey,
      singleMaxAmount: yuan(config.singleMaxFen),
      platformDailyMaxAmount: yuan(config.platformDailyMaxFen),
      recipientDailyMaxAmount: yuan(config.recipientDailyMaxFen),
      platformDailySuccessfulAmount: yuan(counters.platformDaily?.successfulFen || 0),
      platformDailyReservedAmount: yuan(counters.platformDaily?.reservedFen || 0),
      platformInflightAmount: yuan(counters.platformInflight?.outstandingFen || 0),
      platformDailyRemainingAmount: yuan(platformRemainingFen),
      recipientDailyRemainingAmount: yuan(recipientRemainingFen),
      effectiveRemainingAmount: yuan(effectiveRemainingFen),
      platformLimited,
      recipientLimited,
      message: platformLimited ? LIMIT_MESSAGE : (recipientLimited ? '当日个人微信转账额度受限,请明日再申请' : '')
    }
  }

  async function reserveWechatApplicationQuota(tx, request, options = {}) {
    if (!request || request.payoutChannel !== 'wechat_wallet') return null
    const withdrawId = safeText(request._id || options.withdrawId).trim()
    if (!withdrawId) throw new Error('微信提现单号缺失')
    const amountFen = amountFenOf(request, options.amountFen)
    const recipientOpenid = safeText(request.recipientOpenid || request.staffOpenid || request.userOpenid || request.openid).trim()
    const time = now()
    const dateKey = toCstParts(time).dateKey
    const ids = scopeIds(dateKey, recipientOpenid)
    const existing = await readDoc(tx, 'wechat_transfer_quota_ledger', withdrawId)
    if (existing) return existing
    const settings = options.settings || await getSystemSettings()
    const config = getQuotaConfig(settings)
    const counters = await readCounters(tx, ids)
    assertQuotaAvailable(config, counters, amountFen)
    await setCounter(tx, 'wechat_transfer_quota_daily', ids.platformDailyId, { reservedFen: amountFen }, { scope: 'platform', dateKey })
    await setCounter(tx, 'wechat_transfer_quota_daily', ids.recipientDailyId, { reservedFen: amountFen }, { scope: 'recipient', dateKey, recipientOpenidHash: ids.recipientHash })
    const ledger = {
      withdrawId,
      assetType: safeText(request.assetType).trim() || 'staff',
      recipientOpenidHash: ids.recipientHash,
      amountFen,
      state: 'application_reserved',
      applicationDateKey: dateKey,
      successDateKey: '',
      outBillNo: safeText(request.outBillNo || request.outDetailNo).trim(),
      createdAt: time,
      updatedAt: time
    }
    await saveLedgerDoc(tx, withdrawId, ledger)
    return ledger
  }

  async function prepareWechatSubmissionQuota(tx, request, options = {}) {
    if (!request || request.payoutChannel !== 'wechat_wallet') return null
    const withdrawId = safeText(request._id || options.withdrawId).trim()
    const amountFen = amountFenOf(request, options.amountFen)
    const recipientOpenid = safeText(request.recipientOpenid || request.staffOpenid || request.userOpenid || request.openid).trim()
    const time = now()
    const dateKey = toCstParts(time).dateKey
    const ids = scopeIds(dateKey, recipientOpenid)
    let ledger = await readDoc(tx, 'wechat_transfer_quota_ledger', withdrawId)
    if (ledger && ledger.state === 'succeeded') return ledger
    if (ledger && ledger.state === 'in_flight') return ledger
    const settings = options.settings || await getSystemSettings()
    const config = getQuotaConfig(settings)
    const counters = await readCounters(tx, ids)
    const adjustedCounters = { ...counters }
    if (ledger && ledger.state === 'application_reserved' && ledger.applicationDateKey === dateKey) {
      adjustedCounters.platformUsedFen = Math.max(0, adjustedCounters.platformUsedFen - amountFen)
      adjustedCounters.recipientUsedFen = Math.max(0, adjustedCounters.recipientUsedFen - amountFen)
    }
    assertQuotaAvailable(config, adjustedCounters, amountFen)
    if (ledger && ledger.state === 'application_reserved') {
      const reservedIds = scopeIds(ledger.applicationDateKey || dateKey, recipientOpenid)
      await setCounter(tx, 'wechat_transfer_quota_daily', reservedIds.platformDailyId, { reservedFen: -amountFen }, { scope: 'platform', dateKey: reservedIds.dateKey })
      await setCounter(tx, 'wechat_transfer_quota_daily', reservedIds.recipientDailyId, { reservedFen: -amountFen }, { scope: 'recipient', dateKey: reservedIds.dateKey, recipientOpenidHash: ids.recipientHash })
    }
    await setCounter(tx, 'wechat_transfer_quota_inflight', ids.platformInflightId, { outstandingFen: amountFen }, { scope: 'platform' })
    await setCounter(tx, 'wechat_transfer_quota_inflight', ids.recipientInflightId, { outstandingFen: amountFen }, { scope: 'recipient', recipientOpenidHash: ids.recipientHash })
    ledger = {
      ...(ledger || {}),
      withdrawId,
      assetType: safeText(request.assetType).trim() || 'staff',
      recipientOpenidHash: ids.recipientHash,
      amountFen,
      state: 'in_flight',
      applicationDateKey: ledger?.applicationDateKey || dateKey,
      successDateKey: '',
      outBillNo: safeText(request.outBillNo || request.outDetailNo).trim(),
      updatedAt: time
    }
    if (!ledger.createdAt) ledger.createdAt = time
    await saveLedgerDoc(tx, withdrawId, ledger)
    return ledger
  }

  async function commitWechatTransferSuccessQuota(tx, request, result = {}) {
    if (!request || request.payoutChannel !== 'wechat_wallet') return null
    const withdrawId = safeText(request._id || result.withdrawId).trim()
    const ledger = await readDoc(tx, 'wechat_transfer_quota_ledger', withdrawId)
    if (ledger && ledger.state === 'succeeded') return ledger
    const amountFen = amountFenOf(request, ledger?.amountFen)
    const recipientOpenid = safeText(request.recipientOpenid || request.staffOpenid || request.userOpenid || request.openid).trim()
    const time = now()
    const successDateKey = toCstParts(time).dateKey
    const ids = scopeIds(successDateKey, recipientOpenid)
    if (ledger && ledger.state === 'application_reserved') {
      const reservedIds = scopeIds(ledger.applicationDateKey || successDateKey, recipientOpenid)
      await setCounter(tx, 'wechat_transfer_quota_daily', reservedIds.platformDailyId, { reservedFen: -amountFen }, { scope: 'platform', dateKey: reservedIds.dateKey })
      await setCounter(tx, 'wechat_transfer_quota_daily', reservedIds.recipientDailyId, { reservedFen: -amountFen }, { scope: 'recipient', dateKey: reservedIds.dateKey, recipientOpenidHash: ids.recipientHash })
    }
    if (ledger && ledger.state === 'in_flight') {
      await setCounter(tx, 'wechat_transfer_quota_inflight', 'platform', { outstandingFen: -amountFen }, { scope: 'platform' })
      await setCounter(tx, 'wechat_transfer_quota_inflight', `recipient:${ids.recipientHash}`, { outstandingFen: -amountFen }, { scope: 'recipient', recipientOpenidHash: ids.recipientHash })
    }
    await setCounter(tx, 'wechat_transfer_quota_daily', ids.platformDailyId, { successfulFen: amountFen }, { scope: 'platform', dateKey: successDateKey })
    await setCounter(tx, 'wechat_transfer_quota_daily', ids.recipientDailyId, { successfulFen: amountFen }, { scope: 'recipient', dateKey: successDateKey, recipientOpenidHash: ids.recipientHash })
    const nextLedger = {
      ...(ledger || {}),
      withdrawId,
      assetType: safeText(request.assetType).trim() || 'staff',
      recipientOpenidHash: ids.recipientHash,
      amountFen,
      state: 'succeeded',
      applicationDateKey: ledger?.applicationDateKey || successDateKey,
      successDateKey,
      outBillNo: safeText(result.outBillNo || result.transferBillNo || request.outBillNo || request.outDetailNo).trim(),
      updatedAt: time
    }
    if (!nextLedger.createdAt) nextLedger.createdAt = time
    await saveLedgerDoc(tx, withdrawId, nextLedger)
    return nextLedger
  }

  async function releaseWechatTransferQuota(tx, request, reason = '') {
    if (!request || request.payoutChannel !== 'wechat_wallet') return null
    const withdrawId = safeText(request._id).trim()
    const ledger = await readDoc(tx, 'wechat_transfer_quota_ledger', withdrawId)
    if (!ledger || ledger.state === 'released' || ledger.state === 'succeeded') return ledger
    const amountFen = Number(ledger.amountFen || request.amountFen || Math.round(Number(request.amount || 0) * 100))
    const recipientOpenid = safeText(request.recipientOpenid || request.staffOpenid || request.userOpenid || request.openid).trim()
    const ids = scopeIds(ledger.applicationDateKey || toCstParts(now()).dateKey, recipientOpenid)
    if (ledger.state === 'application_reserved') {
      await setCounter(tx, 'wechat_transfer_quota_daily', ids.platformDailyId, { reservedFen: -amountFen }, { scope: 'platform', dateKey: ids.dateKey })
      await setCounter(tx, 'wechat_transfer_quota_daily', ids.recipientDailyId, { reservedFen: -amountFen }, { scope: 'recipient', dateKey: ids.dateKey, recipientOpenidHash: ids.recipientHash })
    }
    if (ledger && ledger.state === 'in_flight') {
      await setCounter(tx, 'wechat_transfer_quota_inflight', 'platform', { outstandingFen: -amountFen }, { scope: 'platform' })
      await setCounter(tx, 'wechat_transfer_quota_inflight', `recipient:${ids.recipientHash}`, { outstandingFen: -amountFen }, { scope: 'recipient', recipientOpenidHash: ids.recipientHash })
    }
    const nextLedger = { ...ledger, state: 'released', releaseReason: safeText(reason).slice(0, 200), updatedAt: now() }
    await saveLedgerDoc(tx, withdrawId, nextLedger)
    return nextLedger
  }

  return {
    WECHAT_TRANSFER_QUOTA_LIMIT_MESSAGE: LIMIT_MESSAGE,
    getWechatTransferQuotaConfig: getQuotaConfig,
    getWechatTransferQuotaOverview,
    getWechatTransferQuotaSnapshot,
    reserveWechatApplicationQuota,
    prepareWechatSubmissionQuota,
    commitWechatTransferSuccessQuota,
    releaseWechatTransferQuota
  }
}
