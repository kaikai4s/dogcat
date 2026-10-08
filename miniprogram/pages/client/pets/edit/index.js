const { callFunction, showError, ensureLogin, loadSystemSettings, getCachedSystemSettings } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { toBeijingDate } = require('../../../../utils/format')
const petCare = require('../../../../utils/petCare') || {}
const getCareCompleteness = typeof petCare.getCareCompleteness === 'function' ? petCare.getCareCompleteness : () => ({ score: 0, missing: [], complete: false })

const speciesOptions = [
  { label: '狗狗', value: 'dog' },
  { label: '猫咪', value: 'cat' },
  { label: '其他', value: 'other' }
]

const genderOptions = ['妹妹', '弟弟', '已绝育妹妹', '已绝育弟弟', '未知']

const careTagLabels = ['胆小怕生', '护食', '需短牵', '爆冲', '怕噪音', '需喂药', '不可洗澡', '多宠同住']
const riskLevelOptions = [
  { label: '常规照护', value: 'normal' },
  { label: '需要留意', value: 'caution' },
  { label: '高风险照护', value: 'high' }
]

function buildCareTagOptions(selectedTags = []) {
  const selected = new Set(Array.isArray(selectedTags) ? selectedTags : [])
  return careTagLabels.map((label) => ({ label, selected: selected.has(label) }))
}

function calculateCareCompleteness(form = {}) {
  const result = getCareCompleteness(form)
  return { score: result.score, missingText: result.missing.length ? result.missing.join('、') : '照护信息已较完整' }
}

const careQuickTemplates = {
  feedingNotes: ['早晚各一次', '只吃自带粮', '不能吃人食'],
  toiletNotes: ['每日铲屎', '尿垫在卫生间', '需要清理食盆水碗'],
  walkingNotes: ['必须短牵', '见狗会激动', '避开车流/噪音'],
  medicalCareNotes: ['按说明随粮喂药', '有过敏史需确认'],
  emergencyContactNote: ['优先电话联系主人', '必要时联系平台客服']
}

