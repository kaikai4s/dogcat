function ok(data) { return { ok: true, data } }

function inferErrorCode(message = '') {
  const text = String(message || '')
  if (text.includes('请先登录') || text.includes('账号不可用')) return 'AUTH_REQUIRED'
  if (text.includes('仅管理员') || text.includes('无权') || text.includes('不是该订单') || text.includes('仅订单员工') || text.includes('仅宠物主')) return 'FORBIDDEN'
  if (text.includes('状态不可') || text.includes('仅服务中') || text.includes('订单完成后') || text.includes('已被分配') || text.includes('已评价')) return 'INVALID_STATE'
  if (text.includes('请选择') || text.includes('请填写') || text.includes('请上传') || text.includes('格式无效') || text.includes('不能为空') || text.includes('不正确') || text.includes('无效')) return 'VALIDATION_ERROR'
  if (text.includes('不存在') || text.includes('未配置') || text.includes('不可用')) return 'NOT_FOUND'
  return 'UNKNOWN_ERROR'
}

function fail(message, code) { return { ok: false, code: code || inferErrorCode(message), message } }

module.exports = { ok, inferErrorCode, fail }
