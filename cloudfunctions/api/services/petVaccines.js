module.exports = function createService({ safeText, nowText }) {
  const VALID_STATUSES = ['none', 'pending', 'approved', 'rejected', 'expired']

  function todayText() {
    if (typeof nowText === 'function') return String(nowText()).slice(0, 10)
    return new Date().toISOString().slice(0, 10)
  }

  function normalizePetVaccineCertification(cert = {}) {
    const rawStatus = safeText(cert.status).trim()
    let status = VALID_STATUSES.includes(rawStatus) ? rawStatus : 'none'
    const validUntil = safeText(cert.validUntil).trim()
    if (status === 'approved' && validUntil && validUntil < todayText()) status = 'expired'
    return {
      status,
      fileIds: Array.isArray(cert.fileIds) ? cert.fileIds.filter(Boolean) : [],
      submittedAt: safeText(cert.submittedAt).trim(),
      reviewedAt: safeText(cert.reviewedAt).trim(),
      reviewedByOpenid: safeText(cert.reviewedByOpenid).trim(),
      reviewRemark: safeText(cert.reviewRemark).trim(),
      rejectReason: safeText(cert.rejectReason).trim(),
      validUntil,
      vaccineTypes: Array.isArray(cert.vaccineTypes) ? cert.vaccineTypes.map((item) => safeText(item).trim()).filter(Boolean) : [],
      certificateNo: safeText(cert.certificateNo).trim(),
      latestApplicationId: safeText(cert.latestApplicationId).trim(),
      renewalPending: cert.renewalPending === true
    }
  }

  function petVaccineStatusText(cert = {}) {
    const status = normalizePetVaccineCertification(cert).status
    if (status === 'approved') return '已接种认证'
    if (status === 'pending') return '疫苗认证审核中'
    if (status === 'rejected') return '疫苗认证未通过'
    if (status === 'expired') return '疫苗认证已过期'
    return '未接种认证'
  }

  function petVaccineBadgeClass(cert = {}) {
    const status = normalizePetVaccineCertification(cert).status
    if (status === 'approved') return 'success'
    if (status === 'pending') return 'warning'
    if (status === 'rejected' || status === 'expired') return 'danger'
    return 'muted'
  }

  function isPetVaccineCertified(petOrSnapshot = {}) {
    return normalizePetVaccineCertification(petOrSnapshot.vaccineCertification || {}).status === 'approved'
  }

  function createPetVaccineSnapshot(pet = {}) {
    const cert = normalizePetVaccineCertification(pet.vaccineCertification || {})
    return {
      status: cert.status,
      validUntil: cert.validUntil,
      reviewedAt: cert.reviewedAt
    }
  }

  function decoratePetWithVaccineStatus(pet = {}) {
    const cert = normalizePetVaccineCertification(pet.vaccineCertification || {})
    const text = petVaccineStatusText(cert)
    return {
      ...pet,
      vaccineCertification: cert,
      vaccineCertified: cert.status === 'approved',
      vaccineStatus: cert.status,
      vaccineStatusText: text,
      vaccineBadgeText: text,
      vaccineBadgeClass: petVaccineBadgeClass(cert)
    }
  }

  function decoratePetsWithVaccineStatus(pets = []) {
    return (Array.isArray(pets) ? pets : []).map(decoratePetWithVaccineStatus)
  }

  function summarizeOrderPetVaccines(petSnapshots = []) {
    const list = (Array.isArray(petSnapshots) ? petSnapshots : []).filter(Boolean)
    const summary = { certifiedCount: 0, uncertifiedCount: 0, pendingCount: 0, rejectedCount: 0, expiredCount: 0 }
    list.forEach((pet) => {
      const status = normalizePetVaccineCertification(pet.vaccineCertification || {}).status
      if (status === 'approved') summary.certifiedCount += 1
      else if (status === 'pending') summary.pendingCount += 1
      else if (status === 'rejected') summary.rejectedCount += 1
      else if (status === 'expired') summary.expiredCount += 1
      else summary.uncertifiedCount += 1
    })
    return summary
  }

  function getOrderPetSnapshots(order = {}) {
    if (Array.isArray(order.petSnapshots) && order.petSnapshots.length) return order.petSnapshots
    return order.petSnapshot ? [order.petSnapshot] : []
  }

  function orderHasUnvaccinatedPets(order = {}) {
    const pets = Array.isArray(order) ? order : getOrderPetSnapshots(order)
    if (!pets.length) return true
    return pets.some((pet) => !isPetVaccineCertified(pet))
  }

  function decorateOrderWithVaccineSummary(order = {}) {
    const petSnapshots = getOrderPetSnapshots(order).map(decoratePetWithVaccineStatus)
    const vaccinePetSummary = summarizeOrderPetVaccines(petSnapshots)
    const total = petSnapshots.length
    return {
      ...order,
      petSnapshot: petSnapshots[0] || order.petSnapshot || null,
      petSnapshots: petSnapshots.length ? petSnapshots : order.petSnapshots,
      vaccinePetSummary,
      hasUnvaccinatedPets: total === 0 || vaccinePetSummary.certifiedCount < total,
      allPetsVaccineCertified: total > 0 && vaccinePetSummary.certifiedCount === total
    }
  }

  function assertStaffCanServeOrderVaccines(profile = {}, orderOrPets = {}) {
    if (profile && profile.rejectUnvaccinatedPets === true && orderHasUnvaccinatedPets(orderOrPets)) {
      throw new Error('该宠托师仅服务已接种认证宠物，请更换宠物或选择其他宠托师')
    }
  }

  function assertStaffCanAcceptOrderVaccines(profile = {}, order = {}) {
    if (profile && profile.rejectUnvaccinatedPets === true && orderHasUnvaccinatedPets(order)) {
      throw new Error('你已设置不服务未接种认证宠物，该订单包含未认证宠物，无法接单')
    }
  }

  return {
    normalizePetVaccineCertification,
    petVaccineStatusText,
    petVaccineBadgeClass,
    isPetVaccineCertified,
    createPetVaccineSnapshot,
    decoratePetWithVaccineStatus,
    decoratePetsWithVaccineStatus,
    summarizeOrderPetVaccines,
    orderHasUnvaccinatedPets,
    decorateOrderWithVaccineSummary,
    assertStaffCanServeOrderVaccines,
    assertStaffCanAcceptOrderVaccines
  }
}
