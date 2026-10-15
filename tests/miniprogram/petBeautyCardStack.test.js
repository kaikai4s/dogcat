const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.js'), 'utf8')

function createPageInstance() {
  let page
  const previews = []
  const wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    previewImage: (options) => { previews.push(options) },
    showToast: () => {}
  }
  vm.runInNewContext(source, {
    Page(config) { page = config },
    wx,
    require(name) {
      if (name.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      return {
        callFunction: () => Promise.resolve({}),
        ensureLogin: () => Promise.resolve(),
        showError: () => {}
      }
    }
  })
  page.setData = function (update, callback) {
    Object.assign(this.data, update)
    if (callback) callback()
  }
  return { page, previews }
}

test('pet with multiple photos creates draggable card stack with top, next and bottom layers', () => {
  const { page } = createPageInstance()
  const multiPhotoPet = {
    petId: 'pet-multi',
    name: '布偶猫咪咪',
    rank: 1,
    voteCount: 99,
    beautyPhotos: [
      { fileId: 'cloud://photo-A' },
      { fileId: 'cloud://photo-B' },
      { fileId: 'cloud://photo-C' }
    ]
  }
  const singlePhotoPet = {
    petId: 'pet-single',
    name: '柯基乐乐',
    rank: 2,
    voteCount: 88,
    avatarFileId: 'cloud://avatar-single'
  }

  page.onLoad()
  page.setData({ ranking: [multiPhotoPet, singlePhotoPet], candidates: [] })
  // Swipe 3 times to cycle through all 3 photos back to index 0
  page.onCardSwipeOut({ petId: 'pet-multi' })
  page.onCardSwipeOut({ petId: 'pet-multi' })
  page.onCardSwipeOut({ petId: 'pet-multi' })

  const pets = page.data.ranking
  const multi = pets.find(p => p.petId === 'pet-multi')
  const single = pets.find(p => p.petId === 'pet-single')

  assert.equal(multi.hasMultiplePhotos, true)
  assert.equal(multi.photoCount, 3)
  assert.equal(multi.activePhotoIndex, 0)
  assert.equal(multi.displayPhotoIndex, 1)
  assert.equal(multi.topPhotoUrl, 'cloud://photo-A')
  assert.equal(multi.nextPhotoUrl, 'cloud://photo-B')
  assert.equal(multi.bottomPhotoUrl, 'cloud://photo-C')
  assert.equal(multi.dots.length, 3)
  assert.equal(multi.dots[0].active, true)
  assert.equal(multi.dots[1].active, false)

  assert.equal(single.hasMultiplePhotos, false)
  assert.equal(single.photoCount, 1)
  assert.equal(single.topPhotoUrl, 'cloud://avatar-single')
  assert.equal(single.nextPhotoUrl, '')
})

test('onCardSwipeOut flings out current photo and cycles to next photo with scale-up replacement', () => {
  const { page } = createPageInstance()
  const multiPhotoPet = {
    petId: 'pet-swipe',
    name: '金毛大黄',
    rank: 1,
    voteCount: 50,
    beautyPhotos: [
      { fileId: 'cloud://img-1' },
      { fileId: 'cloud://img-2' },
      { fileId: 'cloud://img-3' }
    ]
  }
  page.onLoad()
  page.setData({ ranking: [multiPhotoPet], candidates: [] })
  page.onCardSwipeOut({ petId: 'pet-swipe' }) // advance to index 1

  let pet = page.data.ranking.find(p => p.petId === 'pet-swipe')
  assert.equal(pet.activePhotoIndex, 1)
  assert.equal(pet.displayPhotoIndex, 2)
  assert.equal(pet.topPhotoUrl, 'cloud://img-2')
  assert.equal(pet.nextPhotoUrl, 'cloud://img-3')
  assert.equal(pet.bottomPhotoUrl, 'cloud://img-1')
  assert.equal(pet.dots[1].active, true)

  // Swipe again: advance to index 2
  page.onCardSwipeOut({ petId: 'pet-swipe' })
  pet = page.data.ranking.find(p => p.petId === 'pet-swipe')
  assert.equal(pet.activePhotoIndex, 2)
  assert.equal(pet.topPhotoUrl, 'cloud://img-3')
  assert.equal(pet.nextPhotoUrl, 'cloud://img-1')

  // Swipe third time: loop back to index 0
  page.onCardSwipeOut({ petId: 'pet-swipe' })
  pet = page.data.ranking.find(p => p.petId === 'pet-swipe')
  assert.equal(pet.activePhotoIndex, 0)
  assert.equal(pet.topPhotoUrl, 'cloud://img-1')
})

