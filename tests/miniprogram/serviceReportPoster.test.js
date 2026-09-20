const test = require('node:test')
const assert = require('node:assert/strict')

// 模拟微信小程序环境
let clipboardData = ''
let toastMessage = ''
global.wx = {
  getStorageSync: () => null,
  setStorageSync: () => {},
  setClipboardData: ({ data, success }) => {
    clipboardData = data
    if (success) success()
  },
  showToast: ({ title }) => {
    toastMessage = title
  },
  showLoading: () => {},
  hideLoading: () => {}
}
global.getApp = () => ({ globalData: { env: 'test-env' } })

// 载入报告页面定义
let pageConfig = null
global.Page = (cfg) => {
  pageConfig = cfg
}

require('../../miniprogram/pages/client/orders/report/index')

test('service report poster export modal extracts and formats poster data correctly', () => {
  assert.ok(pageConfig, 'Page config should be registered')

  const instance = {
    data: { ...pageConfig.data },
    setData(patch) {
      Object.assign(this.data, patch)
    }
  }

  // 绑定方法
  Object.keys(pageConfig).forEach((key) => {
    if (typeof pageConfig[key] === 'function') {
      instance[key] = pageConfig[key].bind(instance)
    }
  })

  // 准备 mock 报告数据
  instance.data.report = {
    order: {
      orderNo: 'O202609208888',
      staffName: '王牌宠托师·小李',
      businessTypeText: '猫咪上门全流程照料',
      serviceTime: '2026-09-20 14:00',
      pet: {
        name: '汤圆',
        breed: '银渐层'
      }
    },
    checkins: [
      { mediaFileId: 'cloud://photo1.jpg' },
      { mediaFileId: 'cloud://photo2.jpg' },
      { mediaFileId: 'cloud://photo1.jpg' }, // 重复图
      { mediaFileId: 'cloud://photo3.jpg' }
    ],
    checkinGroups: [
      {
        eventTypeText: '全屋环境消杀',
        remarkText: '进门已佩戴鞋套与手套消毒',
        photos: [{ mediaFileId: 'cloud://photo1.jpg' }]
      },
      {
        eventTypeText: '换水加粮',
        remarkText: '吃光了主食罐头',
        photos: [{ mediaFileId: 'cloud://photo2.jpg' }]
      }
    ]
  }

  // 打开海报导出弹窗
  instance.openExportModal()

  assert.equal(instance.data.showExportModal, true)
  assert.equal(instance.data.petDisplayName, '汤圆')
  assert.equal(instance.data.petSpeciesText, '银渐层')
  assert.equal(instance.data.staffDisplayName, '王牌宠托师·小李')
  assert.equal(instance.data.serviceSummaryText, '猫咪上门全流程照料')
  assert.equal(instance.data.allPhotos.length, 3, '应当去重后保留3张照片')
  assert.equal(instance.data.heroPhotoUrl, 'cloud://photo1.jpg')
  assert.equal(instance.data.evidencePhotos.length, 2)
  assert.ok(instance.data.displayDiaryContent.includes('进门已佩戴鞋套与手套消毒'))

  // 测试模板切换
  instance.switchTemplate({ currentTarget: { dataset: { tpl: 'magazine' } } })
  assert.equal(instance.data.currentTemplate, 'magazine')

  instance.switchTemplate({ currentTarget: { dataset: { tpl: 'certified' } } })
  assert.equal(instance.data.currentTemplate, 'certified')

  // 测试主图切换
  instance.selectPosterCover({ currentTarget: { dataset: { index: 2 } } })
  assert.equal(instance.data.selectedPhotoIndex, 2)
  assert.equal(instance.data.heroPhotoUrl, 'cloud://photo3.jpg')

  // 测试复制爆款社媒文案
  instance.copySocialMediaPost()
  assert.ok(clipboardData.includes('【汤圆】· 银渐层'))
  assert.ok(clipboardData.includes('O202609208888'))
  assert.ok(clipboardData.includes('王牌宠托师·小李'))
  assert.ok(clipboardData.includes('#与宠同乐'))
  assert.ok(clipboardData.includes('#上门喂养'))
  assert.ok(clipboardData.includes('#宠托师'))
  assert.ok(toastMessage.includes('文案已复制'))

  // 关闭弹窗
  instance.closeExportModal()
  assert.equal(instance.data.showExportModal, false)
})
