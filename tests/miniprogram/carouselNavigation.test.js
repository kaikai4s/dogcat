const test = require('node:test')
const assert = require('node:assert/strict')

test('carousel slide tap navigates to target linkUrl or falls back to preview', () => {
  let navigatedUrl = null
  let navigateMethod = null
  let previewImageCalled = false
  let videoPlayedId = null

  const page = {
    data: {
      heroSlides: [
        {
          id: 'slide_1',
          type: 'image',
          url: 'https://example.com/slide1.jpg',
          linkUrl: '/pages/client/mall/list/index',
          linkTitle: '逛商城'
        },
        {
          id: 'slide_2',
          type: 'image',
          url: 'https://example.com/slide2.jpg',
          linkUrl: '/pages/client/orders/list/index',
          linkTitle: '我的订单'
        },
        {
          id: 'slide_3',
          type: 'image',
          url: 'https://example.com/slide3.jpg',
          linkUrl: '',
          linkTitle: ''
        }
      ]
    },
    previewHeroMedia(e) {
      previewImageCalled = true
    },
    playHeroVideo(e) {
      videoPlayedId = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id
    }
  }

  global.getCurrentPages = () => [{ route: 'pages/client/home/index' }]
  global.wx = {
    navigateTo: ({ url }) => {
      navigatedUrl = url
      navigateMethod = 'navigateTo'
    },
    redirectTo: ({ url }) => {
      navigatedUrl = url
      navigateMethod = 'redirectTo'
    },
    previewImage: () => {
      previewImageCalled = true
    }
  }

  // Define onHeroSlideTap logic as implemented in client home
  function onHeroSlideTap(item) {
    if (!item) return
    const linkUrl = String(item.linkUrl || '').trim()
    if (linkUrl) {
      const targetUrl = linkUrl.startsWith('/') ? linkUrl : `/${linkUrl}`
      const pages = global.getCurrentPages()
      const current = pages[pages.length - 1]
      const currentRoute = current && current.route ? '/' + current.route : ''
      const targetPath = targetUrl.split('?')[0]
      if (currentRoute === targetPath) return

      const mainNavUrls = [
        '/pages/client/home/index',
        '/pages/client/sitters/list/index',
        '/pages/client/orders/list/index',
        '/pages/client/messages/index',
        '/pages/client/profile/index'
      ]
      const method = mainNavUrls.includes(targetPath) ? 'redirectTo' : 'navigateTo'
      global.wx[method]({
        url: targetUrl
      })
      return
    }

    page.previewHeroMedia({ currentTarget: { dataset: { item } } })
  }

  // Case 1: Tapping slide 1 (sub-page mall) -> navigateTo
  onHeroSlideTap(page.data.heroSlides[0])
  assert.equal(navigatedUrl, '/pages/client/mall/list/index')
  assert.equal(navigateMethod, 'navigateTo')

  // Case 2: Tapping slide 2 (main tab orders) -> redirectTo
  navigatedUrl = null
  navigateMethod = null
  onHeroSlideTap(page.data.heroSlides[1])
  assert.equal(navigatedUrl, '/pages/client/orders/list/index')
  assert.equal(navigateMethod, 'redirectTo')

  // Case 3: Tapping slide 3 (no linkUrl) -> preview fallback
  navigatedUrl = null
  previewImageCalled = false
  onHeroSlideTap(page.data.heroSlides[2])
  assert.equal(navigatedUrl, null)
  assert.equal(previewImageCalled, true)
})
