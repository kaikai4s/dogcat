const { callFunction, showError } = require('../../../utils/cloud')
const { uploadFile } = require('../utils/playgroundAppearanceUpload')
const { can } = require('../../../utils/adminAccess')

const GRASS_TILE_SIZE = 3.5

function chooseImageFile(source) {
  return new Promise((resolve, reject) => {
    const success = (result) => {
      const file = (result.tempFiles || [])[0],
        path = file && (file.path || file.tempFilePath)
      if (!path || !file.size || file.size > 8 * 1024 * 1024)
        return reject(new Error('请选择不超过8MB的素材图片'))
      wx.getImageInfo({
        src: path,
        success: (info) => {
          const ext = String(info.type || '').toLowerCase()
          if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext))
            return reject(new Error('请选择PNG、JPG或WEBP格式素材图'))
          resolve({ path, width: info.width, height: info.height, ext: ext === 'jpeg' ? 'jpg' : ext })
        },
        fail: reject
      })
    }
    if (source === 0)
      wx.chooseMessageFile({ count: 1, type: 'file', extension: ['png', 'jpg', 'jpeg', 'webp'], success, fail: reject })
    else
      wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['original'], success, fail: reject })
  })
}

function calcGrassTiles(w, d) {
  const width = Number(w) || 0
  const depth = Number(d) || 0
  const single = GRASS_TILE_SIZE * GRASS_TILE_SIZE
  return Math.max(1, Math.round(((width * depth) / single) * 10) / 10)
}

const TYPE_NAMES = {
  residential: '普通住宅/房屋',
  wood_cabin: '田园小木屋',
  floor: '地板/地坪铺装素材',
  tree: '园林/景观树木素材',
  repair_shop: '修理厂（洗车/修车）',
  pet_hospital: '宠物医院（洗护/治疗）',
  committee: '居委会（环境卫生调解/唯一）',
  police_station: '文明督导所（交通出行劝导）',
  prison: '安全宣教自省室（违规自省）',
  decoration: '景观装饰设施'
}

