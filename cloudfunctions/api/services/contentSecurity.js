module.exports = function createService({
  cloud,
  safeText
}) {
  async function checkTextSecurity(openid, content, options = {}) {
    const text = safeText(content).trim()
    if (!text) return { pass: true }

    if (!cloud.openapi || !cloud.openapi.security) {
      return { pass: true }
    }

    const scene = Number(options.scene) || 2
    const label = options.label || '提交内容'

    try {
      if (typeof cloud.openapi.security.msgSecCheck === 'function') {
        const res = await cloud.openapi.security.msgSecCheck({
          openid,
          scene,
          version: 2,
          content: text
        })
        if (res && res.result && (res.result.suggest === 'risky' || (res.result.suggest === 'review' && options.strict === true))) {
          throw new Error(`${label}包含敏感或不合规信息，请修改后重试`)
        }
        if (res && res.errCode === 87014) {
          throw new Error(`${label}包含敏感或不合规信息，请修改后重试`)
        }
        return { pass: true, result: res && res.result }
      }
    } catch (err) {
      const errMsg = (err && (err.message || err.errMsg)) || String(err)
      const isRisky = (err && err.errCode === 87014) || errMsg.includes('87014') || errMsg.includes('risky') || errMsg.includes('敏感') || errMsg.includes('不合规') || errMsg.includes('违规')
      if (isRisky) {
        throw new Error(`${label}包含敏感或不合规信息，请修改后重试`)
      }
      console.warn('[security.msgSecCheck] warning:', errMsg)
    }
    return { pass: true }
  }

  async function checkImageSecurity(openid, fileIdOrUrl, options = {}) {
    const media = safeText(fileIdOrUrl).trim()
    if (!media) return { pass: true }

    if (!cloud.openapi || !cloud.openapi.security) {
      return { pass: true }
    }

    const scene = Number(options.scene) || 1
    const label = options.label || '上传图片'

    try {
      // 1. 同步校验 imgSecCheck（优先检测 cloud:// 存储文件）
      if (typeof cloud.openapi.security.imgSecCheck === 'function' && typeof cloud.downloadFile === 'function') {
        if (media.startsWith('cloud://')) {
          const fileRes = await cloud.downloadFile({ fileID: media }).catch(() => null)
          if (fileRes && fileRes.fileContent) {
            const res = await cloud.openapi.security.imgSecCheck({
              media: {
                contentType: 'image/jpeg',
                value: fileRes.fileContent
              }
            })
            if (res && (res.errCode === 87014 || (res.result && res.result.suggest === 'risky'))) {
              throw new Error(`${label}包含违规敏感内容，请重新上传`)
            }
            return { pass: true }
          }
        }
      }

      // 2. 异步校验 mediaCheckAsync
      if (typeof cloud.openapi.security.mediaCheckAsync === 'function') {
        let mediaUrl = media
        if (media.startsWith('cloud://') && typeof cloud.getTempFileURL === 'function') {
          const tempRes = await cloud.getTempFileURL({ fileList: [media] }).catch(() => null)
          const item = tempRes && tempRes.fileList && tempRes.fileList[0]
          if (item && item.tempFileURL) mediaUrl = item.tempFileURL
        }

        if (mediaUrl.startsWith('http')) {
          const res = await cloud.openapi.security.mediaCheckAsync({
            mediaUrl,
            mediaType: 2,
            version: 2,
            scene,
            openid
          })
          if (res && res.errCode === 87014) {
            throw new Error(`${label}包含违规敏感内容，请重新上传`)
          }
          return { pass: true, traceId: res && res.traceId }
        }
      }
    } catch (err) {
      const errMsg = (err && (err.message || err.errMsg)) || String(err)
      const isRisky = (err && err.errCode === 87014) || errMsg.includes('87014') || errMsg.includes('risky') || errMsg.includes('敏感') || errMsg.includes('违规')
      if (isRisky) {
        throw new Error(`${label}包含违规敏感内容，请重新上传`)
      }
      console.warn('[security.mediaCheck] warning:', errMsg)
    }
    return { pass: true }
  }

  return {
    checkTextSecurity,
    checkImageSecurity
  }
}
