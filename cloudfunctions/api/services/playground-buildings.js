const {levelIds,validateLevels}=require('./playground-access')
const crypto = require('crypto')
const { transaction } = require('./playground-transaction')
const { readDocument, ownerId, read } = require('./playground-world')
const { placedBuildings, withBuildings } = require('./playground-shared/plot-buildings')

function projectionPatch(plot, buildings) {
  const projected = withBuildings(plot, buildings)
  const keys = ['buildings', 'buildingId', 'buildingType', 'buildingCategory', 'buildingName', 'buildingImage', 'buildingWidth', 'buildingDepth', 'buildingX', 'buildingZ', 'buildingOffsetX', 'buildingOffsetZ', 'name']
  const patch = Object.fromEntries(keys.map((key) => [key, projected[key]]))
  if (projected.buildingType !== 'committee') Object.assign(patch, { committeeStartedAt: 0, lastSalaryClaimAt: 0 })
  return patch
}

const COLLECTION = 'platform_configs'
const ID = 'playground_buildings_catalog_v1'
const UPLOAD_PATH = 'packagePlayground/2d/baseImage/buildings/custom/'
const DEFAULT_PLOT_SIZES=[36,48,64,80,112].map((size)=>({size,label:`${size}×${size} 米绿地`,unlockLevelIds:[]}))
const GRASS_TILE_SIZE = 3.5 // 单块草地标准尺寸 3.5m x 3.5m = 12.25 平方米

const VALID_CATEGORIES = ['public', 'residential', 'floor', 'tree', 'decoration']

function deriveCategory(type, explicitCategory) {
  if (explicitCategory && VALID_CATEGORIES.includes(explicitCategory)) {
    return explicitCategory
  }
  if (type === 'floor' || (typeof type === 'string' && type.startsWith('floor_'))) return 'floor'
  if (type === 'tree' || (typeof type === 'string' && (type.startsWith('tree_') || type.startsWith('landscape_')))) return 'tree'
  if (['committee', 'repair_shop', 'pet_hospital', 'police_station', 'prison'].includes(type)) return 'public'
  if (['residential', 'wood_cabin'].includes(type)) return 'residential'
  if (type === 'decoration') return 'decoration'
  return 'decoration'
}

