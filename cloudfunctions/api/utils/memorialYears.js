const MIN_MEMORIAL_YEAR = 1980

/** 返回北京时间当前年份。 */
function currentBeijingYear(nowMs = Date.now()) {
  const numeric = Number(nowMs)
  const effective = Number.isFinite(numeric) ? numeric : Date.now()
  return new Date(effective + 8 * 3600000).getUTCFullYear()
}

/** 校验并规范化单个纪念碑年份，支持 `'unknown'` 或 `1980` 至今的四位年份。 */
function normalizeMemorialYear(value, options = {}) {
  const { label = '年份', allowEmpty = false, nowMs } = options
  if (value === undefined || value === null || String(value).trim() === '') {
    if (allowEmpty) return ''
    throw new Error(`请选择${label}（可选择未知）`)
  }
  const cleaned = String(value).normalize('NFKC').trim()
  if (cleaned.toLowerCase() === 'unknown' || cleaned === '未知') return 'unknown'
  const maxYear = currentBeijingYear(nowMs)
  if (!/^\d{4}$/.test(cleaned)) {
    throw new Error(`请选择有效的${label}（${MIN_MEMORIAL_YEAR}年至${maxYear}年，或选择未知）`)
  }
  const yearNum = Number(cleaned)
  if (!Number.isInteger(yearNum) || yearNum < MIN_MEMORIAL_YEAR || yearNum > maxYear) {
    throw new Error(`请选择有效的${label}（${MIN_MEMORIAL_YEAR}年至${maxYear}年，或选择未知）`)
  }
  return String(yearNum)
}

/** 成对校验出生年份与去世年份，保证双方合法且出生不晚于去世。 */
function normalizeMemorialYears(data = {}, options = {}) {
  const { requireExplicit = false, nowMs } = options
  const hasBirth = data.birthYear !== undefined && data.birthYear !== null && String(data.birthYear).trim() !== ''
  const hasPassing = data.passingYear !== undefined && data.passingYear !== null && String(data.passingYear).trim() !== ''
  if (!requireExplicit && !hasBirth && !hasPassing) {
    return { birthYear: '', passingYear: '' }
  }
  const birthYear = normalizeMemorialYear(hasBirth ? data.birthYear : (requireExplicit ? '' : 'unknown'), {
    label: '出生年份',
    allowEmpty: false,
    nowMs
  })
  const passingYear = normalizeMemorialYear(hasPassing ? data.passingYear : (requireExplicit ? '' : 'unknown'), {
    label: '去世年份',
    allowEmpty: false,
    nowMs
  })
  if (birthYear !== 'unknown' && passingYear !== 'unknown' && Number(birthYear) > Number(passingYear)) {
    throw new Error('出生年份不能晚于去世年份')
  }
  return { birthYear, passingYear }
}

/** 格式化生卒年份展示文本；未设置任何年份的历史记录返回空串。 */
function formatMemorialLifeSpan(birthYear, passingYear) {
  const birth = birthYear ? String(birthYear).trim() : ''
  const passing = passingYear ? String(passingYear).trim() : ''
  if (!birth && !passing) return ''
  const birthLabel = !birth || birth === 'unknown' ? '未知' : birth
  const passingLabel = !passing || passing === 'unknown' ? '未知' : passing
  return `${birthLabel} — ${passingLabel}`
}

/** 提取并格式化纪念碑年份投影字段。 */
function memorialYearFields(row = {}) {
  const birthYear = row && row.birthYear ? String(row.birthYear).trim() : ''
  const passingYear = row && row.passingYear ? String(row.passingYear).trim() : ''
  return {
    birthYear,
    passingYear,
    lifeSpanText: formatMemorialLifeSpan(birthYear, passingYear)
  }
}

module.exports = {
  MIN_MEMORIAL_YEAR,
  currentBeijingYear,
  normalizeMemorialYear,
  normalizeMemorialYears,
  formatMemorialLifeSpan,
  memorialYearFields
}
