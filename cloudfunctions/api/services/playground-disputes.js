const { transaction } = require('./playground-transaction')
const { readDocument } = require('./playground-world')

const DISPUTES_COLLECTION = 'pet_playground_disputes'
const PLOTS_COLLECTION = 'pet_playground_plots'
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000

module.exports = function createDisputesService(context) {
  const { db } = context
  const now = () => (context.nowMs ? context.nowMs() : Date.now())

  // 获取居委会建筑配置
  async function getCommitteeConfig() {
    const buildingsService = require('./playground-buildings')(context)
    const catalog = await buildingsService.readCatalog()
    const committee = (catalog.buildings || []).find((b) => b.type === 'committee')
    return {
      weeklySalary: (committee && committee.weeklySalary) || 200,
      resolveReward: (committee && committee.resolveReward) || 20
    }
  }

  // 获取社区内当前的居委会地块/建筑
  async function getCommunityCommittee(communityId) {
    const rows = await db
      .collection(PLOTS_COLLECTION)
      .where({ communityId, buildingType: 'committee' })
      .get()
    const list = rows.data || []
    return list.find((p) => !p.demolished) || null
  }

  // 1. 举报便便
  async function reportPoop(openid, user, data) {
    const poopId = String(data.poopId || '')
    const sceneId = String(data.sceneId || '')
    if (!poopId || !sceneId) throw new Error('举报参数不完整')

    const config = await getCommitteeConfig()
    const stamp = now()

    return transaction(db, async (tx) => {
      // 防止对同一个便便重复举报
      const existing = await tx
        .collection(DISPUTES_COLLECTION)
        .where({ poopId, status: 'pending' })
        .get()
      if (existing.data && existing.data.length > 0) {
        throw new Error('该便便已被其他邻居举报，居委会正在排队处理中')
      }

      const disputeId = `disp_${stamp.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const dispute = {
        _id: disputeId,
        communityId: sceneId,
        poopId,
        location: {
          x: Number(data.x) || 0,
          z: Number(data.z) || 0
        },
        reporterOpenid: openid,
        reporterName: String(user.nickname || '热心邻居').slice(0, 20),
        suspectOpenid: String(data.suspectOpenid || ''),
        suspectName: String(data.suspectName || '某宠物主人').slice(0, 20),
        petName: String(data.petName || '宠物').slice(0, 20),
        status: 'pending',
        createdAt: stamp,
        deadline: stamp + THREE_DAYS_MS,
        fineAmount: 50,
        rewardAmount: 30,
        committeeReward: config.resolveReward,
        message: '路边便便未及时清理，影响社区卫生环境'
      }

      const { _id, ...disputeData } = dispute
      await tx.collection(DISPUTES_COLLECTION).doc(disputeId).set({ data: disputeData })
      return { dispute, disputeId, reported: true, message: '举报成功，已通知社区居委会处理' }
    })
  }

  // 2. 查询社区纠纷列表并检查 3 天超时自动弹劾
  async function listDisputes(openid, data) {
    const sceneId = String(data.sceneId || '')
    const stamp = now()

    // 检查超时纠纷
    await checkCommitteeTimeout(sceneId, stamp)

    const result = await db
      .collection(DISPUTES_COLLECTION)
      .where({ communityId: sceneId })
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get()

    const committee = await getCommunityCommittee(sceneId)
    const isCommittee = committee && committee.ownerOpenid === openid

    return {
      disputes: result.data || [],
      isCommittee: !!isCommittee,
      committeeOwnerName: (committee && committee.ownerName) || '',
      serverTime: stamp
    }
  }

  // 检查是否有纠纷超过 3 天未处理，若超时则收回居委会房屋
  async function checkCommitteeTimeout(communityId, stamp = now()) {
    const expiredRows = await db
      .collection(DISPUTES_COLLECTION)
      .where({ communityId, status: 'pending' })
      .get()

    const timeoutItems = (expiredRows.data || []).filter((d) => stamp > d.deadline)
    if (timeoutItems.length === 0) return null

    return transaction(db, async (tx) => {
      // 标记超时
      for (const item of timeoutItems) {
        await tx
          .collection(DISPUTES_COLLECTION)
          .doc(item._id)
          .update({ data: { status: 'expired', expiredAt: stamp } })
      }

      // 收回/弹劾居委会房子及任期
      const committeeRows = await tx
        .collection(PLOTS_COLLECTION)
        .where({ communityId, buildingType: 'committee' })
        .get()
      for (const cDoc of (committeeRows.data || [])) {
        const restoredName = `${cDoc.ownerName || '邻居'}的庭院`
        await tx.collection(PLOTS_COLLECTION).doc(cDoc._id).update({
          data: {
            buildingType: 'residential',
            buildingName: '住宅洋房',
            name: restoredName,
            committeeRevoked: true,
            revokedAt: stamp,
            revokedReason: '存在超过3天未处理的社区便便纠纷，居委会已被自动收回'
          }
        })
      }
      return { revoked: true, timeoutCount: timeoutItems.length }
    })
  }

  // 3. 居委会调解处理纠纷
  async function resolveDispute(openid, user, data) {
    const disputeId = String(data.disputeId || '')
    const sceneId = String(data.sceneId || '')
    const stamp = now()

    return transaction(db, async (tx) => {
      const committee = await getCommunityCommittee(sceneId)
      if (!committee || committee.ownerOpenid !== openid) {
        throw new Error('只有当前社区的在任居委会才能上门处理纠纷')
      }

      const dispute = await readDocument(tx, DISPUTES_COLLECTION, disputeId, '读取纠纷', true)
      if (!dispute || dispute.status !== 'pending') {
        throw new Error('该纠纷已处理或不存在')
      }

      if (stamp > dispute.deadline) {
        await tx
          .collection(DISPUTES_COLLECTION)
          .doc(disputeId)
          .update({ data: { status: 'expired', expiredAt: stamp } })
        throw new Error('该纠纷已超过3天未处理，已超时失效并触发居委会责任收回')
      }

      // 更新纠纷状态
      await tx.collection(DISPUTES_COLLECTION).doc(disputeId).update({
        data: {
          status: 'resolved',
          resolvedAt: stamp,
          resolvedBy: openid,
          resolverName: String(user.nickname || '居委会主任').slice(0, 20)
        }
      })

      return {
        resolved: true,
        disputeId,
        rewardReceived: dispute.committeeReward || 20,
        message: `督导完成！已督促规范文明养宠行为并奖励提醒人，居委会获得爱心币奖励 ${dispute.committeeReward || 20}`
      }
    })
  }

  // 4. 居委会领取社区共建津贴
  async function claimWeeklySalary(openid, data) {
    const sceneId = String(data.sceneId || '')
    const stamp = now()

    return transaction(db, async (tx) => {
      const committee = await getCommunityCommittee(sceneId)
      if (!committee || committee.ownerOpenid !== openid) {
        throw new Error('只有当前社区在任居委会才能领取社区共建津贴')
      }

      const startedAt = committee.createdAtStamp || (committee.createdAt ? new Date(committee.createdAt).getTime() : stamp)
      const lastClaim = committee.lastSalaryClaimAt || startedAt
      if (stamp - lastClaim < SEVEN_DAYS_MS) {
        const daysLeft = Math.ceil((SEVEN_DAYS_MS - (stamp - lastClaim)) / 86400000)
        throw new Error(`成功履职满一周方可领取共建津贴，还差约 ${daysLeft} 天`)
      }

      const config = await getCommitteeConfig()
      await tx.collection(PLOTS_COLLECTION).doc(committee._id).update({
        data: { lastSalaryClaimAt: stamp }
      })

      return {
        claimed: true,
        salary: config.weeklySalary,
        message: `成功领取居委会社区共建津贴 ${config.weeklySalary} 爱心币！`
      }
    })
  }

  // 发放爱心币津贴与奖励
  async function awardCoins(tx, targetOpenid, amount) {
    if (!targetOpenid || amount <= 0) return
    const userRes = await tx.collection('users').where({ openid: targetOpenid }).limit(1).get()
    const targetUser = (userRes.data || [])[0]
    if (targetUser) {
      await tx.collection('users').doc(targetUser._id).update({
        data: {
          playgroundCoins: (targetUser.playgroundCoins || 0) + amount
        }
      })
    }
  }

  // 获取社区内的指定公共建筑（优先匹配指定communityId，降级fallback）
  async function getCommunityBuilding(communityId, buildingType) {
    const rows = await db
      .collection(PLOTS_COLLECTION)
      .where({ buildingType })
      .get()
    const list = (rows.data || []).filter((p) => !p.demolished)
    if (communityId) {
      const match = list.find((p) => p.communityId === communityId)
      if (match) return match
    }
    return list[0] || null
  }

  // 5. 修理厂洗车服务（带房东收益）
  async function washVehicle(openid, user, data) {
    const sceneId = String(data.sceneId || '')
    const targetVehicleId = String(data.vehicleId || require('./playground-shared/vehicles').vehicleId(openid))

    return transaction(db, async (tx) => {
      const car = await readDocument(tx, PLOTS_COLLECTION, targetVehicleId, '读取车辆', true)
      if (car) {
        await tx.collection(PLOTS_COLLECTION).doc(targetVehicleId).update({
          data: {
            stains: [],
            soiled: false,
            cleanedAt: now()
          }
        })
      }

      let bonusMsg = ''
      const repairShop = await getCommunityBuilding(sceneId, 'repair_shop')
      if (repairShop && repairShop.ownerOpenid && repairShop.ownerOpenid !== openid) {
        await awardCoins(tx, repairShop.ownerOpenid, 10)
        bonusMsg = '，已向修理厂主理人发放 10 爱心币服务津贴'
      }

      return {
        washed: true,
        message: `洗车保养完成！车身光洁如新，已消除[肮脏]状态${bonusMsg}`
      }
    })
  }

  // 6. 修理厂全面检修保养服务（带房东收益）
  async function repairVehicle(openid, user, data) {
    const sceneId = String(data.sceneId || '')
    return transaction(db, async (tx) => {
      let bonusMsg = ''
      const repairShop = await getCommunityBuilding(sceneId, 'repair_shop')
      if (repairShop && repairShop.ownerOpenid && repairShop.ownerOpenid !== openid) {
        await awardCoins(tx, repairShop.ownerOpenid, 10)
        bonusMsg = '，已向修理厂主理人发放 10 爱心币检修津贴'
      }
      return {
        success: true,
        message: `车辆经过社区修理厂全面检修，制动、轮胎与引擎性能已恢复至最佳状态${bonusMsg}！`
      }
    })
  }

  return {
    reportPoop,
    listDisputes,
    resolveDispute,
    checkCommitteeTimeout,
    claimWeeklySalary,
    washVehicle,
    repairVehicle,
    getCommunityCommittee,
    getCommunityBuilding
  }
}
