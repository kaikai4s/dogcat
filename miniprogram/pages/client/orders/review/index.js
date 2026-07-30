const { callFunction, showError } = require('../../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../../utils/nav')

const tagOptions = [
  { label: '准时到达', selected: false },
  { label: '反馈及时', selected: false },
  { label: '宠物喜欢', selected: false },
  { label: '服务细心', selected: false },
  { label: '环境整洁', selected: false },
  { label: '值得推荐', selected: false }
]

Page({
  data: {
    id: '',
    rating: 5,
    ratingOptions: [1, 2, 3, 4, 5],
    tags: tagOptions,
    content: '',
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(query) {
    this.setData({ ...createPageNav(query), id: query.id || query.orderId || '' })
  },

  chooseRating(e) {
    this.setData({ rating: Number(e.currentTarget.dataset.rating) })
  },

  toggleTag(e) {
    const label = e.currentTarget.dataset.label
    this.setData({
      tags: this.data.tags.map((item) => item.label === label ? { ...item, selected: !item.selected } : item)
    })
  },

  input(e) {
    this.setData({ content: e.detail.value })
  },

  submit() {
    const tags = this.data.tags.filter((item) => item.selected).map((item) => item.label)
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
      .catch(showError)
  },

  ...navMethods()
})
