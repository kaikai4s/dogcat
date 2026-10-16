const https = require('https')
const http = require('http')

module.exports = function createService({
  cloud,
  db,
  safeText,
  nowText
}) {
  function downloadBuffer(url, redirectCount = 0) {
    if (redirectCount > 5) {
      return Promise.reject(new Error('下载模型资源重定向次数过多'))
    }
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http
      const req = client.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadBuffer(res.headers.location, redirectCount + 1).then(resolve).catch(reject)
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`下载资源失败，状态码: ${res.statusCode}`))
        }
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(25000, () => {
        req.destroy(new Error('下载模型资源请求超时'))
      })
    })
  }

  function postJson(url, headers, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const client = parsed.protocol === 'https:' ? https : http
      const payload = JSON.stringify(body)
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers
        }
      }
      const req = client.request(options, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => {
          try {
            const data = JSON.parse(text)
            resolve({ statusCode: res.statusCode, data })
          } catch (e) {
            resolve({ statusCode: res.statusCode, text })
          }
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(25000, () => {
        req.destroy(new Error('AI 生成服务请求超时'))
      })
      req.write(payload)
      req.end()
    })
  }

  // Tripo3D 驱动实现
  async function callTripo3DApi(apiKey, imageUrl, petInfo = {}) {
    const res = await postJson('https://api.tripo3d.ai/v2/openapi/task', {
      Authorization: `Bearer ${apiKey}`
    }, {
      type: 'image_to_model',
      file: {
        type: 'jpg',
        url: imageUrl
      },
      model_type: 'character',
      texture: true,
      pbr: true
    })
    if (res.statusCode !== 200 || !res.data || res.data.code !== 0) {
      throw new Error(`Tripo3D API 调用失败: ${(res.data && res.data.message) || res.text || res.statusCode}`)
    }
    const taskId = res.data.data && res.data.data.task_id
    return {
      taskId,
      provider: 'tripo',
      status: 'submitted',
      // Tripo 任务为异步任务，返回 taskId 与轮询建议
      pollUrl: `https://api.tripo3d.ai/v2/openapi/task/${taskId}`
    }
  }

  // Meshy 驱动实现
  async function callMeshyApi(apiKey, imageUrl, petInfo = {}) {
    const res = await postJson('https://api.meshy.ai/v2/image-to-3d', {
      Authorization: `Bearer ${apiKey}`
    }, {
      image_url: imageUrl,
      enable_pbr: true,
      surface_mode: 'organic'
    })
    if (res.statusCode >= 300 || !res.data || !res.data.result) {
      throw new Error(`Meshy API 调用失败: ${(res.data && res.data.message) || res.text || res.statusCode}`)
    }
    const taskId = res.data.result
    return {
      taskId,
      provider: 'meshy',
      status: 'submitted',
      pollUrl: `https://api.meshy.ai/v2/image-to-3d/${taskId}`
    }
  }

  // 仿真 Mock 驱动（无 API Key 时保障流程可通，生成合规的云存储模型）
  async function generateMockModel(petInfo = {}) {
    const isCat = petInfo.species === 'cat'
    // 预留高质量样本模型路径作为仿真落地成果
    const mockGlbUrl = isCat
      ? 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/Duck/glTF-Binary/Duck.glb'
      : 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models/2.0/Fox/glTF-Binary/Fox.glb'
    return {
      provider: 'mock',
      status: 'success',
      glbUrl: mockGlbUrl,
      outputGlbUrl: mockGlbUrl
    }
  }

  // 核心入口：从图片启动 AI 3D 生成
  async function startPet3DGeneration({
    imageUrl,
    petInfo = {},
    provider = 'auto',
    apiKey = ''
  }) {
    const tripoKey = apiKey || process.env.TRIPO_API_KEY
    const meshyKey = apiKey || process.env.MESHY_API_KEY

    if ((provider === 'tripo' || provider === 'auto') && tripoKey) {
      return await callTripo3DApi(tripoKey, imageUrl, petInfo)
    }
    if ((provider === 'meshy' || provider === 'auto') && meshyKey) {
      return await callMeshyApi(meshyKey, imageUrl, petInfo)
    }

    // 未配置外部商业 API Key 时，运行优雅的仿真驱动，保障开发、自测与体验闭环
    console.info('[ai3d] 未检测到 TRIPO_API_KEY 或 MESHY_API_KEY，启用预留仿真生成驱动')
    return await generateMockModel(petInfo)
  }

  // 下载外部生成的 GLB 模型并转存至微信云存储
  async function saveGlbBufferToCloud(buffer, petId, openid) {
    if (!cloud || !cloud.uploadFile) {
      throw new Error('当前环境不可用微信云存储上传')
    }
    const fileName = `custom_${safeText(petId)}_${Date.now()}.glb`
    const cloudPath = `playground/custom_models/${fileName}`
    const uploadRes = await cloud.uploadFile({
      cloudPath,
      fileContent: buffer
    })
    return uploadRes.fileID || uploadRes.fileId || `cloud://${cloudPath}`
  }

  return {
    startPet3DGeneration,
    generateMockModel,
    saveGlbBufferToCloud,
    downloadBuffer
  }
}
