const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText, withCheckinText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

function groupCheckinPhotos(checkins = []) {
  const map = {}
  checkins.filter((item) => item.mediaFileId).forEach((item) => {
    const eventType = item.eventType || ''
    if (!map[eventType]) map[eventType] = { eventType, eventTypeText: item.eventTypeText || eventType, count: 0, photos: [], remarks: [], remarkText: '' }
    map[eventType].count += 1
    map[eventType].photos.push(item)
    if (item.remark && !map[eventType].remarks.includes(item.remark)) map[eventType].remarks.push(item.remark)
    map[eventType].remarkText = map[eventType].remarks.join('；')
  })
  return Object.values(map)
}

// 辅助函数：将 cloud:// 或 http 转换为本地临时文件
function resolveLocalPhoto(fileId) {
  if (!fileId) return Promise.resolve('')
  if (!fileId.startsWith('cloud://')) {
    if (fileId.startsWith('http://') || fileId.startsWith('https://')) {
      return new Promise((resolve) => {
        wx.downloadFile({
          url: fileId,
          success: (res) => resolve(res.tempFilePath || ''),
          fail: () => resolve('')
        })
      })
    }
    return Promise.resolve(fileId)
  }
  return new Promise((resolve) => {
    wx.cloud.getTempFileURL({
      fileList: [fileId],
      success: (res) => {
        const item = res.fileList && res.fileList[0]
        if (item && item.tempFileURL) {
          wx.downloadFile({
            url: item.tempFileURL,
            success: (d) => resolve(d.tempFilePath || ''),
            fail: () => resolve('')
          })
        } else {
          resolve('')
        }
      },
      fail: () => resolve('')
    })
  })
}

