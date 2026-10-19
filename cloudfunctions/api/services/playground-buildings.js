const {levelIds,validateLevels}=require('./playground-access')
const crypto = require('crypto')
const { transaction } = require('./playground-transaction')
const { readDocument } = require('./playground-world')

const COLLECTION = 'platform_configs'
const ID = 'playground_buildings_catalog_v1'
const UPLOAD_PATH = 'packagePlayground/2d/baseImage/buildings/custom/'
const DEFAULT_PLOT_SIZES=[36,48,64,80,112].map((size)=>({size,label:`${size}×${size} 米绿地`,unlockLevelIds:[]}))
const GRASS_TILE_SIZE = 3.5 // 单块草地标准尺寸 3.5m x 3.5m = 12.25 平方米

const DEFAULT_BUILDINGS = [
  {
    id: 'repair_shop_default',
    name: '社区修理厂',
    type: 'repair_shop',
    desc: '可为车辆洗车清洁、维修保养，清除车名[肮脏]状态',
    width: 7,
    depth: 7,
    tileCount: 4,
    costCoins: 0,
    image: '',
    enabled: true
  },
  {
    id: 'committee_default',
    name: '社区居委会',
    type: 'committee',
    desc: '每个社区唯一自治机构，处理路面未清理便便反馈，督促文明养宠并给予爱心奖励；若3天未处理将重新推选',
    width: 7,
    depth: 7,
    tileCount: 4,
    costCoins: 0,
    weeklySalary: 20,
    resolveReward: 10,
    image: '',
    enabled: true
  },
  {
    id: 'pet_hospital_default',
    name: '爱心宠物医院',
    type: 'pet_hospital',
    desc: '提供宠物专业洗护、健康体检调理与状态恢复',
    width: 7,
    depth: 7,
    tileCount: 4,
    costCoins: 0,
    image: '',
    enabled: true
  },
  {
    id: 'residential_wood_cabin',
    name: '田园小木屋',
    type: 'residential',
    desc: '温馨舒适的户外庭院小屋，可作为私家庭院或户外安顿点',
    width: 7,
    depth: 7,
    tileCount: 4,
    costCoins: 0,
    image: '',
    enabled: true
  },
  {
    id: 'police_station_default',
    name: '文明督导所',
    type: 'police_station',
    desc: '维护社区交通出行秩序，处理碰撞摩擦事件，开展文明出行宣传与安全劝导',
    width: 7,
    depth: 7,
    tileCount: 4,
    costCoins: 0,
    image: '',
    enabled: true
  },
  {
    id: 'prison_default',
    name: '安全宣教自省室',
    type: 'prison',
    desc: '违规驾驶宣教与自省学习场所，宣教学习期间在指定区域静思自省',
    width: 7,
    depth: 7,
    tileCount: 4,
    costCoins: 0,
    image: '',
    enabled: true
  }
]

const validId = (id) =>
  typeof id === 'string' &&
  /^[a-z][a-z0-9_-]{0,39}$/.test(id) &&
  !['constructor', 'prototype', '__proto__'].includes(id)

function calcTileCount(width, depth) {
  const area = (width || 0) * (depth || 0)
  const singleTileArea = GRASS_TILE_SIZE * GRASS_TILE_SIZE
  return Math.max(1, Math.round((area / singleTileArea) * 10) / 10)
}

async function readCatalog(db) {
  const row = await readDocument(db, COLLECTION, ID, '读取建筑配置', true)
  return {revision:row?row.revision:0,
    buildings:(row?row.buildings:DEFAULT_BUILDINGS).map((item)=>({...item,costCoins:0,unlockLevelIds:item.unlockLevelIds||[],
      washPoints:Number.isInteger(item.washPoints)?item.washPoints:10,
      reportPoints:Number.isInteger(item.reportPoints)?item.reportPoints:5,
      resolveReward:(!row||row.rewardsVersion===2)&&Number.isInteger(item.resolveReward)?item.resolveReward:10,
      weeklySalary:(!row||row.rewardsVersion===2)&&Number.isInteger(item.weeklySalary)?item.weeklySalary:20})),
    plotSizes:row&&row.plotSizes||DEFAULT_PLOT_SIZES}

}

