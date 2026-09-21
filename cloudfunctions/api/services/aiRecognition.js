module.exports = function createService({
  cloud,
  db,
  https,
  now,
  safeText
}) {
  function callQwenVisionApi(apiKey, model, base64Image) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: model || 'qwen3.5-flash',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              },
              {
                type: 'text',
                text: '请分析并识别图片中的宠物类型和具体品种。如果是狗，species为"dog"；如果是猫，species为"cat"；如果是其他宠物（如兔子、仓鼠、蜥蜴等），species为"other"。只返回格式如 {"species":"dog","breed":"金毛寻回犬"} 的严格JSON，不要包含任何markdown、换行或额外字符。'
              }
            ]
          }
        ]
      })

      const options = {
        hostname: 'dashscope.aliyuncs.com',
        port: 443,
        path: '/compatible-mode/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(payload)
        }
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
            if (!content) {
              return reject(new Error((json.error && json.error.message) || 'Qwen API 返回异常'))
            }
            const cleanText = String(content).replace(/```json/g, '').replace(/```/g, '').trim()
            const matched = cleanText.match(/\{[\s\S]*\}/)
            const parsed = JSON.parse(matched ? matched[0] : cleanText)
            resolve(parsed)
          } catch (err) {
            reject(new Error(`解析 AI 返回失败: ${data || err.message}`))
          }
        })
      })

      req.on('error', (err) => reject(err))
      req.setTimeout(20000, () => {
        req.destroy()
        reject(new Error('请求 AI 模型超时'))
      })
      req.write(payload)
      req.end()
    })
  }

  function callCloudbaseAiGateway(envId, modelName, imageUrl, promptText) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: modelName || 'qwen3.5-flash',
        messages: [
          {
            role: 'user',
            content: imageUrl ? [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: promptText }
            ] : promptText
          }
        ]
      })

      const targetEnv = envId || 'cloud1-5gnhqn4t0554c1d9'
      const options = {
        hostname: `${targetEnv}.api.tcloudbasegateway.com`,
        port: 443,
        path: '/v1/ai/cloudbase/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
            if (!content) {
              return reject(new Error((json.error && json.error.message) || json.message || 'AI 网关响应异常'))
            }
            resolve(content)
          } catch (err) {
            reject(new Error(`解析 AI 响应失败: ${data || err.message}`))
          }
        })
      })

      req.on('error', (err) => reject(err))
      req.setTimeout(25000, () => {
        req.destroy()
        reject(new Error('请求云开发 AI 网关超时'))
      })
      req.write(payload)
      req.end()
    })
  }

  function getCloudbaseAiGatewayEnvId() {
    return process.env.TCB_ENV || process.env.SCF_NAMESPACE || 'cloud1-5gnhqn4t0554c1d9'
  }

  function petSpeciesName(species) {
    return species === 'cat' ? '猫咪' : species === 'other' ? '其他' : '狗狗'
  }

  function normalizePetSpecies(value) {
    return ['dog', 'cat', 'other'].includes(value) ? value : ''
  }

  function inferPetSpecies(text) {
    const source = safeText(text)
    if (/猫|布偶|英短|美短|狸花|暹罗|波斯/.test(source)) return 'cat'
    if (/狗|犬|柯基|金毛|拉布拉多|泰迪|贵宾|柴犬|边牧|哈士奇|萨摩耶/.test(source)) return 'dog'
    if (/兔|仓鼠|豚鼠|鸟|鹦鹉|龟|乌龟|龙猫|刺猬/.test(source)) return 'other'
    return ''
  }

  function parsePetRecognitionText(rawAiContent) {
    const rawText = safeText(rawAiContent).replace(/```json/g, '').replace(/```/g, '').trim()
    if (!rawText) throw new Error('AI 服务未返回识别内容，请稍后重试')

    let species = ''
    let breed = ''
    const jsonMatch = rawText.match(/\{[\s\S]*?\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        species = normalizePetSpecies(safeText(parsed.species))
        breed = safeText(parsed.breed).trim()
      } catch (error) {
        throw new Error('AI 返回格式异常，请换一张清晰照片后重试')
      }
    }

    if (!species) species = inferPetSpecies(rawText)
    if (!species) throw new Error('AI 未能识别出宠物类型，请换一张清晰正脸或全身照片重试')

    const cleanAnalysisText = rawText.replace(/\{[\s\S]*?\}/g, '').trim() || rawText
    return {
      species,
      speciesName: petSpeciesName(species),
      breed,
      confidence: breed ? 0.98 : 0.7,
      aiResultText: cleanAnalysisText,
      fullAnalysis: cleanAnalysisText
    }
  }

  function getCloudbaseAiClient() {
    if (typeof cloud.ai === 'function') return { client: cloud.ai(), wrapData: false }
    if (cloud.extend && cloud.extend.AI && typeof cloud.extend.AI.createModel === 'function') return { client: cloud.extend.AI, wrapData: true }
    throw new Error('当前云函数 SDK 不支持 cloud.ai，请确认 wx-server-sdk 版本并使用“上传并部署：云端安装依赖”重新部署 api 云函数')
  }

  async function callCloudbaseExtendAi(modelNames, imageUrl, promptText) {
    let lastError = null
    const aiClient = getCloudbaseAiClient()
    const aiModel = aiClient.client.createModel('cloudbase')
    for (const modelName of modelNames) {
      try {
        console.log(`[云函数AI识图] 正在调用微信云开发 AI 服务: ${modelName}, imageUrl: ${imageUrl.slice(0, 50)}...`)
        const payload = {
          model: modelName,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: promptText },
                { type: 'image_url', image_url: { url: imageUrl } }
              ]
            }
          ]
        }
        const res = await aiModel.generateText(aiClient.wrapData ? { data: payload } : payload)
        const rawAiContent = res.text || res.content || (res.data && (res.data.text || res.data.content)) || (typeof res === 'string' ? res : '')
        if (rawAiContent) return { rawAiContent, modelName, source: 'cloudbase_extend_ai' }
        lastError = new Error('AI 服务返回空内容')
      } catch (error) {
        lastError = error
        console.warn(`[云函数AI识图] cloud.extend.AI (${modelName}) 调用失败:`, error.message || error)
      }
    }
    throw lastError || new Error('微信云开发 AI 服务未响应')
  }

  async function recordAiLog(openid, logData = {}) {
    try {
      await db.collection('ai_logs').add({
        data: {
          openid: openid || '',
          type: 'pet_breed_recognition',
          avatarFileId: logData.avatarFileId || '',
          modelName: logData.modelName || 'qwen3.5-flash',
          source: logData.source || 'cloudbase_ai',
          rawResponse: logData.rawResponse || '',
          species: logData.species || '',
          breed: logData.breed || '',
          aiMessage: logData.aiMessage || '',
          createdAt: now()
        }
      })
    } catch (err) {
      console.error('Failed to write ai_logs document:', err)
    }
  }

  return {
    callQwenVisionApi,
    callCloudbaseAiGateway,
    getCloudbaseAiGatewayEnvId,
    petSpeciesName,
    normalizePetSpecies,
    inferPetSpecies,
    parsePetRecognitionText,
    getCloudbaseAiClient,
    callCloudbaseExtendAi,
    recordAiLog
  }
}