function normalizeBeautyPhotos(form = {}) {
  const photos = Array.isArray(form.beautyPhotos) ? form.beautyPhotos.filter((item) => item && item.fileId) : []
  if (!photos.length && form.avatarFileId) {
    return [{ id: `bp_${Date.now()}`, fileId: form.avatarFileId, source: 'pet_profile', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
  }
  return photos.slice(0, 9)
}

function canDeleteBeautyPhotoToday() {
  return toBeijingDate(new Date()).getUTCDate() === 1
}

function titleOptionLabel(item, currentPetId) {
  const title = item.title || {}
  const name = title.name || '宠物头衔'
  const equippedPetId = item.equippedPetId || ''
  return equippedPetId && equippedPetId !== currentPetId ? `${name}（已佩戴，选择后将移动）` : name
}

Page({
  data: {
    id: '',
    initialized: false,
    sectionHomeUrl: '',
    canGoBack: false,
    speciesOptions,
    genderOptions,
    careTagOptions: buildCareTagOptions(),
    careQuickTemplates,
    careCompleteness: calculateCareCompleteness(),
    riskLevelOptions,
    speciesIndex: 0,
    genderIndex: 4,
    riskLevelIndex: 0,
    riskLevelText: riskLevelOptions[0].label,
    recognizingBreed: false,
    enablePetBreedAi: true,
    uploadingBeauty: false,
    canDeleteBeautyPhoto: canDeleteBeautyPhotoToday(),
    aiResultText: '',
    myTitles: [],
    titleOptions: [{ label: '不佩戴头衔', inventoryId: '' }],
    selectedTitleOptionIndex: 0,
    titleSaving: false,
    beautyTitleOptions: [{ label: '不佩戴称号', monthKey: '' }],
    selectedBeautyTitleIndex: 0,
    beautyTitleLoading: true,
    beautyTitleLoadFailed: false,
    beautyTitleSaving: false,
    uploadingVaccine: false,
    vaccineSubmitting: false,
    vaccineFileIds: [],
    vaccineForm: { certificateNo: '', validUntil: '', ownerRemark: '' },
    form: {
      species: 'dog',
      name: '',
      avatarFileId: '',
      beautyPhotos: [],
      breed: '',
      gender: '未知',
      birthday: '',
      weight: '',
      personality: '',
      favoriteFood: '',
      dislikes: '',
      healthNotes: '',
      specialNotes: '',
      careTags: [],
      feedingNotes: '',
      toiletNotes: '',
      walkingNotes: '',
      medicalCareNotes: '',
      emergencyContactNote: '',
      riskLevel: 'normal',
      aiInteractionEnabled: true,
      aiPersona: '',
      aiGreeting: ''
    }
  },

  onLoad(query) {
    this.setData({ ...createPageNav(query), id: query.id || '' })
  },

  onShow() {
    this.setData({ canDeleteBeautyPhoto: canDeleteBeautyPhotoToday(), enablePetBreedAi: getCachedSystemSettings().enablePetBreedAi !== false })
    loadSystemSettings().then((settings) => this.setData({ enablePetBreedAi: settings.enablePetBreedAi !== false }))
    ensureLogin({ content: '登录后可编辑宠物档案。' })
      .then(() => {
        if (this.data.initialized) return
        this.setData({ initialized: true })
        this.load()
        this.loadMyTitles()
      })
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  load() {
    if (!this.data.id) return
    callFunction('pet', 'getPet', { id: this.data.id })
      .then((form) => {
        const speciesIndex = Math.max(speciesOptions.findIndex((item) => item.value === form.species), 0)
        const genderIndex = Math.max(genderOptions.indexOf(form.gender || '未知'), 0)
        const riskLevelIndex = Math.max(riskLevelOptions.findIndex((item) => item.value === form.riskLevel), 0)
        const riskLevel = riskLevelOptions[riskLevelIndex] || riskLevelOptions[0]
        const nextForm = { ...this.data.form, ...form, careTags: Array.isArray(form.careTags) ? form.careTags : [], riskLevel: riskLevel.value }
        const beautyPhotos = normalizeBeautyPhotos(nextForm)
        const mergedForm = { ...nextForm, beautyPhotos, avatarFileId: nextForm.avatarFileId || (beautyPhotos[0] && beautyPhotos[0].fileId) || '' }
        this.setData({ form: mergedForm, careCompleteness: calculateCareCompleteness(mergedForm), careTagOptions: buildCareTagOptions(nextForm.careTags), vaccineFileIds: Array.isArray(nextForm.vaccineCertification && nextForm.vaccineCertification.fileIds) ? nextForm.vaccineCertification.fileIds : [], speciesIndex, genderIndex, riskLevelIndex, riskLevelText: riskLevel.label }, () => this.refreshTitleOptions())
        this.loadBeautyTitles()
      })
      .catch(showError)
  },

  loadMyTitles() {
    callFunction('pet', 'listMyTitles')
      .then((myTitles) => this.setData({ myTitles: myTitles || [] }, () => this.refreshTitleOptions()))
      .catch(() => {})
  },

  loadBeautyTitles() {
    if (!this.data.id) return
    this.setData({ beautyTitleLoading: true, beautyTitleLoadFailed: false })
    return callFunction('petBeauty', 'listMyBeautyTitles', { petId: this.data.id })
      .then((res) => {
        const beautyTitleOptions = [{ label: '不佩戴称号', monthKey: '' }].concat((res.titles || []).map((award) => ({
          ...award, label: `${award.monthKey} · ${award.title}`
        })))
        const selectedMonth = res.beautyTitle && res.beautyTitle.monthKey || ''
        this.setData({
          beautyTitleOptions,
          selectedBeautyTitleIndex: Math.max(beautyTitleOptions.findIndex((item) => item.monthKey === selectedMonth), 0),
          ['form.beautyTitle']: res.beautyTitle || null,
          beautyTitleLoading: false
        })
      }).catch((err) => {
        this.setData({ beautyTitleLoading: false, beautyTitleLoadFailed: true })
        showError(err)
      })
  },

  chooseBeautyTitle(e) {
    if (!this.data.id || this.data.beautyTitleSaving || this.data.beautyTitleLoading || this.data.beautyTitleLoadFailed) return
    const index = Math.max(0, Number(e && e.detail && e.detail.value) || 0)
    const option = this.data.beautyTitleOptions[index]
    if (!option) return
    this.setData({ beautyTitleSaving: true })
    return callFunction('petBeauty', option.monthKey ? 'equipBeautyTitle' : 'unequipBeautyTitle', {
      petId: this.data.id, awardMonthKey: option.monthKey
    }).then((res) => {
      this.setData({ selectedBeautyTitleIndex: index, ['form.beautyTitle']: res.beautyTitle || null, beautyTitleSaving: false })
      wx.showToast({ title: option.monthKey ? '已佩戴称号' : '已取下称号', icon: 'none' })
    }).catch((err) => {
      this.setData({ beautyTitleSaving: false })
      showError(err)
    })
  },

  refreshTitleOptions() {
    const currentPetId = this.data.id
    const currentInventoryId = this.data.form.equippedTitleInventoryId || ''
    const titleOptions = [{ label: '不佩戴头衔', inventoryId: '' }].concat((this.data.myTitles || []).map((item) => ({
      ...item,
      inventoryId: item.inventoryId || item._id,
      label: titleOptionLabel(item, currentPetId)
    })))
    const selectedTitleOptionIndex = Math.max(titleOptions.findIndex((item) => item.inventoryId === currentInventoryId), 0)
    this.setData({ titleOptions, selectedTitleOptionIndex })
  },

  refreshCareCompleteness() {
    this.setData({ careCompleteness: calculateCareCompleteness(this.data.form) })
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    const value = field === 'weight' ? String(e.detail.value || '').replace(/[^0-9.]/g, '') : e.detail.value
    this.setData({ ['form.' + field]: value }, () => this.refreshCareCompleteness())
  },

  chooseSpecies(e) {
    const speciesIndex = Number(e.detail.value)
    this.setData({ speciesIndex, ['form.species']: speciesOptions[speciesIndex].value })
  },

  chooseGender(e) {
    const genderIndex = Number(e.detail.value)
    this.setData({ genderIndex, ['form.gender']: genderOptions[genderIndex] })
  },

  chooseRiskLevel(e) {
    const riskLevelIndex = Number(e.detail.value)
    const option = riskLevelOptions[riskLevelIndex] || riskLevelOptions[0]
    this.setData({ riskLevelIndex, riskLevelText: option.label, ['form.riskLevel']: option.value }, () => this.refreshCareCompleteness())
  },

  toggleCareTag(e) {
    const tag = e.currentTarget.dataset.tag
    if (!tag) return
    const current = Array.isArray(this.data.form.careTags) ? this.data.form.careTags.slice() : []
    const index = current.indexOf(tag)
    if (index >= 0) current.splice(index, 1)
    else current.push(tag)
    this.setData({ ['form.careTags']: current, careTagOptions: buildCareTagOptions(current) }, () => this.refreshCareCompleteness())
  },

  applyCareTemplate(e) {
    const field = e.currentTarget.dataset.field
    const text = e.currentTarget.dataset.text
    if (!field || !text) return
    const parts = String(this.data.form[field] || '').split('；').map((item) => item.trim()).filter(Boolean)
    if (!parts.includes(text)) parts.push(text)
    this.setData({ ['form.' + field]: parts.join('；') }, () => this.refreshCareCompleteness())
  },

  chooseBirthday(e) {
    this.setData({ ['form.birthday']: e.detail.value })
  },

  toggleAi(e) {
    this.setData({ ['form.aiInteractionEnabled']: e.detail.value })
  },

  chooseTitle(e) {
    if (!this.data.id) {
      wx.showToast({ title: '请先保存宠物档案', icon: 'none' })
      return
    }
    const index = Number(e.detail.value)
    const option = this.data.titleOptions[index]
    if (!option) return
    const apply = () => {
      this.setData({ titleSaving: true })
      const promise = option.inventoryId
        ? callFunction('pet', 'equipTitle', { petId: this.data.id, inventoryId: option.inventoryId })
        : callFunction('pet', 'unequipTitle', { petId: this.data.id })
      promise.then((res) => {
        this.setData({
          titleSaving: false,
          selectedTitleOptionIndex: index,
          ['form.equippedTitleInventoryId']: option.inventoryId || '',
          ['form.equippedTitle']: res.equippedTitle || null
        })
        wx.showToast({ title: option.inventoryId ? '已佩戴头衔' : '已卸下头衔', icon: 'none' })
        this.loadMyTitles()
      }).catch((err) => {
        this.setData({ titleSaving: false })
        showError(err)
      })
    }
    if (option.equippedPetId && option.equippedPetId !== this.data.id) {
      wx.showModal({
        title: '移动宠物头衔',
        content: '该头衔已佩戴在其他宠物身上，继续后会从原宠物移除并佩戴到当前宠物。',
        confirmText: '继续佩戴',
        success: (res) => { if (res.confirm) apply() }
      })
      return
    }
    apply()
  },

  previewPhoto(e) {
    const current = e && e.currentTarget && e.currentTarget.dataset.url ? e.currentTarget.dataset.url : this.data.form.avatarFileId
    const urls = normalizeBeautyPhotos(this.data.form).map((item) => item.fileId)
    if (current && urls.length) wx.previewImage({ current, urls })
  },

  choosePhoto() {
    this.chooseBeautyPhotos()
  },

  chooseBeautyPhotos() {
    const currentPhotos = normalizeBeautyPhotos(this.data.form)
    const remaining = 9 - currentPhotos.length
    if (remaining <= 0) {
      wx.showToast({ title: '最多上传9张美照', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = res.tempFiles || []
        if (!files.length) return
        this.setData({ uploadingBeauty: true })
        wx.showLoading({ title: '上传美照中...' })
        files.reduce((chain, file) => chain.then(() => this.uploadBeautyPhoto(file.tempFilePath)), Promise.resolve())
          .then(() => {
            wx.hideLoading()
            this.setData({ uploadingBeauty: false })
            wx.showToast({ title: '美照上传成功', icon: 'success' })
          })
          .catch((err) => {
            wx.hideLoading()
            this.setData({ uploadingBeauty: false })
            showError(err)
          })
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) showError(err)
      }
    })
  },

  uploadBeautyPhoto(filePath) {
    if (!filePath) return Promise.resolve()
    const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
    const cloudPath = `pets/beauty/${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: (upload) => {
          const fileID = upload.fileID
          const currentForm = this.data.form || {}
          const photos = normalizeBeautyPhotos(currentForm).concat([{ id: `bp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, fileId: fileID, source: 'pet_profile', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]).slice(0, 9)
          const newAvatar = currentForm.avatarFileId || fileID
          this.setData({ localTempPath: filePath, tempHttpsUrl: '', ['form.avatarFileId']: newAvatar, ['form.beautyPhotos']: photos })
          wx.cloud.getTempFileURL({
            fileList: [newAvatar],
            success: (tempRes) => {
              if (tempRes.fileList && tempRes.fileList[0] && tempRes.fileList[0].tempFileURL) this.setData({ tempHttpsUrl: tempRes.fileList[0].tempFileURL })
              resolve()
            },
            fail: resolve
          })
        },
        fail: reject
      })
    })
  },

  removeBeautyPhoto(e) {
    if (!this.data.canDeleteBeautyPhoto) {
      wx.showToast({ title: '每月1日才可以删除美照', icon: 'none' })
      return
    }
    const index = Number(e.currentTarget.dataset.index)
    const photos = normalizeBeautyPhotos(this.data.form)
    if (photos.length <= 1) {
      wx.showToast({ title: '至少保留1张美照', icon: 'none' })
      return
    }
    photos.splice(index, 1)
    this.setData({ ['form.beautyPhotos']: photos, ['form.avatarFileId']: photos[0].fileId })
  },

  recognizeBreed() {
    if (this.data.recognizingBreed) return
    if (this.data.enablePetBreedAi === false) {
      wx.showToast({ title: 'AI 识别功能暂未开放', icon: 'none' })
      return
    }

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

          const updates = {
            aiResultText: res.aiResultText || res.fullAnalysis || res.aiMessage || ''
          }
          const speciesIndex = speciesOptions.findIndex((item) => item.value === res.species)
          if (speciesIndex >= 0) {
            updates.speciesIndex = speciesIndex
            updates['form.species'] = speciesOptions[speciesIndex].value
          }
          if (res.breed) updates['form.breed'] = res.breed

          this.setData(updates)
          wx.showToast({ title: 'AI 识别完成，已回填', icon: 'success', duration: 2500 })
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
          this.setData({ tempHttpsUrl: url })
          executeRecognize(avatarFileId, url)
        },
        fail: () => executeRecognize(avatarFileId, '')
      })
    } else {
      executeRecognize(avatarFileId, '')
    }
  },

  inputVaccine(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['vaccineForm.' + field]: e.detail.value })
  },

  chooseVaccineFiles() {
    if (!this.data.id) {
      wx.showToast({ title: '请先保存宠物档案', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: Math.max(1, 9 - this.data.vaccineFileIds.length),
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = res.tempFiles || []
        if (!files.length) return
        this.setData({ uploadingVaccine: true })
        wx.showLoading({ title: '上传凭证中...' })
        files.reduce((chain, file) => chain.then(() => this.uploadVaccineFile(file.tempFilePath)), Promise.resolve())
          .then(() => {
            wx.hideLoading()
            this.setData({ uploadingVaccine: false })
          })
          .catch((err) => {
            wx.hideLoading()
            this.setData({ uploadingVaccine: false })
            showError(err)
          })
      }
    })
  },

  uploadVaccineFile(filePath) {
    const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
    const cloudPath = `pet_vaccine_certifications/${this.data.id}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: (upload) => {
          this.setData({ vaccineFileIds: this.data.vaccineFileIds.concat(upload.fileID).slice(0, 9) })
          resolve()
        },
        fail: reject
      })
    })
  },

  removeVaccineFile(e) {
    const index = Number(e.currentTarget.dataset.index)
    const next = this.data.vaccineFileIds.slice()
    next.splice(index, 1)
    this.setData({ vaccineFileIds: next })
  },

  submitVaccineCertification() {
    if (!this.data.id) {
      wx.showToast({ title: '请先保存宠物档案', icon: 'none' })
      return
    }
    if (!this.data.vaccineFileIds.length) {
      wx.showToast({ title: '请先上传疫苗凭证', icon: 'none' })
      return
    }
    this.setData({ vaccineSubmitting: true })
    callFunction('pet', 'submitVaccineCertification', {
      petId: this.data.id,
      fileIds: this.data.vaccineFileIds,
      certificateNo: this.data.vaccineForm.certificateNo,
      validUntil: this.data.vaccineForm.validUntil,
      ownerRemark: this.data.vaccineForm.ownerRemark
    }).then((res) => {
      this.setData({ vaccineSubmitting: false, ['form.vaccineCertification']: res.vaccineCertification || {}, ['form.vaccineStatusText']: '疫苗认证审核中' })
      wx.showToast({ title: '已提交审核', icon: 'success' })
      this.load()
    }).catch((err) => {
      this.setData({ vaccineSubmitting: false })
      showError(err)
    })
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
    if (this.data.beautyTitleSaving) return
    const beautyPhotos = normalizeBeautyPhotos(this.data.form)
    if (!beautyPhotos.length) {
      wx.showToast({ title: '请上传至少一张宠物美照', icon: 'none' })
      return
    }
    if (!this.data.form.name) {
      wx.showToast({ title: '请填写宠物名字', icon: 'none' })
      return
    }
    const action = this.data.id ? 'updatePet' : 'createPet'
    const form = this.data.form
    const avatarFileId = String(form.avatarFileId || (beautyPhotos[0] && beautyPhotos[0].fileId) || '')
    const data = {
      id: this.data.id,
      name: form.name || '',
      avatarFileId: avatarFileId,
      beautyPhotos,
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
      careTags: Array.isArray(form.careTags) ? form.careTags : [],
      feedingNotes: form.feedingNotes || '',
      toiletNotes: form.toiletNotes || '',
      walkingNotes: form.walkingNotes || '',
      medicalCareNotes: form.medicalCareNotes || '',
      emergencyContactNote: form.emergencyContactNote || '',
      riskLevel: form.riskLevel || 'normal',
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
