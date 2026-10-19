const crypto = require('crypto')
const { transaction } = require('./playground-transaction')
const { readDocument } = require('./playground-world')

const COLLECTION = 'platform_configs'
const ID = 'playground_buildings_catalog_v1'
const UPLOAD_PATH = 'packagePlayground/2d/baseImage/buildings/custom/'
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
    costCoins: 100,
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
    costCoins: 200,
    weeklySalary: 200,
    resolveReward: 20,
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
    costCoins: 150,
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
    costCoins: 80,
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
    costCoins: 220,
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
    costCoins: 180,
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
  return row
    ? { revision: row.revision, buildings: row.buildings }
    : { revision: 0, buildings: DEFAULT_BUILDINGS }
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
  const costCoins = Math.max(0, Math.min(1000000, Math.floor(Number(value.costCoins) || 0)))

  const building = {
    id: value.id,
    name,
    type: value.type,
    desc: typeof value.desc === 'string' ? value.desc.trim().slice(0, 120) : '',
    width,
    depth,
    tileCount,
    costCoins,
    image: typeof value.image === 'string' ? value.image.trim() : '',
    enabled: value.enabled !== false
  }

  if (value.type === 'committee') {
    building.weeklySalary = Math.max(0, Math.min(100000, Math.floor(Number(value.weeklySalary) || 200)))
    building.resolveReward = Math.max(0, Math.min(10000, Math.floor(Number(value.resolveReward) || 20)))
  }

  return building
}

module.exports = function createBuildingsService(context) {
  const { db } = context
  const now = () => (context.nowMs ? context.nowMs() : Date.now())

  async function list() {
    return readCatalog(db)
  }

  async function prepareUpload(openid, data) {
    if (!validId(data.id)) throw new Error('请先填写有效的建筑编号')
    return {
      cloudPath: `${UPLOAD_PATH}${data.id}/${crypto.randomBytes(16).toString('hex')}.png`
    }
  }

  async function save(openid, data) {
    const item = normalizeBuilding(data.building)
    return transaction(db, async (tx) => {
      const current = await readCatalog(tx)
      if (typeof data.revision === 'number' && current.revision !== data.revision) {
        throw new Error('配置已被其他管理员更新，请刷新后重新编辑')
      }
      const exists = current.buildings.some((b) => b.id === item.id)
      const buildings = exists
        ? current.buildings.map((b) => (b.id === item.id ? item : b))
        : current.buildings.concat(item)
      const next = {
        revision: (current.revision || 0) + 1,
        buildings,
        updatedBy: openid,
        updatedAt: now()
      }
      await tx.collection(COLLECTION).doc(ID).set({ data: next })
      return { revision: next.revision, buildings }
    })
  }

  async function remove(openid, data) {
    const id = String(data.id || '')
    return transaction(db, async (tx) => {
      const current = await readCatalog(tx)
      const buildings = current.buildings.filter((b) => b.id !== id)
      const next = {
        revision: (current.revision || 0) + 1,
        buildings,
        updatedBy: openid,
        updatedAt: now()
      }
      await tx.collection(COLLECTION).doc(ID).set({ data: next })
      return { revision: next.revision, buildings }
    })
  }

  return {
    list,
    save,
    remove,
    prepareUpload,
    readCatalog: () => readCatalog(db)
  }
}
