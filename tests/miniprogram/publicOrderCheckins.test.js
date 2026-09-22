const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createCollectionStore, loadCloudFunction } = require('../cloudfunctions/helpers')
const createContext = require('../../cloudfunctions/api/services/context')

test('home service toHomeOrderActivity groups checkins by eventType and extracts first photo for list preview', () => {
  const db = createCollectionStore({})
  const context = createContext({ cloud: {}, db })

  const order = {
    _id: 'order_101',
    orderNo: 'O12345678',
    serviceType: 'feed',
    serviceSummary: '上门喂猫服务',
    petName: '咪咪',
    serviceArea: '测试小区 1号楼',
    doorplate: '敏感门牌号801',
    addressLatitude: 31.123,
    addressLongitude: 121.456,
    startTime: '2026-09-22 10:00',
    completedAt: '2026-09-22 11:00'
  }

  // 4个环节，共6张照片：
  // 环节1 enter_door (入户打卡): 2张
  // 环节2 clean_litter (铲屎清理): 2张
  // 环节3 feed_water (加水添粮): 1张
  // 环节4 accompany (互动陪伴): 1张
  const checkins = [
    { _id: 'ck_1', eventType: 'enter_door', mediaFileId: 'cloud://img_enter_1.jpg', recordedAt: '2026-09-22 10:05' },
    { _id: 'ck_2', eventType: 'enter_door', mediaFileId: 'cloud://img_enter_2.jpg', recordedAt: '2026-09-22 10:06' },
    { _id: 'ck_3', eventType: 'clean_litter', mediaFileId: 'cloud://img_litter_1.jpg', recordedAt: '2026-09-22 10:15' },
    { _id: 'ck_4', eventType: 'clean_litter', mediaFileId: 'cloud://img_litter_2.jpg', recordedAt: '2026-09-22 10:16' },
    { _id: 'ck_5', eventType: 'feed_water', mediaFileId: 'cloud://img_feed_1.jpg', recordedAt: '2026-09-22 10:25' },
    { _id: 'ck_6', eventType: 'accompany', mediaFileId: 'cloud://img_play_1.jpg', recordedAt: '2026-09-22 10:40' }
  ]

  const activity = context.toHomeOrderActivity(order, {
    checkins,
    staffProfile: { name: '王阿姨' },
    hideCheckinPhotos: false
  })

  // 1. 验证分组：总共 4 个项目
  assert.equal(activity.checkinSections.length, 4)
  assert.equal(activity.checkinSections[0].eventType, 'enter_door')
  assert.equal(activity.checkinSections[0].photos.length, 2)
  assert.equal(activity.checkinSections[0].firstPhoto.mediaFileId, 'cloud://img_enter_1.jpg')

  assert.equal(activity.checkinSections[1].eventType, 'clean_litter')
  assert.equal(activity.checkinSections[1].photos.length, 2)
  assert.equal(activity.checkinSections[1].firstPhoto.mediaFileId, 'cloud://img_litter_1.jpg')

  assert.equal(activity.checkinSections[2].eventType, 'feed_water')
  assert.equal(activity.checkinSections[2].photos.length, 1)

  assert.equal(activity.checkinSections[3].eventType, 'accompany')
  assert.equal(activity.checkinSections[3].photos.length, 1)

  // 2. 验证列表预览照片：提取每个项目的第一张，共 4 张
  assert.equal(activity.checkinPhotos.length, 4)
  assert.deepEqual(
    activity.checkinPhotos.map((p) => p.mediaFileId),
    [
      'cloud://img_enter_1.jpg',
      'cloud://img_litter_1.jpg',
      'cloud://img_feed_1.jpg',
      'cloud://img_play_1.jpg'
    ]
  )

  // 3. 验证详情展示所有打卡照片与计数
  assert.equal(activity.totalPhotoCount, 6)
  assert.equal(activity.allCheckinPhotos.length, 6)

  // 4. 验证隐私脱敏：不能泄露详细门牌与经纬度
  assert.equal(activity.doorplate, undefined)
  assert.equal(activity.addressLatitude, undefined)
  assert.equal(activity.addressLongitude, undefined)
})

test('home service hides checkin photos if client configured privacy', () => {
  const db = createCollectionStore({})
  const context = createContext({ cloud: {}, db })

  const order = { _id: 'order_102', serviceSummary: '上门遛狗' }
  const checkins = [
    { _id: 'ck_1', eventType: 'enter_door', mediaFileId: 'cloud://img1.jpg' },
    { _id: 'ck_2', eventType: 'leave_door', mediaFileId: 'cloud://img2.jpg' }
  ]

  const activity = context.toHomeOrderActivity(order, {
    checkins,
    hideCheckinPhotos: true
  })

  assert.equal(activity.checkinPhotosHidden, true)
  assert.equal(activity.checkinPhotos.length, 0)
  assert.equal(activity.checkinSections.length, 0)
  assert.equal(activity.allCheckinPhotos.length, 0)
  assert.equal(activity.totalPhotoCount, 0)
})