// 辅助函数：在 Canvas 2D 中加载 Image 对象
function loadCanvasImage(canvas, src) {
  if (!src) return Promise.resolve(null)
  return new Promise((resolve) => {
    const img = canvas.createImage()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

// 辅助函数：绘制圆角矩形
function drawRoundedRect(ctx, x, y, width, height, radius, fillStyle, strokeStyle, lineWidth = 1) {
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
  if (fillStyle) {
    ctx.fillStyle = fillStyle
    ctx.fill()
  }
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle
    ctx.lineWidth = lineWidth
    ctx.stroke()
  }
  ctx.restore()
}

// 辅助函数：多行文本绘制
function drawMultilineText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 4) {
  const chars = String(text || '').split('')
  let line = ''
  let curY = y
  let linesCount = 0

  for (let n = 0; n < chars.length; n++) {
    const testLine = line + chars[n]
    const metrics = ctx.measureText(testLine)
    if (metrics.width > maxWidth && n > 0) {
      linesCount++
      if (linesCount >= maxLines) {
        ctx.fillText(line.slice(0, -1) + '...', x, curY)
        return
      }
      ctx.fillText(line, x, curY)
      line = chars[n]
      curY += lineHeight
    } else {
      line = testLine
    }
  }
  if (line) {
    ctx.fillText(line, x, curY)
  }
}

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    report: null,
    sectionHomeUrl: '',
    canGoBack: false,
    importingBeauty: false,
    // 海报导出相关状态
    showExportModal: false,
    currentTemplate: 'diary', // 'diary' | 'magazine' | 'certified'
    allPhotos: [],
    selectedPhotoIndex: 0,
    heroPhotoUrl: '',
    petDisplayName: '可爱毛孩子',
    petSpeciesText: '萌宠宝贝',
    petBeautyTitle: '✨ 乖巧小天使',
    serviceSummaryText: '上门照料服务',
    serviceDateText: '',
    displayDiaryContent: '',
    staffDisplayName: '平台认证宠托师',
    evidencePhotos: [],
    generatingPoster: false
  },
  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id })
  },
  onShow() {
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看服务报告。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load() {
    callFunction('order', 'getServiceReport', { id: this.data.id })
      .then((report) => {
        const checkins = (report.checkins || []).map(withCheckinText)
        this.setData({ report: { ...report, order: withOrderText(report.order), checkins, checkinGroups: groupCheckinPhotos(checkins) } })
      })
      .catch(showError)
  },
  previewPhoto(e) {
    const current = e.currentTarget.dataset.url
    const urls = (this.data.report && this.data.report.checkins || []).map((item) => item.mediaFileId).filter(Boolean)
    if (current && urls.length) wx.previewImage({ current, urls })
  },
  savePhoto(e) {
    const fileId = e.currentTarget.dataset.url
    if (!fileId) return
    wx.showLoading({ title: '保存中...' })
    wx.cloud.getTempFileURL({
      fileList: [fileId],
      success: (res) => {
        const url = res.fileList && res.fileList[0] && res.fileList[0].tempFileURL
        if (!url) {
          wx.hideLoading()
          wx.showToast({ title: '图片链接获取失败', icon: 'none' })
          return
        }
        wx.downloadFile({
          url,
          success: (download) => {
            wx.saveImageToPhotosAlbum({
              filePath: download.tempFilePath,
              success: () => {
                wx.hideLoading()
                wx.showToast({ title: '已保存到相册' })
              },
              fail: (err) => {
                wx.hideLoading()
                if ((err.errMsg || '').includes('auth')) wx.showToast({ title: '请开启相册保存权限', icon: 'none' })
                else showError(err)
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
        wx.hideLoading()
        showError(err)
      }
    })
  },

  importBeautyPhotos(e) {
    if (this.data.importingBeauty) return
    const groupIndex = Number(e.currentTarget.dataset.index)
    const group = this.data.report && this.data.report.checkinGroups[groupIndex]
    const order = this.data.report && this.data.report.order
    if (!group || !order) return
    const petIds = Array.isArray(order.petIds) && order.petIds.length ? order.petIds : [order.petId].filter(Boolean)
    if (!petIds.length) {
      wx.showToast({ title: '未找到订单宠物', icon: 'none' })
      return
    }
    const runImport = (petId) => {
      this.setData({ importingBeauty: true })
      callFunction('petBeauty', 'importFromServiceCheckins', { orderId: order._id || this.data.id, petId, checkinIds: group.photos.map((photo) => photo._id) })
        .then((res) => {
          this.setData({ importingBeauty: false })
          wx.showToast({ title: `已加入${res.importedCount || 0}张美照`, icon: 'none' })
        })
        .catch((err) => {
          this.setData({ importingBeauty: false })
          showError(err)
        })
    }
    if (petIds.length === 1) {
      runImport(petIds[0])
      return
    }
    wx.showActionSheet({
      itemList: petIds.map((id, index) => `宠物 ${index + 1}`),
      success: (res) => runImport(petIds[res.tapIndex])
    })
  },

  goTracking() {
    wx.navigateTo({ url: `/pages/client/orders/tracking/index?id=${this.data.id}` })
  },

  generateAiReport() {
    if (!this.data.id || this.data.loadingAi) return
    this.setData({ loadingAi: true })
    callFunction('ai', 'aiGenerateReport', { orderId: this.data.id })
      .then((res) => {
        this.setData({ aiSummary: res.reportSummary, loadingAi: false })
      })
      .catch((err) => {
        this.setData({ loadingAi: false })
        showError(err)
      })
  },

  // ==========================
  // 服务报告导出精美海报核心能力
  // ==========================
  openExportModal() {
    const report = this.data.report || {}
    const order = report.order || {}

    // 1. 汇总所有有效照片
    const allPhotos = []
    const checkins = report.checkins || []
    checkins.forEach((c) => {
      if (c.mediaFileId && !allPhotos.includes(c.mediaFileId)) {
        allPhotos.push(c.mediaFileId)
      }
    })

    // 2. 提取宠物名称与品种
    let petDisplayName = '毛孩子'
    let petSpeciesText = '萌宠宝贝'
    if (order.pet) {
      petDisplayName = order.pet.name || petDisplayName
      petSpeciesText = order.pet.breed || order.pet.species || petSpeciesText
    } else if (order.contactPetName) {
      petDisplayName = order.contactPetName
    } else if (order.petName) {
      petDisplayName = order.petName
    } else if (order.petCategory) {
      petDisplayName = order.petCategory === 'cat' ? '小猫咪' : (order.petCategory === 'dog' ? '狗狗' : '萌宠宝贝')
    }

    const titles = ['✨ 乖巧小天使', '🍗 干饭第一名', '👑 颜值天花板', '🐾 治愈系萌宠']
    const petBeautyTitle = titles[Math.floor(Math.random() * titles.length)]

    // 3. 提取打卡亮点拼图（最多 4 张）
    const evidencePhotos = []
    const groups = report.checkinGroups || []
    groups.forEach((g) => {
      if (g.photos && g.photos.length && evidencePhotos.length < 4) {
        evidencePhotos.push({
          url: g.photos[0].mediaFileId,
          label: g.eventTypeText || '日常打卡'
        })
      }
    })

    // 4. 宠托师手记与文案
    let displayDiaryContent = this.data.aiSummary || ''
    if (!displayDiaryContent) {
      const remarks = groups.map((g) => g.remarkText).filter(Boolean)
      if (remarks.length) {
        displayDiaryContent = remarks.join('；')
      } else {
        displayDiaryContent = '今天宝贝超级听话乖巧，按时吃完了准备好的粮食和冻干，饮水充足，全屋环境均已清理消毒。互动时一直蹭手撒娇，活力满满～'
      }
    }
    if (displayDiaryContent.length > 130) {
      displayDiaryContent = displayDiaryContent.slice(0, 128) + '...'
    }

    // 5. 宠托师姓名与服务时间
    const staffDisplayName = order.staffName || order.staffNickName || '平台专业宠托师'
    const serviceDateText = order.serviceTime || order.startTime || '今日圆满履约'
    const serviceSummaryText = order.businessTypeText || '上门照料服务'

    this.setData({
      showExportModal: true,
      allPhotos,
      selectedPhotoIndex: 0,
      heroPhotoUrl: allPhotos.length ? allPhotos[0] : '',
      petDisplayName,
      petSpeciesText,
      petBeautyTitle,
      serviceSummaryText,
      serviceDateText,
      displayDiaryContent,
      staffDisplayName,
      evidencePhotos
    })
  },

  closeExportModal() {
    this.setData({ showExportModal: false })
  },

  switchTemplate(e) {
    const tpl = e.currentTarget.dataset.tpl
    if (tpl) this.setData({ currentTemplate: tpl })
  },

  selectPosterCover(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!isNaN(index) && this.data.allPhotos[index]) {
      this.setData({
        selectedPhotoIndex: index,
        heroPhotoUrl: this.data.allPhotos[index]
      })
    }
  },

  noop() {},

  // 一键复制适合小红书/抖音图文直接发布的爆款文案
  copySocialMediaPost() {
    const {
      petDisplayName,
      petSpeciesText,
      staffDisplayName,
      serviceSummaryText,
      displayDiaryContent,
      report
    } = this.data

    const orderNo = (report && report.order && report.order.orderNo) || ''
    const checkinsCount = (report && report.checkins && report.checkins.length) || 0

    const text = `✨ 今日份毛孩子托养手账已送达 🐾
---------------------------
🏠 宝贝档案：【${petDisplayName}】· ${petSpeciesText}
🏷️ 服务项目：${serviceSummaryText}
👩‍💼 宠托师：${staffDisplayName}
📋 履约凭证：单号 ${orderNo} · 累计完成 ${checkinsCount} 项打卡

【履约打卡标准全清单】
✅ 准时上门，穿戴鞋套与专业消毒
🥣 科学定量投喂粮水，水碗深度洁净
🧹 猫砂/宠物便溺彻底清理，居室环境消杀
💖 梳毛陪伴、轻抚互动，状态活力满格！

【宠托师手记】
“${displayDiaryContent}”

#与宠同乐 #上门喂养 #宠托师 #毛孩子的神仙托儿所 #萌宠日常记录 #铲屎官安心出差 #猫咪上门喂养`

    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({
          title: '文案已复制！可直接发小红书/抖音',
          icon: 'none',
          duration: 2500
        })
      }
    })
  },

  // 通过 Canvas 2D 离屏绘制 750x1334 高清海报并保存到系统相册
  savePosterToAlbum() {
    if (this.data.generatingPoster) return
    this.setData({ generatingPoster: true })
    wx.showLoading({ title: '正在渲染高清海报...' })

    // 1. 获取 Canvas 节点
    const query = wx.createSelectorQuery().in(this)
    query
      .select('#exportCanvas')
      .fields({ node: true, size: true })
      .exec(async (res) => {
        if (!res || !res[0] || !res[0].node) {
          wx.hideLoading()
          this.setData({ generatingPoster: false })
          wx.showToast({ title: '画布初始化异常', icon: 'none' })
          return
        }

        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const width = 750
        const height = 1334

        // 绑定物理像素
        canvas.width = width
        canvas.height = height

        try {
          const tpl = this.data.currentTemplate || 'diary'
          const {
            heroPhotoUrl,
            evidencePhotos,
            petDisplayName,
            petSpeciesText,
            petBeautyTitle,
            serviceSummaryText,
            serviceDateText,
            displayDiaryContent,
            staffDisplayName,
            report
          } = this.data

          // 2. 先异步把图片下载并转换成 Image 对象
          const heroLocalPath = await resolveLocalPhoto(heroPhotoUrl)
          const heroImg = await loadCanvasImage(canvas, heroLocalPath)

          const gridImgs = []
          for (let i = 0; i < Math.min(evidencePhotos.length, 4); i++) {
            const p = await resolveLocalPhoto(evidencePhotos[i].url)
            const img = await loadCanvasImage(canvas, p)
            gridImgs.push({ img, label: evidencePhotos[i].label })
          }

          // 3. 开始根据不同模版风格绘制海报
          if (tpl === 'magazine') {
            // ========================
            // 模版 2：时尚宠刊风 (Magazine)
            // ========================
            const bgGrad = ctx.createLinearGradient(0, 0, 0, height)
            bgGrad.addColorStop(0, '#191b20')
            bgGrad.addColorStop(0.5, '#232630')
            bgGrad.addColorStop(1, '#141519')
            ctx.fillStyle = bgGrad
            ctx.fillRect(0, 0, width, height)

            // 顶部报头
            drawRoundedRect(ctx, 40, 48, 260, 42, 6, 'rgba(255,255,255,0.08)', 'rgba(212,175,55,0.5)', 1)
            ctx.fillStyle = '#f7d488'
            ctx.font = 'bold 20px sans-serif'
            ctx.fillText('PET LIFE JOURNAL', 60, 76)

            ctx.fillStyle = '#9da0ae'
            ctx.font = '18px sans-serif'
            ctx.fillText(serviceDateText || 'VOL. 2026 ISSUE', 480, 76)

            // 标题区
            ctx.fillStyle = '#ffffff'
            ctx.font = '900 48px sans-serif'
            ctx.fillText(petDisplayName, 40, 148)

            drawRoundedRect(ctx, 40 + ctx.measureText(petDisplayName).width + 16, 114, 120, 36, 6, 'rgba(255,255,255,0.12)', null)
            ctx.fillStyle = '#e5e7eb'
            ctx.font = 'bold 20px sans-serif'
            ctx.fillText(petSpeciesText, 40 + ctx.measureText(petDisplayName).width + 30, 140)

            ctx.fillStyle = '#8e92a4'
            ctx.font = '18px sans-serif'
            ctx.fillText('EXCLUSIVE CARE REPORT · PLATFORM ASSURED', 40, 184)

            // Hero 大图
            const heroY = 210
            const heroH = 460
            drawRoundedRect(ctx, 40, heroY, 670, heroH, 18, '#262933', 'rgba(255,255,255,0.1)', 1)
            if (heroImg) {
              ctx.save()
              ctx.beginPath()
              ctx.arcTo(40 + 670, heroY, 40 + 670, heroY + heroH, 18)
              ctx.arcTo(40 + 670, heroY + heroH, 40, heroY + heroH, 18)
              ctx.arcTo(40, heroY + heroH, 40, heroY, 18)
              ctx.arcTo(40, heroY, 40 + 670, heroY, 18)
              ctx.closePath()
              ctx.clip()
              ctx.drawImage(heroImg, 40, heroY, 670, heroH)
              ctx.restore()
            }
            // 杂志角标
            drawRoundedRect(ctx, 510, heroY + heroH - 74, 180, 56, 8, 'rgba(20,21,25,0.88)', '#f7d488', 1.5)
            ctx.fillStyle = '#f7d488'
            ctx.font = '900 20px sans-serif'
            ctx.fillText('VERIFIED', 545, heroY + heroH - 46)
            ctx.fillStyle = '#a3a6b2'
            ctx.font = '12px sans-serif'
            ctx.fillText('QUALITY ASSURED', 535, heroY + heroH - 28)

            // 拼图网格
            if (gridImgs.length) {
              const gridY = 694
              const itemW = 158
              const itemH = 110
              for (let i = 0; i < gridImgs.length; i++) {
                const gx = 40 + i * (itemW + 12)
                drawRoundedRect(ctx, gx, gridY, itemW, itemH, 10, '#262933', 'rgba(255,255,255,0.1)', 1)
                if (gridImgs[i].img) {
                  ctx.save()
                  ctx.beginPath()
                  ctx.arcTo(gx + itemW, gridY, gx + itemW, gridY + itemH, 10)
                  ctx.arcTo(gx + itemW, gridY + itemH, gx, gridY + itemH, 10)
                  ctx.arcTo(gx, gridY + itemH, gx, gridY, 10)
                  ctx.arcTo(gx, gridY, gx + itemW, gridY, 10)
                  ctx.closePath()
                  ctx.clip()
                  ctx.drawImage(gridImgs[i].img, gx, gridY, itemW, itemH)
                  ctx.restore()
                }
                drawRoundedRect(ctx, gx, gridY + itemH - 26, itemW, 26, 0, 'rgba(0,0,0,0.6)', null)
                ctx.fillStyle = '#ffffff'
                ctx.font = '14px sans-serif'
                ctx.fillText(gridImgs[i].label, gx + 16, gridY + itemH - 8)
              }
            }

            // 指标胶囊
            const metricY = 830
            const metrics = ['✅ 准时到达', '🥣 进食正常', '🧹 清洁消杀', '💯 状态满分']
            for (let i = 0; i < 4; i++) {
              const mx = 40 + i * 168
              drawRoundedRect(ctx, mx, metricY, 160, 42, 21, i === 3 ? '#d4af37' : 'rgba(255,255,255,0.08)', null)
              ctx.fillStyle = i === 3 ? '#1a1c22' : '#e5e7eb'
              ctx.font = 'bold 18px sans-serif'
              ctx.fillText(metrics[i], mx + 16, metricY + 28)
            }

            // 语录卡片
            const noteY = 900
            drawRoundedRect(ctx, 40, noteY, 670, 180, 16, 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.1)', 1)
            ctx.fillStyle = '#d4af37'
            ctx.font = 'bold 36px serif'
            ctx.fillText('“', 64, noteY + 44)
            ctx.fillStyle = '#d1d5db'
            ctx.font = '22px sans-serif'
            drawMultilineText(ctx, displayDiaryContent, 90, noteY + 48, 560, 34, 3)

            // 底部背书栏
            const footY = 1110
            ctx.strokeStyle = 'rgba(255,255,255,0.15)'
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(40, footY)
            ctx.lineTo(710, footY)
            ctx.stroke()

            ctx.fillStyle = '#ffffff'
            ctx.font = 'bold 28px sans-serif'
            ctx.fillText(staffDisplayName, 40, footY + 54)
            ctx.fillStyle = '#9da0ae'
            ctx.font = '18px sans-serif'
            ctx.fillText(`服务单号：${(report && report.order && report.order.orderNo) || ''}`, 40, footY + 92)

            // 杂志版印章
            drawRoundedRect(ctx, 570, footY + 16, 130, 90, 8, 'rgba(212,175,55,0.15)', '#d4af37', 1.5)
            ctx.fillStyle = '#d4af37'
            ctx.font = 'bold 18px sans-serif'
            ctx.fillText('AUDITED', 594, footY + 52)
            ctx.font = '14px sans-serif'
            ctx.fillText('与宠同乐认证', 586, footY + 80)
          } else if (tpl === 'certified') {
            // ========================
            // 模版 3：安心履约认证风 (Certified)
            // ========================
            const bgGrad = ctx.createLinearGradient(0, 0, 0, height)
            bgGrad.addColorStop(0, '#eefaf4')
            bgGrad.addColorStop(0.35, '#f7fdfa')
            bgGrad.addColorStop(1, '#ffffff')
            ctx.fillStyle = bgGrad
            ctx.fillRect(0, 0, width, height)

            // 顶部官方标牌
            drawRoundedRect(ctx, 40, 48, 320, 44, 22, '#00b42a', null)
            ctx.fillStyle = '#ffffff'
            ctx.font = 'bold 22px sans-serif'
            ctx.fillText('🛡️ 官方履约安心认证', 64, 78)

            ctx.fillStyle = '#088c52'
            ctx.font = 'bold 18px sans-serif'
            ctx.fillText(serviceDateText || '品质履约·全链溯源', 460, 78)

            // 标题区
            ctx.fillStyle = '#0f382c'
            ctx.font = '900 48px sans-serif'
            ctx.fillText(petDisplayName, 40, 150)

            drawRoundedRect(ctx, 40 + ctx.measureText(petDisplayName).width + 16, 116, 120, 36, 18, '#d4f7e5', null)
            ctx.fillStyle = '#088c52'
            ctx.font = 'bold 20px sans-serif'
            ctx.fillText(petSpeciesText, 40 + ctx.measureText(petDisplayName).width + 30, 142)

            ctx.fillStyle = '#3b7160'
            ctx.font = '20px sans-serif'
            ctx.fillText('专业宠托全流程打卡 · 100% 实名背书与合规检测', 40, 186)

            // Hero 大图
            const heroY = 210
            const heroH = 460
            drawRoundedRect(ctx, 40, heroY, 670, heroH, 20, '#ffffff', '#cceee0', 4)
            if (heroImg) {
              ctx.save()
              ctx.beginPath()
              ctx.arcTo(40 + 670, heroY, 40 + 670, heroY + heroH, 20)
              ctx.arcTo(40 + 670, heroY + heroH, 40, heroY + heroH, 20)
              ctx.arcTo(40, heroY + heroH, 40, heroY, 20)
              ctx.arcTo(40, heroY, 40 + 670, heroY, 20)
              ctx.closePath()
              ctx.clip()
              ctx.drawImage(heroImg, 40, heroY, 670, heroH)
              ctx.restore()
            }
            // 官方合格红色公章
            drawRoundedRect(ctx, 550, heroY + 20, 130, 130, 65, 'rgba(255,255,255,0.92)', '#d9363e', 3)
            ctx.fillStyle = '#d9363e'
            ctx.font = 'bold 16px sans-serif'
            ctx.fillText('安心履约', 582, heroY + 62)
            ctx.font = '900 32px sans-serif'
            ctx.fillText('合格', 580, heroY + 98)
            ctx.font = 'bold 14px sans-serif'
            ctx.fillText('PASS', 594, heroY + 124)

            // 拼图网格
            if (gridImgs.length) {
              const gridY = 694
              const itemW = 158
              const itemH = 110
              for (let i = 0; i < gridImgs.length; i++) {
                const gx = 40 + i * (itemW + 12)
                drawRoundedRect(ctx, gx, gridY, itemW, itemH, 12, '#eefaf4', '#cceee0', 2)
                if (gridImgs[i].img) {
                  ctx.save()
                  ctx.beginPath()
                  ctx.arcTo(gx + itemW, gridY, gx + itemW, gridY + itemH, 12)
                  ctx.arcTo(gx + itemW, gridY + itemH, gx, gridY + itemH, 12)
                  ctx.arcTo(gx, gridY + itemH, gx, gridY, 12)
                  ctx.arcTo(gx, gridY, gx + itemW, gridY, 12)
                  ctx.closePath()
                  ctx.clip()
                  ctx.drawImage(gridImgs[i].img, gx, gridY, itemW, itemH)
                  ctx.restore()
                }
                drawRoundedRect(ctx, gx, gridY + itemH - 26, itemW, 26, 0, 'rgba(0,0,0,0.6)', null)
                ctx.fillStyle = '#ffffff'
                ctx.font = '14px sans-serif'
                ctx.fillText(gridImgs[i].label, gx + 16, gridY + itemH - 8)
              }
            }

            // 指标胶囊
            const metricY = 830
            const metrics = ['✅ 准时到达', '🥣 饮水进食', '🧹 环境消杀', '💯 状态满分']
            for (let i = 0; i < 4; i++) {
              const mx = 40 + i * 168
              drawRoundedRect(ctx, mx, metricY, 160, 42, 21, i === 3 ? '#00b42a' : '#eefbf4', i === 3 ? null : '#c2f0d9', 1)
              ctx.fillStyle = i === 3 ? '#ffffff' : '#0b784a'
              ctx.font = 'bold 18px sans-serif'
              ctx.fillText(metrics[i], mx + 16, metricY + 28)
            }

            // 语录卡片
            const noteY = 900
            drawRoundedRect(ctx, 40, noteY, 670, 180, 16, '#f4fbf7', '#c6edd7', 1.5)
            ctx.fillStyle = '#088c52'
            ctx.font = 'bold 36px serif'
            ctx.fillText('“', 64, noteY + 44)
            ctx.fillStyle = '#275647'
            ctx.font = '22px sans-serif'
            drawMultilineText(ctx, displayDiaryContent, 90, noteY + 48, 560, 34, 3)

            // 底部背书栏
            const footY = 1110
            ctx.strokeStyle = '#c6edd7'
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(40, footY)
            ctx.lineTo(710, footY)
            ctx.stroke()

            ctx.fillStyle = '#0f382c'
            ctx.font = 'bold 28px sans-serif'
            ctx.fillText(staffDisplayName, 40, footY + 54)
            ctx.fillStyle = '#3b7160'
            ctx.font = '18px sans-serif'
            ctx.fillText(`服务编号：${(report && report.order && report.order.orderNo) || ''}`, 40, footY + 92)

            // 官方双圈公章
            drawRoundedRect(ctx, 580, footY + 10, 106, 106, 53, 'rgba(255,255,255,0.9)', '#d9363e', 3)
            ctx.fillStyle = '#d9363e'
            ctx.font = '900 12px sans-serif'
            ctx.fillText('与宠同乐·质保', 592, footY + 42)
            ctx.font = 'bold 12px sans-serif'
            ctx.fillText('★★★★★', 594, footY + 66)
            ctx.font = '900 14px sans-serif'
            ctx.fillText('AUDITED', 596, footY + 90)
          } else {
            // ========================
            // 模版 1：小红书日记风 (Diary - 默认)
            // ========================
            const bgGrad = ctx.createLinearGradient(0, 0, 0, height)
            bgGrad.addColorStop(0, '#fffcf7')
            bgGrad.addColorStop(0.4, '#fff7ec')
            bgGrad.addColorStop(1, '#ffefe0')
            ctx.fillStyle = bgGrad
            ctx.fillRect(0, 0, width, height)

            // 和纸胶带
            drawRoundedRect(ctx, 290, 0, 170, 32, 6, '#ffd591', null)

            // 顶部标头
            drawRoundedRect(ctx, 40, 52, 280, 42, 21, '#ffffff', 'rgba(255,122,69,0.2)', 1)
            ctx.fillStyle = '#ff7a45'
            ctx.beginPath()
            ctx.arc(62, 73, 6, 0, Math.PI * 2)
            ctx.fill()

            ctx.fillStyle = '#d46328'
            ctx.font = 'bold 20px sans-serif'
            ctx.fillText('与宠同乐 · 今日托养手账', 80, 80)

            ctx.fillStyle = '#967f70'
            ctx.font = 'bold 18px sans-serif'
            ctx.fillText(serviceDateText || '今日快乐托养', 500, 80)

            // 标题区
            ctx.fillStyle = '#2e1d13'
            ctx.font = '900 48px sans-serif'
            ctx.fillText(petDisplayName, 40, 150)

            const nameWidth = ctx.measureText(petDisplayName).width
            drawRoundedRect(ctx, 40 + nameWidth + 16, 116, 110, 36, 18, '#ffe3d3', null)
            ctx.fillStyle = '#cf5618'
            ctx.font = 'bold 20px sans-serif'
            ctx.fillText(petSpeciesText, 40 + nameWidth + 28, 142)

            drawRoundedRect(ctx, 40 + nameWidth + 138, 116, 150, 36, 18, '#fff3bf', null)
            ctx.fillStyle = '#b46b00'
            ctx.font = 'bold 20px sans-serif'
            ctx.fillText(petBeautyTitle, 40 + nameWidth + 148, 142)

            ctx.fillStyle = '#8c7362'
            ctx.font = '20px sans-serif'
            ctx.fillText('又是被宝贝治愈的一天 ✨ 干粮吃光光 乖巧满分', 40, 186)

            // Hero 大图（拍立得相框风格）
            const heroY = 210
            const heroH = 430
            // 白色相纸边框与下沿
            drawRoundedRect(ctx, 40, heroY, 670, heroH + 60, 24, '#ffffff', 'rgba(100,68,42,0.1)', 1)
            if (heroImg) {
              ctx.save()
              ctx.beginPath()
              ctx.arcTo(56 + 638, heroY + 16, 56 + 638, heroY + 16 + heroH, 16)
              ctx.arcTo(56 + 638, heroY + 16 + heroH, 56, heroY + 16 + heroH, 16)
              ctx.arcTo(56, heroY + 16 + heroH, 56, heroY + 16, 16)
              ctx.arcTo(56, heroY + 16, 56 + 638, heroY + 16, 16)
              ctx.closePath()
              ctx.clip()
              ctx.drawImage(heroImg, 56, heroY + 16, 638, heroH)
              ctx.restore()
            }
            // 拍立得下方手写印记
            ctx.fillStyle = '#d45f22'
            ctx.font = 'bold 22px sans-serif'
            ctx.fillText(`❤️ ${serviceSummaryText} · 快乐记录`, 240, heroY + heroH + 46)

            // 拼图网格
            if (gridImgs.length) {
              const gridY = 724
              const itemW = 158
              const itemH = 110
              for (let i = 0; i < gridImgs.length; i++) {
                const gx = 40 + i * (itemW + 12)
                drawRoundedRect(ctx, gx, gridY, itemW, itemH, 16, '#ffffff', 'rgba(255,122,69,0.15)', 2)
                if (gridImgs[i].img) {
                  ctx.save()
                  ctx.beginPath()
                  ctx.arcTo(gx + itemW, gridY, gx + itemW, gridY + itemH, 16)
                  ctx.arcTo(gx + itemW, gridY + itemH, gx, gridY + itemH, 16)
                  ctx.arcTo(gx, gridY + itemH, gx, gridY, 16)
                  ctx.arcTo(gx, gridY, gx + itemW, gridY, 16)
                  ctx.closePath()
                  ctx.clip()
                  ctx.drawImage(gridImgs[i].img, gx, gridY, itemW, itemH)
                  ctx.restore()
                }
                drawRoundedRect(ctx, gx, gridY + itemH - 26, itemW, 26, 0, 'rgba(0,0,0,0.58)', null)
                ctx.fillStyle = '#ffffff'
                ctx.font = '14px sans-serif'
                ctx.fillText(gridImgs[i].label, gx + 16, gridY + itemH - 8)
              }
            }

            // 指标胶囊
            const metricY = 856
            const metrics = ['✅ 准时到达', '🥣 进食正常', '🧹 清理消杀', '💯 状态满分']
            for (let i = 0; i < 4; i++) {
              const mx = 40 + i * 168
              drawRoundedRect(ctx, mx, metricY, 160, 42, 21, i === 3 ? '#ff7a45' : '#ffffff', i === 3 ? null : 'rgba(255,122,69,0.2)', 1)
              ctx.fillStyle = i === 3 ? '#ffffff' : '#59473d'
              ctx.font = 'bold 18px sans-serif'
              ctx.fillText(metrics[i], mx + 16, metricY + 28)
            }

            // 语录卡片
            const noteY = 924
            drawRoundedRect(ctx, 40, noteY, 670, 170, 20, '#fffdf5', '#ffd591', 2)
            ctx.fillStyle = '#ff9800'
            ctx.font = 'bold 36px serif'
            ctx.fillText('“', 64, noteY + 44)
            ctx.fillStyle = '#614d3f'
            ctx.font = '22px sans-serif'
            drawMultilineText(ctx, displayDiaryContent, 90, noteY + 48, 560, 34, 3)

            // 底部背书栏
            const footY = 1120
            ctx.strokeStyle = 'rgba(160,140,120,0.25)'
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(40, footY)
            ctx.lineTo(710, footY)
            ctx.stroke()

            ctx.fillStyle = '#2d211a'
            ctx.font = 'bold 28px sans-serif'
            ctx.fillText(staffDisplayName, 40, footY + 54)
            ctx.fillStyle = '#928377'
            ctx.font = '18px sans-serif'
            ctx.fillText(`服务单号：${(report && report.order && report.order.orderNo) || ''}`, 40, footY + 92)

            // 日记风圆印章
            drawRoundedRect(ctx, 580, footY + 10, 106, 106, 53, 'rgba(255,255,255,0.9)', '#d9363e', 3)
            ctx.fillStyle = '#d9363e'
            ctx.font = '900 12px sans-serif'
            ctx.fillText('与宠同乐·质保', 592, footY + 42)
            ctx.font = 'bold 12px sans-serif'
            ctx.fillText('★★★★★', 594, footY + 66)
            ctx.font = '900 14px sans-serif'
            ctx.fillText('AUDITED', 596, footY + 90)
          }

          // 4. 将 Canvas 保存为临时图片
          wx.canvasToTempFilePath(
            {
              canvas,
              width,
              height,
              destWidth: width * 2, // 2x 超高清导出
              destHeight: height * 2,
              fileType: 'png',
              quality: 1,
              success: (tempRes) => {
                const tempFilePath = tempRes.tempFilePath
                // 5. 保存至系统相册
                wx.saveImageToPhotosAlbum({
                  filePath: tempFilePath,
                  success: () => {
                    wx.hideLoading()
                    this.setData({ generatingPoster: false })
                    wx.showToast({ title: '高清海报已保存到相册！', icon: 'success' })
                  },
                  fail: (err) => {
                    wx.hideLoading()
                    this.setData({ generatingPoster: false })
                    // 权限受限时优雅降级：直接唤起大图预览，用户可长按保存
                    wx.previewImage({
                      current: tempFilePath,
                      urls: [tempFilePath]
                    })
                    wx.showToast({
                      title: '已为你打开大图预览，长按可保存',
                      icon: 'none',
                      duration: 3000
                    })
                  }
                })
              },
              fail: (err) => {
                wx.hideLoading()
                this.setData({ generatingPoster: false })
                showError(err)
              }
            },
            this
          )
        } catch (err) {
          wx.hideLoading()
          this.setData({ generatingPoster: false })
          showError(err)
        }
      })
  },

  ...navMethods()
})