Page({
  data: {
    levels:[],levelChoices:[],plotSizes:[],
    buildings: [],
    displayBuildings: [],
    activeCategory: 'all',
    categories: [
      { key: 'all', label: '全部' },
      { key: 'public', label: '🏛 公共配套' },
      { key: 'residential', label: '🏡 居住木屋' },
      { key: 'floor', label: '🧱 地板素材' },
      { key: 'tree', label: '🌳 景观树木' },
      { key: 'decoration', label: '🪴 景观装饰' }
    ],
    revision: 0,
    loading: false,
    busy: false,
    error: '',
    form: null,
    isNew: false,
    progress: 0,
    types: [
      { key: 'residential', label: '普通住宅/房屋', category: 'residential' },
      { key: 'wood_cabin', label: '田园小木屋', category: 'residential' },
      { key: 'floor', label: '地板/地坪铺装素材', category: 'floor' },
      { key: 'tree', label: '园林/景观树木素材', category: 'tree' },
      { key: 'repair_shop', label: '修理厂（洗车/修车）', category: 'public' },
      { key: 'pet_hospital', label: '宠物医院（洗护/治疗）', category: 'public' },
      { key: 'committee', label: '居委会（环境卫生调解/唯一）', category: 'public' },
      { key: 'police_station', label: '文明督导所（交通出行劝导）', category: 'public' },
      { key: 'prison', label: '安全宣教自省室（违规自省）', category: 'public' },
      { key: 'decoration', label: '景观装饰设施', category: 'decoration' }
    ]
  },
  filterBuildings(buildings, category) {
    if (!category || category === 'all') return buildings
    return buildings.filter((b) => (b.category || 'public') === category)
  },
  switchCategory(e) {
    const key = e.currentTarget.dataset.key
    this.setData({
      activeCategory: key,
      displayBuildings: this.filterBuildings(this.data.buildings, key)
    })
  },
  onShow() {
    this.closed = false
    if (!this.data.form) this.load()
  },
  onUnload() {
    this.closed = true
    this.loadToken = (this.loadToken || 0) + 1
  },
  async load() {
    const token = (this.loadToken = (this.loadToken || 0) + 1)
    this.setData({ loading: true, error: '' })
    try {
      const result = await callFunction('playgroundBuilding', 'list')
      if (!this.closed && token === this.loadToken) {
        const buildings = result.buildings || []
        this.setData({
          levels:result.levels||[],
          plotSizes:(result.plotSizes||[]).map((p)=>({...p,choices:(result.levels||[]).map((l)=>({
            ...l,checked:(p.unlockLevelIds||[]).includes(l._id),
            count:((p.levelGrants||[]).find((g)=>g.levelId===l._id)||{}).count||1
          }))})),
          buildings,
          displayBuildings: this.filterBuildings(buildings, this.data.activeCategory),
          revision: result.revision || 0
        })
      }
    } catch (err) {
      if (!this.closed && token === this.loadToken) {
        this.setData({ error: err.message || '加载建筑列表失败' })
      }
    } finally {
      if (!this.closed && token === this.loadToken) {
        this.setData({ loading: false })
      }
    }
  },
  edit(e) {
    if (this.data.busy || !can(this.data.adminAccess, 'playgroundBuilding.save')) return
    const id = e.currentTarget.dataset.id
    const building = this.data.buildings.find((b) => b.id === id)
    const defaultType = this.data.activeCategory === 'floor' ? 'floor' : this.data.activeCategory === 'tree' ? 'tree' : this.data.activeCategory === 'residential' ? 'wood_cabin' : this.data.activeCategory === 'public' ? 'repair_shop' : 'residential'
    const defaultCategory = this.data.activeCategory !== 'all' ? this.data.activeCategory : 'residential'
    const base = building || {
      id: '',
      name: '',
      type: defaultType,
      category: defaultCategory,
      desc: '',
      width: 7,
      depth: 7,
      unlockLevelIds:[],washPoints:10,reportPoints:5,
      image: '',
      weeklySalary: 20,
      resolveReward: 10,
      enabled: true
    }
    const form = JSON.parse(JSON.stringify(base))
    form.tileCount = calcGrassTiles(form.width, form.depth)
    this.setData({
      levelChoices:this.data.levels.map((l)=>({...l,checked:(form.unlockLevelIds||[]).includes(l._id)})),
      form,
      isNew: !building
    })
  },
  close() {
    if (!this.data.busy) {
      this.setData({ form: null })
      this.load()
    }
  },
  input(e) {
    const key = e.currentTarget.dataset.key
    let val = e.detail.value
    if (['width', 'depth', 'washPoints', 'reportPoints', 'weeklySalary', 'resolveReward'].includes(key)) {
      val = Number(val) || 0
    }
    const form = { ...this.data.form, [key]: val }
    if (key === 'width' || key === 'depth') {
      form.tileCount = calcGrassTiles(form.width, form.depth)
    }
    this.setData({ form })
  },
  typeChange(e) {
    const type = e.detail.value
    const found = this.data.types.find((t) => t.key === type)
    if (!found) return
    this.setData({
      'form.type': type,
      'form.category': found.category || 'public'
    })
  },
  levelsChange(e){this.setData({'form.unlockLevelIds':e.detail.value,levelChoices:this.data.levelChoices.map((l)=>({...l,checked:e.detail.value.includes(l._id)}))})},
  plotLevelsChange(e) {
    const size=Number(e.currentTarget.dataset.size)
    this.setData({plotSizes:this.data.plotSizes.map((p)=>p.size===size?{
      ...p,unlockLevelIds:e.detail.value,choices:p.choices.map((l)=>({...l,checked:e.detail.value.includes(l._id)}))
    }:p)})
  },
  plotCountChange(e) {
    const size=Number(e.currentTarget.dataset.size), id=e.currentTarget.dataset.id
    this.setData({plotSizes:this.data.plotSizes.map((p)=>p.size===size?{
      ...p,choices:p.choices.map((l)=>l._id===id?{...l,count:e.detail.value}:l)
    }:p)})
  },
  async savePlotLevels(e) {
    if(this.data.busy||!can(this.data.adminAccess,'playgroundBuilding.savePlotAccess'))return
    const plot=this.data.plotSizes.find((p)=>p.size===Number(e.currentTarget.dataset.size))
    if(!plot)return
    const levelGrants=plot.choices.filter((l)=>l.checked).map((l)=>({levelId:l._id,count:Number(l.count)}))
    if(levelGrants.some((g)=>!Number.isInteger(g.count)||g.count<1||g.count>100))return showError(new Error('每个等级的地皮数量须为1至100块整数'))
    this.setData({busy:true})
    try {const result=await callFunction('playgroundBuilding','savePlotAccess',{size:plot.size,unlockLevelIds:plot.unlockLevelIds,levelGrants,revision:this.data.revision});this.setData({revision:result.revision});wx.showToast({title:'已保存',icon:'success'})}
    catch(error){showError(error)}finally{if(!this.closed)this.setData({busy:false})}
  },
  enabledChange(e) {
    this.setData({ 'form.enabled': e.detail.value })
  },
  async upload() {
    if (this.data.busy) return
    const form = this.data.form
    if (!form || !form.id) {
      return wx.showToast({ title: '请先填写建筑编号', icon: 'none' })
    }
    this.setData({ busy: true, progress: 0 })
    try {
      const selection = await new Promise((resolve, reject) =>
        wx.showActionSheet({
          itemList: ['从聊天文件选择素材图片', '从相册选择素材图片'],
          success: resolve,
          fail: reject
        })
      )
      const file = await chooseImageFile(selection.tapIndex)
      const { cloudPath } = await callFunction('playgroundBuilding', 'prepareUpload', {
        id: form.id,
        ext: file.ext || 'png'
      })
      const fileID = await uploadFile(file.path, cloudPath, (progress) => {
        if (!this.closed) this.setData({ progress })
      })
      if (!this.closed) {
        this.setData({ 'form.image': fileID })
        wx.showToast({ title: '图片上传成功', icon: 'success' })
      }
    } catch (err) {
      if (!this.closed && !/cancel/i.test(err.errMsg || '')) showError(err)
    } finally {
      if (!this.closed) this.setData({ busy: false, progress: 0 })
    }
  },
  async save() {
    if (this.data.busy) return
    const form = this.data.form
    if (!form.id || !form.name) {
      return wx.showToast({ title: '请填写编号和名称', icon: 'none' })
    }
    this.setData({ busy: true })
    try {
      const result = await callFunction('playgroundBuilding', 'save', {
        building: form,
        revision: this.data.revision
      })
      const buildings = result.buildings || []
      this.setData({
        buildings,
        displayBuildings: this.filterBuildings(buildings, this.data.activeCategory),
        revision: result.revision || 0,
        form: null
      })
      wx.showToast({ title: '保存成功', icon: 'success' })
    } catch (err) {
      showError(err)
    } finally {
      if (!this.closed) this.setData({ busy: false })
    }
  },
  async removeBuilding() {
    if (this.data.busy || this.data.isNew) return
    const confirmed = await new Promise((resolve) =>
      wx.showModal({
        title: '确认删除',
        content: `确定要删除建筑【${this.data.form.name}】吗？`,
        confirmColor: '#e04f5f',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false)
      })
    )
    if (!confirmed) return
    this.setData({ busy: true })
    try {
      const result = await callFunction('playgroundBuilding', 'remove', {
        id: this.data.form.id,revision:this.data.revision
      })
      const buildings = result.buildings || []
      this.setData({
        buildings,
        displayBuildings: this.filterBuildings(buildings, this.data.activeCategory),
        revision: result.revision || 0,
        form: null
      })
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (err) {
      showError(err)
    } finally {
      if (!this.closed) this.setData({ busy: false })
    }
  }
})