const DEFAULT_BUILDINGS = [
  {
    id: 'repair_shop_default',
    name: '社区修理厂',
    type: 'repair_shop',
    category: 'public',
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
    category: 'public',
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
    category: 'public',
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
    type: 'wood_cabin',
    category: 'residential',
    desc: '温馨舒适的户外庭院小屋，可建于空余专属绿地作为户外度假安顿点',
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
    category: 'public',
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
    category: 'public',
    desc: '违规驾驶宣教与自省学习场所，宣教学习期间在指定区域静思自省',
    width: 7,
    depth: 7,
    tileCount: 4,
    costCoins: 0,
    image: '',
    enabled: true
  },
  {
    id: 'floor_stone_tile_default',
    name: '古朴石板地坪',
    type: 'floor',
    category: 'floor',
    desc: '平整耐磨的户外石板铺装地坪，为庭院与步道铺设坚实美观的地面',
    width: 7,
    depth: 7,
    tileCount: 4,
    costCoins: 0,
    image: '',
    enabled: true
  },
  {
    id: 'floor_wood_deck_default',
    name: '暖阳防腐木地台',
    type: 'floor',
    category: 'floor',
    desc: '温馨自然的户外防腐木质平台，适合休闲驻足、露营野餐',
    width: 7,
    depth: 7,
    tileCount: 4,
    costCoins: 0,
    image: '',
    enabled: true
  },
  {
    id: 'tree_cherry_blossom_default',
    name: '浪漫景观樱花树',
    type: 'tree',
    category: 'tree',
    desc: '盛开的粉色景观樱花树，微风拂过落英缤纷，点缀社区优美园林',
    width: 7,
    depth: 7,
    tileCount: 4,
    costCoins: 0,
    image: '',
    enabled: true
  },
  {
    id: 'tree_ginkgo_default',
    name: '金秋银杏景观树',
    type: 'tree',
    category: 'tree',
    desc: '金黄璀璨的秋日银杏景观树，落叶如扇，营造诗意园林景观',
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
    buildings:(row?row.buildings:DEFAULT_BUILDINGS).map((item)=>({...item,category:item.category||deriveCategory(item.type),costCoins:0,unlockLevelIds:item.unlockLevelIds||[],
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

  const validTypes = ['residential', 'repair_shop', 'pet_hospital', 'committee', 'police_station', 'prison', 'wood_cabin', 'floor', 'tree', 'decoration']
  const typeStr = typeof value.type === 'string' ? value.type : ''
  const isValidType = validTypes.includes(typeStr) ||
    typeStr.startsWith('floor_') ||
    typeStr.startsWith('tree_') ||
    typeStr.startsWith('landscape_') ||
    typeStr.startsWith('decoration_') ||
    (validId(typeStr) && VALID_CATEGORIES.includes(value.category))
  if (!isValidType) throw new Error('无效的建筑功能类型')

  const width = Math.max(3.5, Math.min(108, Number(value.width) || 7))
  const depth = Math.max(3.5, Math.min(108, Number(value.depth) || 7))
  const tileCount = calcTileCount(width, depth)
  const costCoins = 0
  const category = deriveCategory(value.type, value.category)

  const building = {
    id: value.id,
    name,
    type: value.type,
    category,
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

  async function matchingPlots(tx, buildingId) {
    const matches = []
    let cursor = ''
    do {
      const query = { kind: 'plot', ...(cursor ? { _id: db.command.gt(cursor) } : {}) }
      const page = (await tx.collection('pet_playground_plots').where(query).orderBy('_id', 'asc').limit(100).get()).data || []
      matches.push(...page.filter((plot) => placedBuildings(plot).some((building) => building.buildingId === buildingId)))
      cursor = page.length === 100 ? page[page.length - 1]._id : ''
    } while (cursor)
    return matches
  }

  async function updatePlot(tx, plot, buildings) {
    const stamp = now()
    const patch = { ...projectionPatch(plot, buildings), updatedAt: new Date(stamp).toISOString(), revision: Math.max(stamp, (plot.revision || 0) + 1) }
    await tx.collection('pet_playground_plots').doc(plot._id).update({ data: patch })
    const owner = await read(tx, ownerId(plot.ownerOpenid))
    if (owner && owner.plotId === plot._id) await tx.collection('pet_playground_plots').doc(owner._id).update({ data: patch })
    return { ...plot, ...patch }
  }

  async function publishPlots(records) {
    if (records.length) await require('./playground-shared')(context).publishRecords(records)
  }

  async function list() {
    return {...await readCatalog(db),levels:(await db.collection('member_levels').orderBy('minPoints','asc').get()).data||[]}
  }

  async function prepareUpload(openid, data) {
    if (!validId(data.id)) throw new Error('请先填写有效的建筑编号')
    const rawExt = typeof data.ext === 'string' ? data.ext.toLowerCase().replace(/[^a-z0-9]/g, '') : 'png'
    const ext = ['png', 'jpg', 'jpeg', 'webp'].includes(rawExt) ? rawExt : 'png'
    return {
      cloudPath: `${UPLOAD_PATH}${data.id}/${crypto.randomBytes(16).toString('hex')}.${ext}`
    }
  }

  async function save(openid, data) {
    const item = normalizeBuilding(data.building)
    await validateLevels(db,item.unlockLevelIds)
    const result = await transaction(db, async (tx) => {
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
      const records = []
      if (exists) {
        for (const plot of await matchingPlots(tx, item.id)) {
          const instances = placedBuildings(plot).map((building) => building.buildingId === item.id ? {
            ...building, type: item.type, category: item.category, name: item.name,
            image: item.image, width: item.width, depth: item.depth
          } : building)
          records.push(await updatePlot(tx, plot, instances))
        }
      }
      return { revision: next.revision, buildings, plotSizes: current.plotSizes, records }
    })
    const { records, ...response } = result
    await publishPlots(records)
    return response
  }

  async function remove(openid, data) {
    const id = String(data.id || '')
    const result = await transaction(db, async (tx) => {
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

      // Remove only matching instances, including non-primary attachments.
      const records = []
      const affectedCommunities = new Set()
      for (const plot of await matchingPlots(tx, id)) {
        const instances = placedBuildings(plot)
        if (instances.some((building) => building.buildingId === id && building.type === 'prison') && plot.communityId) affectedCommunities.add(plot.communityId)
        records.push(await updatePlot(tx, plot, instances.filter((building) => building.buildingId !== id)))
      }
      for (const communityId of affectedCommunities) {
        const prisonRows = await tx.collection('pet_playground_plots').where({ kind: 'plot', communityId, buildingType: 'prison' }).get()
        const stillHasPrison = (prisonRows.data || []).some((p) => !p.demolished && p.buildingId !== id)
        if (!stillHasPrison) {
          const jailRows = await tx.collection('pet_playground_jail').where({ communityId, jailed: true }).get()
          for (const item of (jailRows.data || [])) {
            await tx.collection('pet_playground_jail').doc(item._id).update({
              data: { jailed: false, releasedAt: now(), releasedBy: 'building_deleted_by_admin' }
            })
          }
        }
      }

      return { revision: next.revision, buildings, plotSizes: current.plotSizes, records }
    })
    const { records, ...response } = result
    await publishPlots(records)
    return response
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
