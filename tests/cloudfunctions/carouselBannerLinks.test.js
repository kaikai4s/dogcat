const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin can save and retrieve carousel banners with jump link configuration', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_openid', roles: ['admin'], status: 'active' }
    ],
    admins: [
      { _id: 'a1', openid: 'admin_openid', name: '总管理员', status: 'active', permissions: ['all'] }
    ],
    platform_configs: [],
    admin_operation_logs: []
  })

  const adminApi = loadCloudFunction('api', db, 'admin_openid')
  const publicApi = loadCloudFunction('api', db, 'any_user_openid')

  // 1. Admin saves settings with carousel link configuration
  const saveEvent = {
    module: 'admin',
    action: 'saveSystemSettings',
    data: {
      homeHeroCarousel: {
        enabled: true,
        autoRotate: true,
        rotateIntervalMs: 6000,
        items: [
          {
            id: 'banner_mall',
            type: 'image',
            fileId: 'cloud://mall_banner.jpg',
            title: '宠物好物节',
            subtitle: '限时 8 折',
            linkType: 'mall',
            linkUrl: '/pages/client/mall/list/index',
            linkTitle: '逛商城',
            sort: 10,
            enabled: true
          },
          {
            id: 'banner_booking',
            type: 'image',
            fileId: 'cloud://booking_banner.jpg',
            title: '预约上门宠护',
            subtitle: '专业贴心',
            linkType: 'booking',
            linkUrl: '/pages/client/orders/create/index?serviceType=cat_visit',
            linkTitle: '去预约',
            sort: 20,
            enabled: true
          },
          {
            id: 'banner_none',
            type: 'image',
            fileId: 'cloud://plain_banner.jpg',
            title: '品牌形象宣传',
            subtitle: '安心托付每一天',
            linkType: 'none',
            linkUrl: '',
            linkTitle: '',
            sort: 30,
            enabled: true
          }
        ]
      }
    }
  }

  const saveRes = await adminApi.main(saveEvent)
  assert.equal(saveRes.ok, true, 'Save settings should succeed')
  const savedCarousel = saveRes.data.homeHeroCarousel
  assert.equal(savedCarousel.enabled, true)
  assert.equal(savedCarousel.items.length, 3)

  // Verify first item has mall link
  assert.equal(savedCarousel.items[0].id, 'banner_mall')
  assert.equal(savedCarousel.items[0].linkType, 'mall')
  assert.equal(savedCarousel.items[0].linkUrl, '/pages/client/mall/list/index')
  assert.equal(savedCarousel.items[0].linkTitle, '逛商城')

  // Verify second item has booking link with query parameters
  assert.equal(savedCarousel.items[1].id, 'banner_booking')
  assert.equal(savedCarousel.items[1].linkType, 'booking')
  assert.equal(savedCarousel.items[1].linkUrl, '/pages/client/orders/create/index?serviceType=cat_visit')
  assert.equal(savedCarousel.items[1].linkTitle, '去预约')

  // Verify third item has no link
  assert.equal(savedCarousel.items[2].id, 'banner_none')
  assert.equal(savedCarousel.items[2].linkType, 'none')
  assert.equal(savedCarousel.items[2].linkUrl, '')

  // 2. Client retrieves settings via system.getSettings
  const getEvent = {
    module: 'system',
    action: 'getSettings'
  }
  const getRes = await publicApi.main(getEvent)
  assert.equal(getRes.ok, true)
  const clientCarousel = getRes.data.homeHeroCarousel
  assert.equal(clientCarousel.items.length, 3)
  assert.equal(clientCarousel.items[0].linkUrl, '/pages/client/mall/list/index')
  assert.equal(clientCarousel.items[0].linkTitle, '逛商城')
  assert.equal(clientCarousel.items[1].linkUrl, '/pages/client/orders/create/index?serviceType=cat_visit')
  assert.equal(clientCarousel.items[2].linkUrl, '')
})
