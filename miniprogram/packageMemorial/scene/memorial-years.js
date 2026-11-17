const MIN_MEMORIAL_YEAR = 1980

/** 返回北京时间当前年份。 */
function currentBeijingYear(nowMs = Date.now()) {
  const numeric = Number(nowMs)
  const effective = Number.isFinite(numeric) ? numeric : Date.now()
  return new Date(effective + 8 * 3600000).getUTCFullYear()
}

/** 生成「未知」加近几十年倒序年份选项列表。 */
function buildMemorialYearOptions(nowMs = Date.now()) {
  const maxYear = Math.max(MIN_MEMORIAL_YEAR, currentBeijingYear(nowMs))
  const options = [{ value: 'unknown', label: '未知' }]
  for (let year = maxYear; year >= MIN_MEMORIAL_YEAR; year -= 1) {
    const text = String(year)
    options.push({ value: text, label: `${text}年` })
  }
  return options
}

/** 计算给定年份值在选项数组中的索引，默认回到「未知」（索引 0）。 */
function yearOptionIndex(options = [], value = 'unknown') {
  const target = value ? String(value).trim() : 'unknown'
  const index = options.findIndex((item) => item && item.value === target)
  return index >= 0 ? index : 0
}

/** 校验出生与去世年份大小关系，合法时返回空字符串。 */
function validateMemorialYearRange(birthYear, passingYear) {
  const birth = birthYear ? String(birthYear).trim() : 'unknown'
  const passing = passingYear ? String(passingYear).trim() : 'unknown'
  if (/^\d{4}$/.test(birth) && /^\d{4}$/.test(passing) && Number(birth) > Number(passing)) {
    return '出生年份不能晚于去世年份'
  }
  return ''
}

/** 格式化生卒年份展示文案，如 `2016 — 2025` 或 `未知 — 2025`。 */
function formatMemorialLifeSpan(birthYear, passingYear) {
  const birth = birthYear ? String(birthYear).trim() : ''
  const passing = passingYear ? String(passingYear).trim() : ''
  if (!birth && !passing) return ''
  const birthLabel = !birth || birth === 'unknown' ? '未知' : birth
  const passingLabel = !passing || passing === 'unknown' ? '未知' : passing
  return `${birthLabel} — ${passingLabel}`
}

module.exports = {
  MIN_MEMORIAL_YEAR,
  currentBeijingYear,
  buildMemorialYearOptions,
  yearOptionIndex,
  validateMemorialYearRange,
  formatMemorialLifeSpan
}