test('previewPetById and modal viewer methods support navigating large picture card stack', () => {
  const { page, previews } = createPageInstance()
  const pet = {
    petId: 'pet-modal',
    name: '英短蓝猫',
    rank: 3,
    beautyPhotos: [{ fileId: 'cloud://blue-1' }, { fileId: 'cloud://blue-2' }]
  }
  page.onLoad()
  page.setData({ ranking: [pet], candidates: [] })
  // First swipe once so activePhotoIndex is initialized
  page.onCardSwipeOut({ petId: 'pet-modal' })

  // Trigger previewPetById
  page.previewPetById({ petId: 'pet-modal' })
  assert.equal(page.data.showPreviewModal, true)
  assert.equal(page.data.previewModalPet.petId, 'pet-modal')
  assert.equal(previews.length, 1)

  // Navigate modal photos
  page.nextModalPhoto()
  assert.equal(page.data.previewModalPhotoIndex, 0)
  page.prevModalPhoto()
  assert.equal(page.data.previewModalPhotoIndex, 1)

  // Close modal
  page.closePreviewModal()
  assert.equal(page.data.showPreviewModal, false)
  assert.equal(page.data.previewModalPet, null)
})

test('card-stack.wxs implements 0.07 deg/px displacement rotation matching reference image and smooth replenishment', () => {
  const wxsPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/card-stack.wxs')
  const wxsContent = fs.readFileSync(wxsPath, 'utf8')

  // Execute WXS in sandbox with mock getDate
  const wxsModule = { exports: {} }
  let currentTime = 1000
  const context = {
    module: wxsModule,
    exports: wxsModule.exports,
    Math,
    getDate: () => ({ getTime: () => currentTime })
  }
  vm.runInNewContext(wxsContent, context)
  const { touchstart, touchmove, touchend, onActiveIndexChange } = wxsModule.exports

  // Mock ComponentDescriptor instances
  function createMockDescriptor(dataset = {}) {
    const styles = {}
    const state = {}
    return {
      getDataset: () => dataset,
      getState: () => state,
      setStyle: (s) => Object.assign(styles, s),
      getAppliedStyles: () => styles
    }
  }

  const topCard = createMockDescriptor({ petid: 'pet-phys', photocount: 3 })
  const nextCard = createMockDescriptor()
  const bottomCard = createMockDescriptor()
  const calls = []

  const ownerInstance = {
    selectComponent: (selector) => {
      if (selector === '#next-layer-pet-phys') return nextCard
      if (selector === '#bottom-layer-pet-phys') return bottomCard
      return null
    },
    callMethod: (name, arg) => calls.push({ name, arg })
  }

  // 1. Touch start
  touchstart({ touches: [{ clientX: 100, clientY: 200 }], instance: topCard }, ownerInstance)
  assert.equal(topCard.getState().isDragging, true)

  // 2. Drag horizontal: dx = 183px (exact value from user reference image 20261016-002757.png)
  touchmove({ touches: [{ clientX: 283, clientY: 205 }], instance: topCard }, ownerInstance)
  const styles = topCard.getAppliedStyles()
  // 183 * 0.07 = 12.81 deg
  assert.match(styles.transform, /translate3d\(183px/)
  assert.match(styles.transform, /rotate\(12\.8/)

  // Next card scale replenishment: when dx = 183px, progress is capped at 1 -> scale reaches 1
  const nextStyles = nextCard.getAppliedStyles()
  assert.match(nextStyles.transform, /scale\(1/)

  // 3. Fling end
  touchend({ instance: topCard }, ownerInstance)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'onCardSwipeOut')
  assert.equal(calls[0].arg.petId, 'pet-phys')
  assert.equal(calls[0].arg.direction, 'right')

  // Top card flung out with opacity 0 and transition
  assert.equal(topCard.getAppliedStyles().opacity, '0')
  assert.match(topCard.getAppliedStyles().transition, /transform/)

  // 4. onActiveIndexChange resets layers seamlessly
  onActiveIndexChange(1, 0, ownerInstance, topCard)
  assert.equal(topCard.getAppliedStyles().opacity, '1')
  assert.equal(topCard.getAppliedStyles().transform, 'translate3d(0, 0, 0) rotate(0deg)')
  assert.equal(topCard.getAppliedStyles().transition, 'none')
})

test('WXML and WXSS contain zero text prompts and valid WXS event bindings', () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.wxml')
  const wxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.wxss')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const wxss = fs.readFileSync(wxssPath, 'utf8')

  // Must NOT contain text hints like "滑动换美照"
  assert.equal(wxml.includes('滑动换美照'), false)
  assert.equal(wxss.includes('stack-swipe-hint'), false)

  // WXS handlers must be direct references (not broken ternary expressions)
  assert.equal(wxml.includes('bindtouchstart="{{cardDrag.touchstart}}"'), true)
  assert.equal(wxml.includes('bindtouchmove="{{cardDrag.touchmove}}"'), true)
  assert.equal(wxml.includes('catchtouchstart="{{item.hasMultiplePhotos'), false)
})

