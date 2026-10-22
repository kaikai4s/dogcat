module.exports = function createHandler(context) {
  const {
    checkTextSecurity,
    cloud,
    db,
    getOrderForAccess,
    getUser,
    checkRateLimit,
    nowText,
    readScopedDocuments,
    safeText
  } = context

  const aiRequestTimestamps = new Map()
  function checkAiRateLimit(userOpenid, maxPerMinute = 10) {
    if (!userOpenid) return
    const nowTs = Date.now()
    const oneMinuteAgo = nowTs - 60 * 1000
    let userTimestamps = aiRequestTimestamps.get(userOpenid) || []
    userTimestamps = userTimestamps.filter((t) => t >= oneMinuteAgo)
    if (userTimestamps.length >= maxPerMinute) {
      throw new Error('AI 咨询过于频繁，请稍后再试（1分钟内限10次）')
    }
    userTimestamps.push(nowTs)
    aiRequestTimestamps.set(userOpenid, userTimestamps)
  }

  return async function ai(openid, action, data) {
    await getUser(openid)
    if (['aiPetAssistant', 'generatePetVoice'].includes(action)) {
      await checkRateLimit(openid, 'ai.model', { max: 10, windowMs: 60000, message: 'AI 咨询过于频繁，请稍后再试' })
    }
    if (action === 'aiPetAssistant') {
      const question = safeText(data.question).trim()
      if (!question) throw new Error('请填写咨询问题')
      if (question.length > 300) throw new Error('咨询问题不能超过 300 字')
      checkAiRateLimit(openid, 10)
      if (typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, question, { scene: 2, label: 'AI提问内容' })
      }
      const petId = safeText(data.petId).trim()
      let petInfo = ''
      if (petId) {
        const petRes = await db.collection('pets').doc(petId).get().catch(() => null)
        const p = petRes && petRes.data ? petRes.data : null
        if (!p || p.openid !== openid) throw new Error('无权访问')
        petInfo = `【宠物资料】名称：${p.name}，种类：${p.species === 'dog' ? '狗' : p.species === 'cat' ? '猫' : '其他'}，品种：${p.breed || '未知'}，体重：${p.weight || '未填'}kg。`
      }

      let answer = ''
      // 直接调用微信云开发内置的 hy3-preview 大模型
      const model = cloud.extend.AI.createModel('hunyuan')
      const res = await model.generateText({
        model: 'hy3',
        messages: [
          { role: 'system', content: `你是 Dovelin 多芙琳宠物上门服务 的专业AI智能助手和宠物医生顾问，性格温馨专业，精通宠物护理、疾病预防、上门服务注意事项。${petInfo}` },
          { role: 'user', content: question }
        ]
      })

      if (res && res.choices && res.choices[0] && res.choices[0].message) {
        answer = res.choices[0].message.content
      } else if (res && res.text) {
        answer = res.text
      } else {
        answer = JSON.stringify(res)
      }

      if (answer && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, answer, { scene: 2, label: 'AI回答内容' })
      }

      return {
        question,
        answer,
        generatedAt: nowText(),
        source: 'hy3-preview'
      }
    }

    if (action === 'aiGenerateReport') {
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单 ID 不能为空')
      const { order } = await getOrderForAccess(openid, orderId)
      if (!order) throw new Error('订单不存在')

      const checkins = await readScopedDocuments('checkin_logs', { orderId }, 'createdAt', 'asc')
      const eventLabels = checkins.map(c => c.eventType).join('、')

      const reportSummary = `【AI 智能宠护报告总结】
今日给宝贝「${order.petName || '宠物'}」的服务已顺利完成！
服务项目：${order.serviceSummary || '上门宠护'}
关键服务打卡记录：${checkins.length} 次（打卡环节包含：${eventLabels || '基础入户与服务'}）。
宠物状态：精神状态良好，打卡互动顺畅，离户时已确认门锁与电源安全。感谢您的信任！`

      return {
        orderId,
        reportSummary,
        generatedAt: nowText()
      }
    }

    if (action === 'generatePetVoice') {
      checkAiRateLimit(openid, 10)
      const petId = safeText(data.petId).trim()
      const petData = data.pet && typeof data.pet === 'object' ? data.pet : {}
      let p = { ...petData }
      if (petId) {
        const petRes = await db.collection('pets').doc(petId).get().catch(() => null)
        const existingPet = petRes && petRes.data ? petRes.data : null
        if (!existingPet || existingPet.openid !== openid) throw new Error('无权访问')
        p = { ...existingPet, ...p }
      }

      const name = safeText(p.name).trim() || '宝贝'
      const speciesLabel = p.species === 'dog' ? '狗狗' : p.species === 'cat' ? '猫咪' : '小可爱'
      const breed = safeText(p.breed).trim()
      const personality = safeText(p.personality).trim()
      const specialNotes = safeText(p.specialNotes).trim()
      const serviceName = safeText(data.serviceName || data.serviceType).trim()
      const startDate = safeText(data.startDate).trim()
      const dateKey = safeText(data.dateKey).trim() || safeText(nowText()).slice(0, 10)
      const cachePetKey = petId || `${name}_${p.species || 'pet'}`
      const cacheId = ['pet_voice_daily', openid, cachePetKey, dateKey].map((part) => safeText(part).replace(/[^a-zA-Z0-9_-]/g, '_')).join('_').slice(0, 500)

      let weekdayLabel = '今天'
      if (startDate) {
        const parts = startDate.split('-').map(Number)
        if (parts.length === 3) {
          const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
          const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
          weekdayLabel = days[d.getUTCDay()] || '今天'
        }
      }

      function fallbackVoices() {
        return [
          `主人，今天外头阳光暖洋洋的超舒服！有宠托师来陪我，我会超级乖的，你在外头安心工作不用担心我哦～`,
          `主人主人，今天天气凉爽微风正好～你帮我约的宠托师马上就到，我会按时吃粮喝水，主人安心忙吧不用惦记我！`,
          `主人，今天秋高气爽很适合晒太阳，等宠托师带我玩开心了我就回窝睡觉，你在外面安心拼事业，放一百个心吧～`,
          `今天天气微凉，主人出门记得多披件外套哦！我在家有宠托师细心照料，很安全很听话，主人安心放宽心去忙吧～`,
          `我是${name}！今天天气晴朗宜人，等宠托师陪我散步放风，我绝不捣乱拆家，主人安心上班，不用牵挂我呀～`
        ]
      }

      function cleanVoiceText(text) {
        return safeText(text).trim().replace(/^["“'「\[\]]+|["”'」\[\]]+$/g, '').replace(/[\r\n]+/g, ' ').trim()
      }

      function pickVoice(voices = []) {
        const list = voices.filter((item) => safeText(item).trim())
        const idx = Math.floor(Math.random() * Math.max(list.length, 1))
        return list[idx] || fallbackVoices()[0]
      }

      const cached = await db.collection('pet_voice_daily_cache').doc(cacheId).get().catch(() => ({ data: null }))
      if (cached && cached.data && Array.isArray(cached.data.voices) && cached.data.voices.length >= 5) {
        return {
          petId,
          name,
          weekdayLabel,
          dateKey,
          voiceMessage: pickVoice(cached.data.voices),
          source: cached.data.source || 'cache',
          cacheHit: true
        }
      }

      let voices = []
      let source = 'preset'

      try {
        const aiExt = cloud.extend && cloud.extend.AI ? cloud.extend.AI : null
        if (aiExt) {
          let modelInstance
          try {
            modelInstance = aiExt.createModel('cloudbase')
          } catch (_) {
            modelInstance = aiExt.createModel('hunyuan')
          }
          if (modelInstance && typeof modelInstance.generateText === 'function') {
            const petProfile = `【宠物资料】昵称：${name}，种类：${speciesLabel}${breed ? `，品种：${breed}` : ''}${personality ? `，性格：${personality}` : ''}${specialNotes ? `，习惯特质：${specialNotes}` : ''}`
            const res = await modelInstance.generateText({
              model: 'hy3',
              messages: [
                {
                  role: 'system',
                  content: `你是一只名为「${name}」的${speciesLabel}，正在以第一人称口吻对最爱的主人撒娇和表达心声。${petProfile}。
请一次性生成5条不同的宠物心声，每条都必须同时包含两个方面：
1. 结合当季时令告诉主人今天/当前天气情况；
2. 告诉主人待会有宠托师来贴心照顾自己，自己会乖乖听话，让主人安心放心。
要求：
- 每条35到65字左右，语气萌趣治愈、生动可爱；
- 5条表达必须明显不同；
- 严禁出现双引号、单引号、书名号、markdown标记；
- 只返回JSON数组字符串，例如：["第一条","第二条","第三条","第四条","第五条"]。`
                },
                {
                  role: 'user',
                  content: `主人为你预约了${startDate ? `${weekdayLabel}（${startDate}）` : '今天'}的${serviceName || '上门宠托'}服务。请生成今天可随机展示的5条萌宠第一人称心声。`
                }
              ]
            })

            let text = ''
            if (res && res.choices && res.choices[0] && res.choices[0].message) text = res.choices[0].message.content
            else if (res && res.text) text = res.text
            text = safeText(text).trim()
            const jsonMatch = text.match(/\[[\s\S]*\]/)
            let parsed = null
            if (jsonMatch) {
              try {
                parsed = JSON.parse(jsonMatch[0])
              } catch (_) {}
            }
            if (Array.isArray(parsed) && parsed.length > 0) {
              voices = parsed.map(cleanVoiceText).filter((item) => item.length >= 5 && item.length <= 90).slice(0, 5)
              if (voices.length > 0) source = 'hy3'
            } else if (text.length >= 5 && text.length <= 150) {
              const single = cleanVoiceText(text)
              if (single && single.length >= 5) {
                voices = [single]
                source = 'hy3'
              }
            }
          }
        }
      } catch (err) {
        console.warn('[generatePetVoice] AI model call failed:', (err && err.message) || err)
      }

      const chosenVoice = (source === 'hy3' && voices.length > 0) ? voices[0] : ''
      const fallbacks = fallbackVoices()
      for (const text of fallbacks) {
        if (voices.length >= 5) break
        if (!voices.includes(text)) voices.push(text)
      }

      if (typeof checkTextSecurity === 'function') {
        const safeVoices = []
        for (const text of voices) {
          try {
            await checkTextSecurity(openid, text, { scene: 2, label: 'AI宠物心声' })
            safeVoices.push(text)
          } catch (_) {}
        }
        voices = safeVoices.length >= 5 ? safeVoices.slice(0, 5) : fallbacks
      }

      await db.collection('pet_voice_daily_cache').doc(cacheId).set({ data: {
        openid,
        petId,
        dateKey,
        voices: voices.slice(0, 5),
        source,
        petSnapshot: { name, species: p.species || '', breed, personality, specialNotes },
        createdAt: nowText(),
        updatedAt: nowText()
      } }).catch(() => {})

      return {
        petId,
        name,
        weekdayLabel,
        dateKey,
        voiceMessage: chosenVoice || pickVoice(voices),
        source,
        cacheHit: false
      }
    }

    throw new Error('未知 ai 操作')
  }
}
