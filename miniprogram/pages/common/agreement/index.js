const AGREEMENT_CONFIGS = {
  staff_application: {
    badgeText: '宠托师入驻协议',
    title: '宠托师平台服务协议',
    subtitle: '入驻成为宠托师前，请仔细阅读以下服务内容、入驻要求及资料认证规则。',
    agreementTitle: '《宠托师平台服务协议》',
    sections: [
      {
        sectionTitle: '- 服务内容 -',
        items: [
          {
            title: '上门喂养：',
            segments: [
              { text: '清洁餐具、换粮换水、铲屎及换猫砂、开窗通风...' }
            ]
          },
          {
            title: '上门遛狗：',
            segments: [
              { text: '清洁餐具、换粮换水、铲屎、在宠物主指定区域遛狗，全程牵绳' }
            ]
          }
        ]
      },
      {
        sectionTitle: '- 入驻要求 -',
        items: [
          { segments: [{ text: '1、年龄18-48周岁，身体健康' }] },
          { segments: [{ text: '2、拥有一年以上独立养宠经验（需准备一张人宠合照）' }] },
          { segments: [{ text: '3、对宠物有爱心，一视同仁，善待宠物且有责任心' }] },
          { segments: [{ text: '4、性格稳定不急躁，有耐心，有良好的表达能力，遵守平台规则' }] },
          { segments: [{ text: '5、社会面没有不良信息记录' }] },
          { segments: [{ text: '6、微信支付分/芝麻信用分大于650分' }] },
          { segments: [{ text: '7、需要准备身份证正面照和一张本人无遮挡人脸照' }] },
          { segments: [{ text: '8、需要有一定的视频剪辑能力（会使用剪映、快影、秒剪、必剪等任意一种剪辑工具）' }] },
          { segments: [{ text: '9、宠托师答题测试合格' }] }
        ]
      },
      {
        sectionTitle: '- 资料认证规则 -',
        items: [
          {
            segments: [
              { text: '1、因认证会产生' },
              { text: '29.9元资料认证费（原价：99元）且不可退款', highlight: true },
              { text: '，为了避免造成您的损失，请先确保自己符合申请条件后，再进行申请' }
            ]
          },
          {
            segments: [
              { text: '2、认证提交后不支持撤销，如因个人原因主动要求撤销，将于2个工作日内注销宠托师资料，' },
              { text: '资料认证费不予退还', highlight: true }
            ]
          },
          {
            segments: [
              { text: '3、平台审核流程公开透明，申请者只要满足全部申请条件，以及确保提交资料真实完整，即可拥有较高的通过率' }
            ]
          },
          {
            segments: [
              { text: '4、上门喂养、遛狗等服务有订单淡旺季（类似于宠物店寄养）且一线城市（北京、上海、广州、深圳）较多' }
            ]
          },
          {
            segments: [
              { text: '5、宠托师可作为兼职收入，加入平台并不保证您的地区附近有订单，入驻成功并不代表立马有订单可接单，' },
              { text: '需要您耐心等待', highlight: true }
            ]
          },
          {
            segments: [
              { text: '6、上门服务需要自行准备一次性手套鞋套和垃圾袋、宠物专用消毒喷雾，并在进门前使用宠物专用消毒喷雾进行病毒处理' }
            ]
          },
          {
            segments: [
              { text: '7、服务过程中需要' },
              { text: '全程录制视频', highlight: true },
              { text: '，最好自备手机支架，每次服务完成需要及时上传日志' }
            ]
          },
          {
            segments: [
              { text: '8、平台内订单为自愿接单模式，审核通过后可在抢单大厅接单，平台不强制派单，请根据自己的行程计划和抢单大厅订单信息自行选择是否接单' }
            ]
          },
          {
            segments: [
              { text: '9、接单时需要缴纳保证金，保证金在没有未完成订单的情况下随时可提现，提现后将在3个工作日内到账' }
            ]
          },
          {
            segments: [
              { text: '10、保证金更多信息请阅读' },
              { text: '《保证金说明》', highlight: true, isLink: true, linkType: 'deposit' }
            ]
          },
          {
            segments: [
              { text: '11、' },
              { text: '缴费即表明您已阅读并同意以上内容', highlight: true }
            ]
          }
        ]
      }
    ]
  },
  default: {
    badgeText: '安全告知与协议规范',
    title: '服务协议与阅读规范',
    subtitle: '进入操作前请仔细阅读以下协议及规范。',
    agreementTitle: '《平台服务与安全告知协议》',
    sections: [
      {
        sectionTitle: '- 服务条款 -',
        items: [
          {
            segments: [
              { text: '1、感谢您使用安心宠护平台服务。请您在继续操作前认真阅读并遵守平台相关服务规范与安全准则。' }
            ]
          },
          {
            segments: [
              { text: '2、我们高度重视您的个人隐私与数据安全，所有敏感信息均采用加密存储，仅用于服务撮合与履约保障。' }
            ]
          },
          {
            segments: [
              { text: '3、用户与服务人员均须遵守国家法律法规及平台规则，共同维护良好的宠物照护服务生态。' }
            ]
          }
        ]
      }
    ]
  }
}