test('public-list WXML and JS preview behavior', () => {
  const listWxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/public-list/index.wxml')
  const listWxml = fs.readFileSync(listWxmlPath, 'utf8')

  assert.ok(listWxml.includes('wx:for-item="photo"'), 'Must specify wx:for-item="photo" to avoid shadowing order item')
  assert.ok(listWxml.includes('data-order-id="{{item._id}}"'), 'Must pass order._id for image preview lookup')
  assert.ok(listWxml.includes('class="checkin-badge"'), 'Must have checkin badge on preview photos')
  assert.ok(listWxml.includes('{{photo.eventText}}'), 'Must display eventText on preview badge')

  // JS preview logic check
  let previewCalled = false
  let previewArgs = null
  global.wx = {
    previewImage(args) {
      previewCalled = true
      previewArgs = args
    }
  }

  let capturedPageDef = null
  global.Page = (def) => {
    capturedPageDef = def
  }

  require('../../miniprogram/pages/client/orders/public-list/index.js')
  assert.ok(capturedPageDef, 'Page must be defined')
  assert.equal(typeof capturedPageDef.previewPhoto, 'function')

  const mockInstance = {
    data: {
      orders: [
        {
          _id: 'order_1',
          checkinPhotos: [
            { mediaFileId: 'img_first_1.jpg', eventText: '项目1' },
            { mediaFileId: 'img_first_2.jpg', eventText: '项目2' }
          ],
          allCheckinPhotos: [
            { mediaFileId: 'img_first_1.jpg' },
            { mediaFileId: 'img_first_1_more.jpg' },
            { mediaFileId: 'img_first_2.jpg' }
          ]
        }
      ]
    }
  }

  // Call previewPhoto
  capturedPageDef.previewPhoto.call(mockInstance, {
    currentTarget: {
      dataset: {
        url: 'img_first_1.jpg',
        orderId: 'order_1'
      }
    }
  })

  assert.equal(previewCalled, true)
  assert.equal(previewArgs.current, 'img_first_1.jpg')
  assert.deepEqual(previewArgs.urls, ['img_first_1.jpg', 'img_first_1_more.jpg', 'img_first_2.jpg'])
})

test('public-detail WXML, WXSS and JS support full sectioned photo display and preview', () => {
  const detailWxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/public-detail/index.wxml')
  const detailWxml = fs.readFileSync(detailWxmlPath, 'utf8')

  assert.ok(detailWxml.includes('checkin-section-list'), 'Must have checkin-section-list container')
  assert.ok(detailWxml.includes('wx:for="{{detail.checkinSections}}"'), 'Must loop through checkinSections')
  assert.ok(detailWxml.includes('wx:for="{{sec.photos}}"'), 'Must loop through all photos under each section')
  assert.ok(detailWxml.includes('photo-total-pill'), 'Must show total photo pill')

  const detailWxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/public-detail/index.wxss')
  const detailWxss = fs.readFileSync(detailWxssPath, 'utf8')

  assert.ok(detailWxss.includes('.checkin-section-list'), 'Must have .checkin-section-list in wxss')
  assert.ok(detailWxss.includes('.checkin-section-group'), 'Must have .checkin-section-group in wxss')
  assert.ok(detailWxss.includes('.section-photo-grid'), 'Must have .section-photo-grid in wxss')
  assert.ok(detailWxss.includes('.section-photo-card'), 'Must have .section-photo-card in wxss')

  let previewDetailCalled = false
  let previewDetailArgs = null
  global.wx = {
    previewImage(args) {
      previewDetailCalled = true
      previewDetailArgs = args
    }
  }

  let capturedDetailPageDef = null
  global.Page = (def) => {
    capturedDetailPageDef = def
  }

  require('../../miniprogram/pages/client/orders/public-detail/index.js')
  assert.ok(capturedDetailPageDef, 'DetailPage must be defined')
  assert.equal(typeof capturedDetailPageDef.previewPhoto, 'function')

  const mockDetailInstance = {
    data: {
      detail: {
        _id: 'order_101',
        checkinSections: [
          {
            eventType: 'enter_door',
            eventText: '入户拍照',
            photos: [{ mediaFileId: 'p1.jpg' }, { mediaFileId: 'p2.jpg' }]
          },
          {
            eventType: 'feed_water',
            eventText: '加水添粮',
            photos: [{ mediaFileId: 'p3.jpg' }]
          }
        ],
        allCheckinPhotos: [
          { mediaFileId: 'p1.jpg' },
          { mediaFileId: 'p2.jpg' },
          { mediaFileId: 'p3.jpg' }
        ]
      }
    }
  }

  capturedDetailPageDef.previewPhoto.call(mockDetailInstance, {
    currentTarget: {
      dataset: {
        url: 'p2.jpg'
      }
    }
  })

  assert.equal(previewDetailCalled, true)
  assert.equal(previewDetailArgs.current, 'p2.jpg')
  assert.deepEqual(previewDetailArgs.urls, ['p1.jpg', 'p2.jpg', 'p3.jpg'])
})
