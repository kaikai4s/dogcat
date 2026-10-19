const { callFunction, showError } = require('../../../utils/cloud')
const { uploadFile } = require('../utils/playgroundAppearanceUpload')
const { can } = require('../../../utils/adminAccess')

const GRASS_TILE_SIZE = 3.5

function choosePng(source) {
  return new Promise((resolve, reject) => {
    const success = (result) => {
      const file = (result.tempFiles || [])[0],
        path = file && (file.path || file.tempFilePath)
      if (!path || !file.size || file.size > 8 * 1024 * 1024)
        return reject(new Error('请选择不超过8MB的透明PNG原图'))
      wx.getImageInfo({
        src: path,
        success: (info) => {
          if (String(info.type).toLowerCase() !== 'png')
            return reject(new Error('请选择透明PNG原图'))
          resolve({ path, width: info.width, height: info.height })
        },
        fail: reject
      })
    }
    if (source === 0)
      wx.chooseMessageFile({ count: 1, type: 'file', extension: ['png'], success, fail: reject })
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
  repair_shop: '修理厂（洗车/修车）',
  pet_hospital: '宠物医院（洗护/治疗）',
  committee: '居委会（环境卫生调解/唯一）',
  police_station: '文明督导所（交通出行劝导/文明督导）',
  prison: '安全宣教自省室（违规驾驶宣教自省）'
}

Page({
  data: {
    buildings: [],
    revision: 0,
    loading: false,
    busy: false,
    error: '',
    form: null,
    isNew: false,
    progress: 0,
    types: [
      { key: 'residential', label: '普通住宅/房屋' },
      { key: 'repair_shop', label: '修理厂（洗车/修车）' },
      { key: 'pet_hospital', label: '宠物医院（洗护/治疗）' },
      { key: 'committee', label: '居委会（环境卫生调解/唯一）' },
      { key: 'police_station', label: '文明督导所（交通出行劝导/文明督导）' },
      { key: 'prison', label: '安全宣教自省室（违规驾驶宣教自省）' }
    ]
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
        this.setData({
          buildings: result.buildings || [],
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
    const base = building || {
      id: '',
      name: '',
      type: 'residential',
      desc: '',
      width: 7,
      depth: 7,
      costCoins: 100,
      image: '',
      weeklySalary: 200,
      resolveReward: 20,
      enabled: true
    }
    const form = JSON.parse(JSON.stringify(base))
    form.tileCount = calcGrassTiles(form.width, form.depth)
    this.setData({
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
    if (['width', 'depth', 'costCoins', 'weeklySalary', 'resolveReward'].includes(key)) {
      val = Number(val) || 0
    }
    const form = { ...this.data.form, [key]: val }
    if (key === 'width' || key === 'depth') {
      form.tileCount = calcGrassTiles(form.width, form.depth)
    }
    this.setData({ form })
  },
  typeChange(e) {
    const idx = Number(e.detail.value)
    const type = this.data.types[idx].key
    this.setData({ 'form.type': type })
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
          itemList: ['从聊天文件选择透明PNG', '从相册选择原图PNG'],
          success: resolve,
          fail: reject
        })
      )
      const file = await choosePng(selection.tapIndex)
      const { cloudPath } = await callFunction('playgroundBuilding', 'prepareUpload', {
        id: form.id
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
      this.setData({
        buildings: result.buildings || [],
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
        id: this.data.form.id
      })
      this.setData({
        buildings: result.buildings || [],
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
