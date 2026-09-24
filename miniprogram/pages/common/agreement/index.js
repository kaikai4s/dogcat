function item(text) {
  return { segments: [{ text }] }
}

function section(sectionTitle, items) {
  return { sectionTitle, items: items.map(item) }
}

const AGREEMENT_CONFIGS = {
  user_service: {
    badgeText: '用户服务协议',
    title: '用户服务协议',
    subtitle: '使用预约、支付、订单、评价和客服功能前，请了解双方权利义务。',
    agreementTitle: '《用户服务协议》',
    sections: [
      section('一、服务说明', ['本平台提供宠物上门照护、遛狗、喂养、订单撮合、服务记录、售后沟通等信息服务。', '用户应确保账号、联系方式、宠物资料、服务地址、门锁/钥匙说明真实、完整、及时更新。']),
      section('二、下单与履约', ['用户下单并支付后，平台将按订单信息通知宠托师接单和履约；服务时间、地点、宠物数量、服务项目以订单确认为准。', '用户应保障宠托师合法、安全入户，提前告知宠物健康、攻击性、用药、禁忌和家庭安防注意事项。']),
      section('三、用户行为规范', ['不得发布违法、虚假、侮辱、骚扰信息，不得要求宠托师从事与宠物照护无关或存在安全风险的事项。', '不得绕过平台私下交易、恶意取消、虚假投诉、恶意评价或损害平台及他人合法权益。']),
      section('四、责任边界', ['因用户提供信息错误、宠物突发疾病、不可抗力、第三方原因造成的损失，平台将依据证据和法律规定协助处理。', '平台会持续优化服务安全保障，但不承诺服务绝对无风险。'])
    ]
  },
  care_guarantee: {
    badgeText: '喂养服务保障协议',
    title: '喂养服务保障协议',
    subtitle: '了解上门喂养服务标准、家庭财产安全保障、突发疾病处置与平台保障责任。',
    agreementTitle: '《喂养服务保障协议》',
    sections: [
      section('一、服务内容与标准化履约', [
        '宠托师将按照订单要求提供上门喂粮、换水、清洗餐具、清理宠物厕所/铲屎换砂、宠物互动及基础环境整理等服务。',
        '服务全程需开启位置轨迹与关键打卡节点（如进门、喂食、清洁、离开），并在服务完成后提交包含现场图文的服务报告。'
      ]),
      section('二、入户与家庭财产安全保障', [
        '用户提供的门锁密码、钥匙存放位置等敏感信息受平台加密及访问控制保护，仅在服务时段内向履约宠托师受限开放。',
        '宠托师严禁携带无关人员入户，严禁触碰或进入与宠物照护无关的私人区域，严禁私自拍摄家庭隐私环境。',
        '如因宠托师过错导致用户家庭财物损失或门窗损坏，经平台核实后协助先行调解并依法追究相应赔偿责任。'
      ]),
      section('三、宠物健康与意外应急保障', [
        '用户在下单前应如实告知宠物健康状况、疫苗接种、攻击性史、特殊饮食及过敏禁忌。',
        '服务期间如遇宠物突发疾病、应激反应或身体异常，宠托师将第一时间联系宠物主；在紧急情况下将按平台应急处置规范协助送往就近宠物医院，并留存接诊及费用凭证。'
      ]),
      section('四、免责与责任边界', [
        '因用户隐瞒宠物既有病史、未牵引/未关好门窗等自身过错导致的宠物走失、发病或第三方损害，由用户自行承担相应责任。',
        '因不可抗力（极端恶劣天气、自然灾害、突发交通管制等）导致无法按时履约的，双方应协商改期或按平台规则退款。'
      ])
    ]
  },
  staff_application: {
    badgeText: '宠托师/服务者入驻协议',
    title: '宠托师/服务者入驻协议',
    subtitle: '入驻成为宠托师前，请仔细阅读服务内容、入驻要求、履约规范和认证规则。',
    agreementTitle: '《宠托师/服务者入驻协议》',
    sections: [
      section('一、服务内容', ['上门喂养包括清洁餐具、换粮换水、铲屎换砂、基础环境整理和服务反馈。', '上门遛狗须在用户指定区域活动，全程牵绳，按订单要求反馈图文、定位和服务结果。']),
      section('二、入驻要求', ['申请者应年满18周岁，身体健康，具备独立养宠或宠物照护经验，提交真实身份、联系方式和资质资料。', '申请者应完成资料审核、培训视频、培训答题和平台要求的线上审核，不得冒用他人身份或提交虚假资料。']),
      section('三、履约规范', ['宠托师应按订单时间到达并完成服务，遵守入户安全、钥匙/门锁保密、全程记录、异常及时上报等规范。', '不得私自转单、弃单、带无关人员入户、私下收费、诱导用户离开平台交易或泄露用户隐私。']),
      section('四、费用与保证金', ['资料认证费、保证金、平台服务费、提现规则以页面展示为准；缴费前请确认自身符合入驻条件。', '保证金用于约束严重违约和服务风险，满足退还条件时可按平台流程申请退还。'])
    ]
  },
  privacy: {
    badgeText: '隐私政策',
    title: '隐私政策',
    subtitle: '说明我们如何收集、使用、保存和保护你的个人信息。',
    agreementTitle: '《隐私政策》',
    sections: [
      section('一、我们收集的信息', ['为完成登录、预约、履约、支付、客服和安全保障，我们可能收集微信 openid、昵称头像、手机号、地址、宠物资料、订单、定位、服务日志、评价和投诉材料。', '家庭安防、门锁密码、钥匙位置等敏感信息仅用于对应订单履约和安全审计。']),
      section('二、使用目的', ['信息用于账号识别、订单撮合、价格试算、服务通知、服务报告、售后处理、风险控制、客服支持和法律法规要求的留存。', '未经授权，我们不会将个人信息用于与宠物照护服务无关的用途。']),
      section('三、共享与保存', ['必要时会向接单宠托师展示履约所需信息；如接入支付、地图、云存储、订阅消息等能力，将按功能所需调用相关服务。', '我们会在实现目的所需期限内保存信息，并采取访问控制、加密或脱敏等措施保护安全。']),
      section('四、用户权利', ['你可以在资料、地址、宠物档案等页面查看、修改或删除信息，也可以联系客服处理账号和隐私相关请求。', '未成年人应在监护人同意和指导下使用本服务。'])
    ]
  },
  trade_rules: {
    badgeText: '平台交易规则',
    title: '平台交易规则',
    subtitle: '说明订单发布、接单、支付、履约、结算和评价的基本规则。',
    agreementTitle: '《平台交易规则》',
    sections: [
      section('一、订单规则', ['用户应按真实服务需求创建订单，平台根据服务项目、时长、距离、优惠等因素试算价格。', '订单支付后进入待接单或已分配状态，宠托师按平台规则接单、签到、服务和提交报告。']),
      section('二、支付与结算', ['订单费用、优惠券、退款金额以系统记录为准；如微信支付尚未开通或处于测试环境，页面会展示对应状态。', '宠托师收益按平台结算规则产生，涉及保证金、平台服务费、提现时效的，以后台配置和页面说明为准。']),
      section('三、违规处理', ['私下交易、虚假订单、恶意评价、刷单、泄露隐私、扰乱平台秩序等行为，平台可限制功能、取消资格或依法追责。', '平台保留基于证据、订单记录和法律法规进行风控处理的权利。'])
    ]
  },
  refund_cancel: {
    badgeText: '退款/取消订单规则',
    title: '退款与取消订单规则',
    subtitle: '说明取消订单、退款申请、异常退款和费用承担方式。',
    agreementTitle: '《退款/取消订单规则》',
    sections: [
      section('一、取消规则', ['用户可在服务开始前按页面规则申请取消；已接单、临近开始或宠托师已出发的订单，可能产生相应费用。', '宠托师因个人原因无法履约应及时取消或联系平台处理，平台可视情况限制接单或扣减相关权益。']),
      section('二、退款规则', ['退款金额会结合订单状态、服务完成度、优惠券、证据材料和双方责任进行判断。', '已实际完成或部分完成的服务，原则上按完成情况结算；因平台或服务方责任导致未履约的，将优先保障用户合法权益。']),
      section('三、到账与争议', ['退款到账时间受支付渠道处理时效影响，以微信支付或实际支付渠道通知为准。', '如双方对退款有争议，可提交投诉材料，由平台根据订单记录、服务日志、照片视频和沟通记录处理。'])
    ]
  },
  complaint_dispute: {
    badgeText: '投诉与纠纷处理规则',
    title: '投诉与纠纷处理规则',
    subtitle: '说明投诉材料、处理流程、证据规则和平台协助方式。',
    agreementTitle: '《投诉与纠纷处理规则》',
    sections: [
      section('一、受理范围', ['平台受理服务未完成、迟到早退、宠物异常、财产损失、退款争议、态度纠纷、隐私泄露等与订单相关的问题。', '与订单无关或缺乏事实基础的请求，平台可要求补充材料或不予受理。']),
      section('二、证据材料', ['投诉方应尽量提供订单号、时间线、照片视频、聊天记录、服务报告、医疗或维修凭证等材料。', '平台将结合双方陈述、系统记录、定位打卡、服务日志和上传材料进行判断。']),
      section('三、处理方式', ['平台可采取沟通调解、补充服务、部分退款、限制账号、暂停接单、扣减保证金、移交司法机关等处理措施。', '涉及宠物伤害、人身财产安全或违法犯罪线索的，建议及时报警或寻求专业机构协助，平台将依法配合。'])
    ]
  },
  default: {
    badgeText: '安全告知与协议规范',
    title: '服务协议与阅读规范',
    subtitle: '进入操作前请仔细阅读以下协议及规范。',
    agreementTitle: '《平台服务与安全告知协议》',
    sections: [section('服务条款', ['感谢使用安心宠护平台服务，请在继续操作前认真阅读并遵守相关服务规范与安全准则。'])]
  }
}

Page({
  data: {
    themeClass: 'theme-day',
    fontClass: 'font-system',
    type: 'staff_application',
    targetUrl: '/pages/staff/certification/index',
    mode: 'confirm',
    viewOnly: false,
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
    const mode = query.mode === 'view' ? 'view' : 'confirm'
    const viewOnly = mode === 'view'
    const initialCountdown = viewOnly ? 0 : (Number(query.countdown) > 0 ? Number(query.countdown) : 30)

    const config = AGREEMENT_CONFIGS[type] || AGREEMENT_CONFIGS.default

    this.setData({
      type,
      targetUrl,
      mode,
      viewOnly,
      countdown: initialCountdown,
      agreedCheck: viewOnly,
      canProceed: viewOnly,
      ...config
    })

    if (!viewOnly) this.startCountdown()
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