function pointAmount(value,fallback) {
  if(value===undefined)return fallback
  if(!Number.isInteger(value)||value<0||value>1000)throw new Error('奖励积分须为0至1000之间的整数')
  return value
}
function normalizeBuilding(value) {
  if (!value || !validId(value.id))
    throw new Error('建筑编号须以小写字母开头，最多40位字母、数字、横线或下划线')
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name || name.length > 30) throw new Error('建筑名称须为1至30个字符')

  const validTypes = ['residential', 'repair_shop', 'pet_hospital', 'committee', 'police_station', 'prison']
  if (!validTypes.includes(value.type)) throw new Error('无效的建筑功能类型')

  const width = Math.max(3.5, Math.min(35, Number(value.width) || 7))
  const depth = Math.max(3.5, Math.min(35, Number(value.depth) || 7))
  const tileCount = calcTileCount(width, depth)
  const costCoins = 0

  const building = {
    id: value.id,
    name,
    type: value.type,
    desc: typeof value.desc === 'string' ? value.desc.trim().slice(0, 120) : '',
    width,
    depth,
    tileCount,
    costCoins,
    unlockLevelIds:levelIds(value.unlockLevelIds),
    image: typeof value.image === 'string' ? value.image.trim() : '',
    enabled: value.enabled !== false
  }

  if(value.type==='repair_shop') building.washPoints=pointAmount(value.washPoints,10)
  if (value.type === 'committee') {
    building.reportPoints=pointAmount(value.reportPoints,5)
    building.weeklySalary = pointAmount(value.weeklySalary,20)
    building.resolveReward = pointAmount(value.resolveReward,10)
  }

  return building
}

module.exports = function createBuildingsService(context) {
  const { db } = context
  const now = () => (context.nowMs ? context.nowMs() : Date.now())

  async function list() {
    return {...await readCatalog(db),levels:(await db.collection('member_levels').orderBy('minPoints','asc').get()).data||[]}
  }

  async function prepareUpload(openid, data) {
    if (!validId(data.id)) throw new Error('请先填写有效的建筑编号')
    return {
      cloudPath: `${UPLOAD_PATH}${data.id}/${crypto.randomBytes(16).toString('hex')}.png`
    }
  }

  async function save(openid, data) {
    const item = normalizeBuilding(data.building)
    await validateLevels(db,item.unlockLevelIds)
    return transaction(db, async (tx) => {
      const current = await readCatalog(tx)
      if (current.revision !== data.revision) {
        throw new Error('配置已被其他管理员更新，请刷新后重新编辑')
      }
      const exists = current.buildings.some((b) => b.id === item.id)
      const buildings = exists
        ? current.buildings.map((b) => (b.id === item.id ? item : b))
        : current.buildings.concat(item)
      const next = {
        rewardsVersion:2,plotSizes:current.plotSizes,
        revision: (current.revision || 0) + 1,
        buildings,
        updatedBy: openid,
        updatedAt: now()
      }
      await tx.collection(COLLECTION).doc(ID).set({ data: next })
      return { revision: next.revision, buildings,plotSizes:current.plotSizes }
    })
  }

  async function remove(openid, data) {
    const id = String(data.id || '')
    return transaction(db, async (tx) => {
      const current = await readCatalog(tx)
      if(current.revision!==data.revision)throw new Error('配置已被其他管理员更新，请刷新后重新编辑')
      const buildings = current.buildings.filter((b) => b.id !== id)
      const next = {
        rewardsVersion:2,plotSizes:current.plotSizes,
        revision: (current.revision || 0) + 1,
        buildings,
        updatedBy: openid,
        updatedAt: now()
      }
      await tx.collection(COLLECTION).doc(ID).set({ data: next })
      return { revision: next.revision, buildings,plotSizes:current.plotSizes }
    })
  }

  async function savePlotAccess(openid,data) {
    const size=Number(data.size)
    if(!DEFAULT_PLOT_SIZES.some((p)=>p.size===size))throw new Error('无效的绿地规格')
    const ids=levelIds(data.unlockLevelIds)
    await validateLevels(db,ids)
    return transaction(db,async(tx)=>{
      const current=await readCatalog(tx)
      if(current.revision!==data.revision)throw new Error('配置已更新，请刷新后重试')
      const plotSizes=DEFAULT_PLOT_SIZES.map((p)=>({...p,...current.plotSizes.find((v)=>v.size===p.size),...(p.size===size?{unlockLevelIds:ids}:{})}))
      const next={...current,rewardsVersion:2,plotSizes,revision:current.revision+1,updatedBy:openid,updatedAt:now()}
      await tx.collection(COLLECTION).doc(ID).set({data:next})
      return next
    })
  }
  return {
    savePlotAccess,
    list,
    save,
    remove,
    prepareUpload,
    readCatalog: () => readCatalog(db)
  }
}

module.exports.DEFAULT_PLOT_SIZES=DEFAULT_PLOT_SIZES
