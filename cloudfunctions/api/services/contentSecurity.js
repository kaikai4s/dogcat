module.exports = function createService({ cloud, safeText }) {
  function assertResult(result, label, image = false) {
    const code = Number(result && (result.errCode ?? result.errcode) || 0)
    const suggest = result && result.result && result.result.suggest
    if (code === 87014 || suggest === 'risky') {
      throw new Error(`${label}${image ? '包含违规敏感内容，请重新上传' : '包含敏感或不合规信息，请修改后重试'}`)
    }
    if (!result || code !== 0 || (suggest && suggest !== 'pass')) {
      throw new Error(`${label}暂未通过安全检测，请稍后重试`)
    }
  }

  async function checkTextSecurity(openid, content, options = {}) {
    const text = safeText(content).trim()
    if (!text) return { pass: true }
    const label = options.label || '提交内容'
    try {
      const security = cloud.openapi && cloud.openapi.security
      if (!security || typeof security.msgSecCheck !== 'function') throw new Error('安全检测服务不可用')
      const result = await security.msgSecCheck({ openid, scene: Number(options.scene) || 2, version: 2, content: text })
      assertResult(result, label)
      if (!result.result || result.result.suggest !== 'pass') throw new Error('安全检测未返回通过结果')
      return { pass: true, result: result.result }
    } catch (error) {
      if (error && error.code === 'IMAGE_TOO_LARGE') throw error
      if (Number(error && error.errCode) === 87014 || /87014|risky|敏感|不合规|违规/.test(error && (error.message || error.errMsg) || '')) {
        throw new Error(`${label}包含敏感或不合规信息，请修改后重试`)
      }
      throw new Error(`${label}暂未通过安全检测，请稍后重试`)
    }
  }

  async function checkImageSecurity(openid, fileIdOrUrl, options = {}) {
    const media = safeText(fileIdOrUrl).trim()
    if (!media) return { pass: true }
    const label = options.label || '上传图片'
    try {
      const security = cloud.openapi && cloud.openapi.security
      // No asynchronous fallback: submitting a scan is not a safe publication verdict.
      if (!security || typeof security.imgSecCheck !== 'function' || typeof cloud.downloadFile !== 'function' || !media.startsWith('cloud://')) {
        throw new Error('图片同步检测不可用，请重新上传图片')
      }
      const file = await cloud.downloadFile({ fileID: media })
      const bytes = file && file.fileContent
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('无法读取待检测图片')
      if (bytes.length > 1024 * 1024) {
        const error = new Error('图片超过检测大小限制，请压缩后重新上传')
        error.code = 'IMAGE_TOO_LARGE'
        throw error
      }
      const contentType = bytes[0] === 137 && bytes[1] === 80 ? 'image/png' : 'image/jpeg'
      const result = await security.imgSecCheck({ media: { contentType, value: bytes } })
      assertResult(result, label, true)
      // This legacy synchronous API signals success with errCode=0 (no result object).
      if (!result.result && Number(result.errCode ?? result.errcode) !== 0) throw new Error('图片检测未返回通过结果')
      return { pass: true }
    } catch (error) {
      if (error && error.code === 'IMAGE_TOO_LARGE') throw error
      if (Number(error && error.errCode) === 87014 || /87014|risky|敏感|违规/.test(error && (error.message || error.errMsg) || '')) {
        throw new Error(`${label}包含违规敏感内容，请重新上传`)
      }
      throw new Error(`${label}暂未通过安全检测，请重新上传或稍后重试`)
    }
  }

  return { checkTextSecurity, checkImageSecurity }
}
