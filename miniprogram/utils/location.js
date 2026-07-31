const STORAGE_KEY = 'vip_pet_selected_location'

function normalizeLocation(location = {}) {
  const latitude = Number(location.latitude || 0)
  const longitude = Number(location.longitude || 0)
  if (!latitude || !longitude) return null
  return {
    name: location.name || location.locationName || '已选择位置',
    address: location.address || location.locationTip || '',
    latitude,
    longitude,
    accuracy: Number(location.accuracy || 0),
    updatedAt: location.updatedAt || Date.now()
  }
}

function getSelectedLocation() {
  return normalizeLocation(wx.getStorageSync(STORAGE_KEY) || {})
}

function saveSelectedLocation(location) {
  const normalized = normalizeLocation({ ...location, updatedAt: Date.now() })
  if (!normalized) return null
  wx.setStorageSync(STORAGE_KEY, normalized)
  const app = getApp()
  if (app && app.globalData) app.globalData.selectedLocation = normalized
  return normalized
}

function chooseSelectedLocation() {
  return new Promise((resolve, reject) => {
    wx.chooseLocation({
      success: (location) => {
        const saved = saveSelectedLocation(location)
        if (saved) resolve(saved)
        else reject(new Error('位置信息无效'))
      },
      fail: reject
    })
  })
}

function requireSelectedLocation() {
  const saved = getSelectedLocation()
  if (saved) return Promise.resolve(saved)
  return chooseSelectedLocation()
}

module.exports = {
  getSelectedLocation,
  saveSelectedLocation,
  chooseSelectedLocation,
  requireSelectedLocation
}
