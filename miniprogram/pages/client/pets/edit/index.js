const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')

const speciesOptions = [
  { label: '狗狗', value: 'dog' },
  { label: '猫咪', value: 'cat' },
  { label: '其他', value: 'other' }
]

const genderOptions = ['妹妹', '弟弟', '已绝育妹妹', '已绝育弟弟', '未知']

Page({
  data: {
    id: '',
    initialized: false,
    sectionHomeUrl: '',
    canGoBack: false,
    speciesOptions,
    genderOptions,
    speciesIndex: 0,
    genderIndex: 4,
    recognizingBreed: false,
    aiResultText: '',
    form: {
      species: 'dog',
      name: '',
      avatarFileId: '',
      breed: '',
      gender: '未知',
      birthday: '',
      weight: '',
      personality: '',
      favoriteFood: '',
      dislikes: '',
      healthNotes: '',
      specialNotes: '',
      aiInteractionEnabled: true,
      aiPersona: '',
      aiGreeting: ''
    }
  },

  onLoad(query) {
    this.setData({ ...createPageNav(query), id: query.id || '' })
  },

  onShow() {
    ensureLogin({ content: '登录后可编辑宠物档案。' })
      .then(() => {
        if (this.data.initialized) return
        this.setData({ initialized: true })
        this.load()
      })
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  load() {
    if (!this.data.id) return
    callFunction('pet', 'getPet', { id: this.data.id })
      .then((form) => {
        const speciesIndex = Math.max(speciesOptions.findIndex((item) => item.value === form.species), 0)
        const genderIndex = Math.max(genderOptions.indexOf(form.gender || '未知'), 0)
        this.setData({ form: { ...this.data.form, ...form }, speciesIndex, genderIndex })
      })
      .catch(showError)
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    const value = field === 'weight' ? String(e.detail.value || '').replace(/[^0-9.]/g, '') : e.detail.value
    this.setData({ ['form.' + field]: value })
  },

  chooseSpecies(e) {
    const speciesIndex = Number(e.detail.value)
    this.setData({ speciesIndex, ['form.species']: speciesOptions[speciesIndex].value })
  },

  chooseGender(e) {
    const genderIndex = Number(e.detail.value)
    this.setData({ genderIndex, ['form.gender']: genderOptions[genderIndex] })
  },

  chooseBirthday(e) {
    this.setData({ ['form.birthday']: e.detail.value })
  },

  toggleAi(e) {
    this.setData({ ['form.aiInteractionEnabled']: e.detail.value })
  },

  previewPhoto() {
    if (this.data.form.avatarFileId) {
      wx.previewImage({ urls: [this.data.form.avatarFileId] })
    }
  },

  choosePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const filePath = res.tempFiles[0].tempFilePath
        const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
        this.setData({ localTempPath: filePath, tempHttpsUrl: '', ['form.avatarFileId']: '' })
        wx.showLoading({ title: '上传照片中...' })
        wx.cloud.uploadFile({
          cloudPath: `pets/${Date.now()}${ext}`,
          filePath,
          success: (upload) => {
            const fileID = upload.fileID
            this.setData({ ['form.avatarFileId']: fileID })
            wx.cloud.getTempFileURL({
              fileList: [fileID],
              success: (tempRes) => {
                wx.hideLoading()
                if (tempRes.fileList && tempRes.fileList[0] && tempRes.fileList[0].tempFileURL) {
                  this.setData({ tempHttpsUrl: tempRes.fileList[0].tempFileURL })
                }
                wx.showToast({ title: '照片上传成功', icon: 'success' })
              },
              fail: () => {
                wx.hideLoading()
                wx.showToast({ title: '照片上传成功', icon: 'success' })
              }
            })
          },
          fail: (err) => {
            wx.hideLoading()
            showError(err)
          }
        })
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) showError(err)
      }
    })
  },

  recognizeBreed() {
    const avatarFileId = this.data.form.avatarFileId
    const tempHttpsUrl = this.data.tempHttpsUrl
    const localTempPath = this.data.localTempPath
    if (!avatarFileId && !localTempPath && !tempHttpsUrl) {
      wx.showToast({ title: '请先上传宠物照片再进行AI识别', icon: 'none' })
      return
    }

    this.setData({ recognizingBreed: true })
    console.log('[AI识图日志] 开始调用云函数 AI 识别...', { avatarFileId, tempHttpsUrl })

    const executeRecognize = (fileId, httpsUrl) => {
      callFunction('pet', 'recognizePetBreed', { avatarFileId: fileId, imageUrl: httpsUrl })
        .then((res) => {
          this.setData({ recognizingBreed: false })
          console.log('[AI识图日志] 云函数识别成功返回:', res)
          if (!res) return
          const fullText = res.aiResultText || res.fullAnalysis || res.aiMessage || ''
          this.setData({
            aiResultText: fullText
          })
          wx.showToast({ title: 'AI 识别完成', icon: 'success', duration: 2500 })
        })
        .catch((err) => {
          this.setData({ recognizingBreed: false })
          console.error('[AI识图日志] 云函数识别失败:', err)
          showError(err)
        })
    }

    if (tempHttpsUrl) {
      executeRecognize(avatarFileId, tempHttpsUrl)
    } else if (avatarFileId && avatarFileId.startsWith('cloud://')) {
      wx.cloud.getTempFileURL({
        fileList: [avatarFileId],
        success: (res) => {
          const url = res.fileList && res.fileList[0] ? res.fileList[0].tempFileURL : ''
          executeRecognize(avatarFileId, url)
        },
        fail: () => executeRecognize(avatarFileId, '')
      })
    } else {
      executeRecognize(avatarFileId, '')
    }
  },

  generateAiProfile() {
    const { name, species, breed, personality, favoriteFood, dislikes } = this.data.form
    if (!name) {
      wx.showToast({ title: '请先填写宠物名字', icon: 'none' })
      return
    }
    const speciesName = species === 'cat' ? '猫咪' : species === 'other' ? '小宠物' : '狗狗'
    const persona = `${name}是一只${breed || '可爱'}${speciesName}，性格${personality || '亲人、好奇'}，喜欢${favoriteFood || '被温柔陪伴'}，不喜欢${dislikes || '突然的大声惊吓'}。互动时要用第一视角、轻松可爱的语气回应主人。`
    const greeting = `嗨，我是${name}！今天也想和你贴贴，一起记录我的快乐小日常吧。`
    this.setData({ ['form.aiPersona']: persona, ['form.aiGreeting']: greeting, ['form.aiInteractionEnabled']: true })
    wx.showToast({ title: '已生成AI设定' })
  },

  save() {
    if (!this.data.form.avatarFileId) {
      wx.showToast({ title: '请上传至少一张宠物照片', icon: 'none' })
      return
    }
    if (!this.data.form.name) {
      wx.showToast({ title: '请填写宠物名字', icon: 'none' })
      return
    }
    const action = this.data.id ? 'updatePet' : 'createPet'
    const form = this.data.form
    const avatarFileId = String(form.avatarFileId || '')
    const data = {
      id: this.data.id,
      name: form.name || '',
      avatarFileId: avatarFileId,
      species: form.species || 'dog',
      breed: form.breed || '',
      gender: form.gender || '',
      birthday: form.birthday || '',
      weight: form.weight || 0,
      personality: form.personality || '',
      favoriteFood: form.favoriteFood || '',
      dislikes: form.dislikes || '',
      healthNotes: form.healthNotes || '',
      specialNotes: form.specialNotes || '',
      aiInteractionEnabled: form.aiInteractionEnabled === true,
      aiPersona: form.aiPersona || '',
      aiGreeting: form.aiGreeting || ''
    }
    callFunction('pet', action, data)
      .then(() => {
        wx.showToast({ title: '已保存' })
        wx.navigateBack()
      })
      .catch(showError)
  },

  ...navMethods()
})
