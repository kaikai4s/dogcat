const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')

const tagOptions = [
  { label: '准时到达', selected: false },
  { label: '反馈及时', selected: false },
  { label: '宠物喜欢', selected: false },
  { label: '服务细心', selected: false },
  { label: '环境整洁', selected: false },
  { label: '值得推荐', selected: false }
]

const ratingTexts = ['', '很差', '不满意', '一般', '满意', '超出预期']

Page({
  data: {
    id: '',
    rating: 5,
    ratingText: ratingTexts[5],
    ratingOptions: [1, 2, 3, 4, 5],
    tags: tagOptions,
    content: '',
    contentCount: 0,
    submitting: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(query) {
    this.setData({ ...createPageNav(query), id: query.id || query.orderId || '' })
  },

  onShow() {
    ensureLogin({ content: '登录后可评价订单。' })
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  chooseRating(e) {
    const rating = Number(e.currentTarget.dataset.rating)
    this.setData({ rating, ratingText: ratingTexts[rating] || '' })
  },

  toggleTag(e) {
    const label = e.currentTarget.dataset.label
    this.setData({
      tags: this.data.tags.map((item) => item.label === label ? { ...item, selected: !item.selected } : item)
    })
  },

  input(e) {
    const content = e.detail.value || ''
    this.setData({ content, contentCount: content.length })
  },

  submit() {
    if (this.data.submitting) return
    const tags = this.data.tags.filter((item) => item.selected).map((item) => item.label)
    this.setData({ submitting: true })
    callFunction('order', 'createReview', {
      orderId: this.data.id,
      rating: this.data.rating,
      tags,
      content: this.data.content
    })
      .then(() => {
        wx.showToast({ title: '已评价' })
        wx.navigateBack()
      })
      .catch((error) => {
        this.setData({ submitting: false })
        showError(error)
      })
  },

  ...navMethods()
})