Page({
  data: {
    themeClass: 'theme-day',
    fontClass: 'font-system',
    type: 'staff_application',
    targetUrl: '/pages/staff/certification/index',
    countdown: 30,
    agreedCheck: false,
    canProceed: false,
    showDepositModal: false,
    badgeText: '',
    title: '',
    subtitle: '',
    agreementTitle: '',
    sections: []
  },

  timer: null,

  onLoad(query = {}) {
    const type = query.type || 'staff_application'
    const targetUrl = query.targetUrl ? decodeURIComponent(query.targetUrl) : '/pages/staff/certification/index'
    const initialCountdown = Number(query.countdown) > 0 ? Number(query.countdown) : 30

    const config = AGREEMENT_CONFIGS[type] || AGREEMENT_CONFIGS.default

    this.setData({
      type,
      targetUrl,
      countdown: initialCountdown,
      ...config
    })

    this.startCountdown()
  },

  onUnload() {
    this.stopCountdown()
  },

  startCountdown() {
    this.stopCountdown()
    this.timer = setInterval(() => {
      const next = this.data.countdown - 1
      if (next <= 0) {
        this.stopCountdown()
        this.setData({ countdown: 0 }, () => this.updateProceedState())
      } else {
        this.setData({ countdown: next }, () => this.updateProceedState())
      }
    }, 1000)
  },

  stopCountdown() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  },

  toggleCheck() {
    this.setData({ agreedCheck: !this.data.agreedCheck }, () => this.updateProceedState())
  },

  onSegmentTap(e) {
    const linkType = e.currentTarget.dataset.type
    if (linkType === 'deposit') {
      this.setData({ showDepositModal: true })
    }
  },

  closeDepositModal() {
    this.setData({ showDepositModal: false })
  },

  updateProceedState() {
    const canProceed = this.data.countdown <= 0 && this.data.agreedCheck
    this.setData({ canProceed })
  },

  proceed() {
    if (!this.data.canProceed) {
      if (this.data.countdown > 0) {
        wx.showToast({ title: `请继续阅读 ${this.data.countdown} 秒`, icon: 'none' })
      } else if (!this.data.agreedCheck) {
        wx.showToast({ title: '请勾选同意协议复选框', icon: 'none' })
      }
      return
    }

    try {
      wx.setStorageSync(`agreed_agreement_${this.data.type}`, Date.now())
    } catch (e) {}

    const targetUrl = this.data.targetUrl
    wx.redirectTo({
      url: targetUrl,
      fail: () => {
        wx.navigateTo({ url: targetUrl })
      }
    })
  },

  cancel() {
    wx.navigateBack({
      fail: () => {
        wx.redirectTo({ url: '/pages/client/home/index' })
      }
    })
  }
})
