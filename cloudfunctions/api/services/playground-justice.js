const { transaction } = require('./playground-transaction')
const { readDocument } = require('./playground-world')

const ACCIDENTS_COLLECTION = 'pet_playground_accidents'
const JAIL_COLLECTION = 'pet_playground_jail'
const PLOTS_COLLECTION = 'pet_playground_plots'
const JAIL_DURATION_MS = 60 * 1000 // 默认拘留 60 秒
const BAIL_COINS = 100 // 保释金 100 金币

module.exports = function createJusticeService(context) {
  const { db } = context
  const now = () => (context.nowMs ? context.nowMs() : Date.now())

  // 获取社区内的执法所与监狱建筑
  async function getJusticeFacilities(communityId) {
    const rows = await db
      .collection(PLOTS_COLLECTION)
      .where({ communityId })
      .get()
    const list = rows.data || []
    return {
      policeStation: list.find((p) => p.buildingType === 'police_station' && !p.demolished) || null,
      prison: list.find((p) => p.buildingType === 'prison' && !p.demolished) || null
    }
  }

  // 1. 上报车辆撞击交通事故
  async function reportAccident(openid, user, data) {
    const sceneId = String(data.sceneId || '')
    const victimType = data.victimType === 'pet' ? 'pet' : 'human'
    const victimName = String(data.victimName || (victimType === 'pet' ? '爱宠' : '居民')).slice(0, 20)
    const driverOpenid = String(data.driverOpenid || openid)
    const driverName = String(data.driverName || user.nickname || '某车主').slice(0, 20)
    const stamp = now()

    const accidentId = `acc_${stamp.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const record = {
      communityId: sceneId,
      victimType,
      victimName,
      victimOpenid: openid,
      driverOpenid,
      driverName,
      location: {
        x: Number(data.x) || 0,
        z: Number(data.z) || 0
      },
      status: 'wanted', // wanted (被通缉/待处理) | arrested (已逮捕羁押) | settled (已调解/已服刑)
      createdAt: stamp,
      fineAmount: 100
    }

    return transaction(db, async (tx) => {
      await tx.collection(ACCIDENTS_COLLECTION).doc(accidentId).set({ data: record })
      return {
        accidentId,
        reported: true,
        record: { ...record, _id: accidentId },
        message: `车辆碰撞事件已向文明督导所备案！已记录车主 ${driverName} 的文明出行劝导提醒`
      }
    })
  }

  // 2. 查询社区案件列表与执法所状态
  async function listAccidents(openid, data) {
    const sceneId = String(data.sceneId || '')
    const stamp = now()

    const facilities = await getJusticeFacilities(sceneId)
    const accidentRows = await db
      .collection(ACCIDENTS_COLLECTION)
      .where({ communityId: sceneId })
      .get()

    // 检查自己的羁押服刑状态
    const jailRow = await readDocument(db, JAIL_COLLECTION, openid, '检查羁押状态', true)
    let isJailed = false
    let jailRemainingSeconds = 0

    if (jailRow && jailRow.jailed) {
      if (stamp < jailRow.jailedUntil) {
        isJailed = true
        jailRemainingSeconds = Math.max(1, Math.ceil((jailRow.jailedUntil - stamp) / 1000))
      } else {
        // 刑期自动结束
        await db.collection(JAIL_COLLECTION).doc(openid).update({ data: { jailed: false } }).catch(() => {})
      }
    }

    return {
      hasPoliceStation: !!facilities.policeStation,
      hasPrison: !!facilities.prison,
      policeStationOwner: (facilities.policeStation && facilities.policeStation.ownerName) || '',
      prisonOwner: (facilities.prison && facilities.prison.ownerName) || '',
      accidents: accidentRows.data || [],
      isJailed,
      jailRemainingSeconds,
      bailCoins: BAIL_COINS
    }
  }

  // 3. 执法所逮捕肇事司机并收押进社区监狱
  async function arrestDriver(openid, user, data) {
    const sceneId = String(data.sceneId || '')
    const accidentId = String(data.accidentId || '')
    const stamp = now()

    return transaction(db, async (tx) => {
      const facilities = await getJusticeFacilities(sceneId)
      if (!facilities.policeStation) {
        throw new Error('当前社区尚未设立文明督导所，请先在社区建造文明督导所')
      }
      if (!facilities.prison) {
        throw new Error('当前社区尚未设立安全宣教自省室，无法安排安全宣教学习，请先建造安全宣教自省室')
      }

      const accident = await readDocument(tx, ACCIDENTS_COLLECTION, accidentId, '读取事故记录', true)
      if (!accident || accident.status !== 'wanted') {
        throw new Error('该记录已处理或不存在')
      }

      const targetDriverOpenid = accident.driverOpenid
      const jailedUntil = stamp + JAIL_DURATION_MS

      // 更新事故状态
      await tx.collection(ACCIDENTS_COLLECTION).doc(accidentId).update({
        data: {
          status: 'arrested',
          arrestedAt: stamp,
          arrestedBy: openid,
          officerName: String(user.nickname || '社区督导员').slice(0, 20)
        }
      })

      // 将当事人安排进宣教自省室
      await tx.collection(JAIL_COLLECTION).doc(targetDriverOpenid).set({
        data: {
          communityId: sceneId,
          jailed: true,
          jailedAt: stamp,
          jailedUntil,
          driverName: accident.driverName,
          prisonPlotId: facilities.prison._id,
          prisonPosition: { x: facilities.prison.x, z: facilities.prison.z },
          reason: `因车辆碰撞【${accident.victimName}】，安排在宣教自省室学习`
        }
      })

      // 扣押重置肇事车辆与司机 presence
      const carId = require('./playground-shared/vehicles').vehicleId(targetDriverOpenid)
      const car = await readDocument(tx, PLOTS_COLLECTION, carId, '读取车辆', true)
      if (car && car.state === 'driving') {
        await tx.collection(PLOTS_COLLECTION).doc(carId).update({
          data: {
            state: 'parked',
            moving: false,
            passengers: [],
            revision: stamp
          }
        })
      }
      const pId = 'presence_' + require('./playground-world').hash(targetDriverOpenid)
      const actor = await readDocument(tx, PLOTS_COLLECTION, pId, '读取角色', true)
      if (actor && actor.vehicleId) {
        await tx.collection(PLOTS_COLLECTION).doc(pId).update({
          data: {
            vehicleId: '',
            vehicleRole: '',
            moving: false
          }
        })
      }

      return {
        arrested: true,
        driverOpenid: targetDriverOpenid,
        jailedUntil,
        prisonPosition: { x: facilities.prison.x, z: facilities.prison.z },
        message: `文明督导所已安排车主 ${accident.driverName} 前往宣教自省室进行安全宣教自省学习 60 秒`
      }
    })
  }

  // 4. 出自省室与缴纳安全公约金
  async function releaseDriver(openid, data) {
    const stamp = now()
    const payBail = data.payBail === true

    return transaction(db, async (tx) => {
      const jailRow = await readDocument(tx, JAIL_COLLECTION, openid, '读取自省状态', true)
      if (!jailRow || !jailRow.jailed) {
        return { released: true, message: '您当前未处于宣教自省状态' }
      }

      if (!payBail && stamp < jailRow.jailedUntil) {
        const remaining = Math.ceil((jailRow.jailedUntil - stamp) / 1000)
        throw new Error(`安全宣教自省期未满，还需宣教自省 ${remaining} 秒，或可交存 ${BAIL_COINS} 爱心币安全公约金提前恢复通行`)
      }

      await tx.collection(JAIL_COLLECTION).doc(openid).update({
        data: {
          jailed: false,
          releasedAt: stamp,
          releasedBy: payBail ? 'bail' : 'served_time'
        }
      })

      return {
        released: true,
        message: payBail ? `成功交存安全公约金 ${BAIL_COINS} 爱心币，已提前结束宣教自省，恢复正常通行！` : '安全宣教自省期满，已恢复正常通行！'
      }
    })
  }

  // 5. 医院救治人或宠物
  async function hospitalTreat(openid, user, data) {
    const target = data.target === 'pet' ? 'pet' : 'human'
    const sceneId = String(data.sceneId || '')
    const stamp = now()

    return transaction(db, async (tx) => {
      const facilities = await db
        .collection(PLOTS_COLLECTION)
        .where({ communityId: sceneId, buildingType: 'pet_hospital' })
        .get()
      const hasHospital = facilities.data && facilities.data.length > 0

      if (target === 'human') {
        return {
          treated: true,
          target: 'human',
          message: '已在爱心医院接受专业调理舒缓，身体不适已消除，体力充沛，恢复奔跑！'
        }
      } else {
        return {
          treated: true,
          target: 'pet',
          message: '爱宠在宠物医院完成了全面健康调理与状态恢复，已彻底恢复健康，精神满满！'
        }
      }
    })
  }

  return {
    reportAccident,
    listAccidents,
    arrestDriver,
    releaseDriver,
    hospitalTreat,
    getJusticeFacilities
  }
}
