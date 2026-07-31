const { showError, ensureLogin } = require('../../../utils/cloud')

function generateId() {
  const timestamp = Date.now().toString().slice(-4)
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return timestamp + random
}

Page({
  data: {
    inputText: '',
    messages: [
      {
        role: 'ai',
        content: '您好！我是您的 AI 宠护小助手 🐾\n无论关于宠物饮食健康、出行习惯还是上门服务的准备事宜，我都能为您解答～'
      }
    ],
    loading: false
  },

  onLoad() {
    ensureLogin({ content: '登录后可体验 AI 智能问答助手。' }).catch(() => {})
  },

  onInput(e) {
    this.setData({ inputText: e.detail.value })
  },

  askPreset(e) {
    const text = e.currentTarget.dataset.text
    this.setData({ inputText: text }, () => {
      this.send()
    })
  },

  send() {
    const q = this.data.inputText.trim()
    if (!q || this.data.loading) return

    const userMsg = { role: 'user', content: q }
    this.setData({
      messages: [...this.data.messages, userMsg],
      inputText: '',
      loading: true
    })

    const model = wx.cloud.extend.AI.createModel('cloudbase')
    const aiIndex = this.data.messages.length // 占位，流式追加
    this.setData({ messages: [...this.data.messages, { role: 'ai', content: '' }] })

    model.streamText({
      data: {
        model: 'hy3',
        messages: [
          { role: 'system', content: '你是一个VIP上门宠护平台的专业AI智能助手和宠物医生顾问，性格温馨专业，精通宠物护理、疾病预防、上门服务注意事项。' },
          { role: 'user', content: q }
        ]
      }
    }).then(async (response) => {
      let fullText = ''
      for await (const text of response.textStream) {
        fullText += text
        const messages = [...this.data.messages]
        messages[aiIndex] = { role: 'ai', content: fullText }
        this.setData({ messages })
      }
      this.setData({ loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      showError(err)
    })
  }
})
