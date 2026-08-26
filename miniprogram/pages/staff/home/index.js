const { callFunction, showError, requirePrivacyAuthorize } = require('../../../utils/cloud')
const { getSelectedLocation } = require('../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../utils/theme')
const { loadMessageUnread } = require('../../../utils/client-nav')

function hasCoordinate(latitude, longitude) {
  return Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude)) && Math.abs(Number(latitude)) > 0.000001 && Math.abs(Number(longitude)) > 0.000001
}

function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (degree) => degree * Math.PI / 180
  const radius = 6371
  const radLat1 = toRad(Number(lat1))
  const radLat2 = toRad(Number(lat2))
  const dLat = toRad(Number(lat2) - Number(lat1))
  const dLng = toRad(Number(lng2) - Number(lng1))
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatDistance(distanceKm) {
  if (distanceKm === null) return '未定位'
  return distanceKm < 1 ? `${Math.round(distanceKm * 1000)}m` : `${distanceKm.toFixed(2)}km`
}

function normalizeCityName(city) {
  return String(city || '').trim().replace(/^(.*省|.*自治区)/, '').replace(/(市|特别行政区|地区|盟|自治州)$/, '')
}

function extractCityFromText(text) {
  const value = String(text || '')
  const directCity = value.match(/(北京市|上海市|天津市|重庆市|香港特别行政区|澳门特别行政区)/)
  if (directCity) return directCity[1]
  const city = value.match(/(?:.*省|.*自治区)?([^省自治区特别行政区]{2,20}市|[^省自治区特别行政区]{2,20}自治州|[^省自治区特别行政区]{2,20}地区|[^省自治区特别行政区]{2,20}盟)/)
  return city ? city[1] : ''
}

function getLocationCity(location) {
  return location && (location.city || extractCityFromText(`${location.address || ''}${location.name || ''}`)) || ''
}

function orderMatchesCity(order, selectedCity) {
  const filterCity = normalizeCityName(selectedCity)
  if (!filterCity) return true
  const orderCity = normalizeCityName(order.city || extractCityFromText(`${order.serviceAddress || ''}${order.addressDetail || ''}`))
  if (!orderCity) return true
  return orderCity.includes(filterCity) || filterCity.includes(orderCity)
}

function formatWorkbenchLocationText(locationText, location) {
  const name = location ? (location.name || location.address || '已选择位置') : ''
  return `${locationText}：${name}`
}

function applyCityFilter(orders, selectedCity) {
  return (orders || []).filter((order) => orderMatchesCity(order, selectedCity))
}

function applyWorkbenchDistances(orders, location) {
  if (!hasCoordinate(location && location.latitude, location && location.longitude)) return orders || []
  return (orders || []).map((order) => {
    if (!hasCoordinate(order.addressLatitude, order.addressLongitude)) {
      return { ...order, distanceKm: null, distanceText: '未定位' }
    }
    const distanceKm = calcDistanceKm(location.latitude, location.longitude, order.addressLatitude, order.addressLongitude)
    return { ...order, distanceKm, distanceText: formatDistance(distanceKm) }
  })
}

function normalizeScheduleSlots(raw) {
  if (!raw || typeof raw !== 'object') return null
  const result = {}
  let hasAny = false
  for (let day = 1; day <= 7; day++) {
    const list = Array.isArray(raw[String(day)]) ? raw[String(day)] : []
    const slots = list
      .map((s) => ({ start: Math.max(0, Math.min(23, Math.floor(Number(s.start || 0)))), end: Math.max(1, Math.min(24, Math.floor(Number(s.end || 0)))) }))
      .filter((s) => s.end > s.start)
    result[String(day)] = slots
    if (slots.length) hasAny = true
  }
  return hasAny ? result : null
}

function applyOrderFlags(orders, radiusKm, schedule) {
  const normalized = normalizeScheduleSlots(schedule)
  return orders.map((order) => {
    const inRange = order.distanceKm !== null && order.distanceKm <= radiusKm
    let inTime = true
    if (normalized && order.startTime) {
      const d = new Date(String(order.startTime).replace(/-/g, '/'))
      if (!isNaN(d.getTime())) {
        const jsDay = d.getDay()
        const dayKey = String(jsDay === 0 ? 7 : jsDay)
        const slots = normalized[dayKey]
        if (!Array.isArray(slots) || !slots.length) {
          inTime = false
        } else {
          const hour = d.getHours() + d.getMinutes() / 60
          inTime = slots.some((s) => hour >= s.start && hour < s.end)
        }
      }
    }
    return { ...order, inRange, inTime }
  })
}

Page({
  data: {
    themeClass: 'theme-day',
    directOrders: [],
    nearbyOrders: [],
    locationReady: false,
    locationText: '尚未获取当前位置',
    loadingNearby: false,
    missingAddressNotice: false,
    // 筛选状态
    selectedCity: '深圳市',
    inServiceRange: false,
    inServiceTime: false,
    filterDate: '',
    showFilterPanel: false,
    customLocation: null,
    currentWorkbenchLocation: null,
    staffRadiusKm: 5,
    staffSchedule: null,
    messageUnreadCount: 0,
    messageHasUnread: false
  },

  onShow() {
    this.applyCurrentTheme()
    loadMessageUnread(this, 'staff')
    const justUpdatedWorkbenchLocation = this.lastWorkbenchLocationUpdatedAt && Date.now() - this.lastWorkbenchLocationUpdatedAt < 10000
    if (this.choosingWorkbenchLocation || justUpdatedWorkbenchLocation) return
    // 每次进入页面，工作台位置默认重置为宠托师个人中心的固定服务地址
    this.setData({ customLocation: null }, () => {
      this.initStaffHome()
    })
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  initStaffHome() {
    callFunction('staff', 'getStaffProfile')
      .then((profile) => {
        let location = this.data.customLocation
        let locationTag = '已选择位置'

        if (profile) {
          this.setData({
            staffRadiusKm: Math.max(Number(profile.serviceRadiusKm || 5), 1),
            staffSchedule: profile.weeklySchedule || null
          })
          if (!this.data.customLocation && !this.cityManuallySelected && profile.serviceCity && profile.serviceCity !== '服务城市待完善') {
            this.setData({ selectedCity: profile.serviceCity })
          }
          if (profile.auditStatus === 'approved') {
            const hasAddr = Boolean(profile.serviceAddress && profile.serviceLatitude && profile.serviceLongitude)
            this.setData({ missingAddressNotice: !hasAddr })
          } else {
            this.setData({ missingAddressNotice: false })
          }

          if (!location && profile.serviceLatitude && profile.serviceLongitude) {
            location = {
              latitude: Number(profile.serviceLatitude),
              longitude: Number(profile.serviceLongitude),
              name: profile.serviceAddress || '常驻服务地址',
              address: profile.serviceAddress || ''
            }
            locationTag = '常驻服务位置'
          }
        }

        if (!location) {
          location = getSelectedLocation()
          locationTag = '选定位置'
        }

        if (location) {
          this.loadNearby(location, locationTag)
        } else {
          this.loadNearby({ latitude: 0, longitude: 0, name: '当前城市' }, '城市推荐')
        }
      })
      .catch(() => {
        const location = this.data.customLocation || getSelectedLocation()
        if (location) {
          this.loadNearby(location, '选定位置')
        } else {
          this.loadNearby({ latitude: 0, longitude: 0, name: '默认位置' }, '城市推荐')
        }
      })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  },

  detail(e) { wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + e.currentTarget.dataset.id }) },

  backProfile() { wx.redirectTo({ url: '/pages/staff/profile/index' }) },

  // 城市筛选
  onCityPickerChange(e) {
    const val = e.detail.value || []
    let city = ''
    if (Array.isArray(val) && val.length >= 2) {
      // 直辖市处理：如 ["北京市", "市辖区", "朝阳区"] -> "北京市"
      if (val[1] === '市辖区' || val[1] === '县' || !val[1]) {
        city = val[0]
      } else {
        city = val[1]
      }
    } else if (typeof val === 'string') {
      city = val
    }
    if (city) {
      this.cityManuallySelected = true
      this.setData({ selectedCity: city }, () => {
        this.reFetchOrders()
      })
    }
  },

  // 开关下拉面板
  toggleFilterPanel() {
    this.setData({ showFilterPanel: !this.data.showFilterPanel })
  },

  // 切换“服务范围内”
  toggleInServiceRange() {
    this.setData({ inServiceRange: !this.data.inServiceRange }, () => {
      this.reFetchOrders()
    })
  },

  // 切换“服务时间内”
  toggleInServiceTime() {
    this.setData({ inServiceTime: !this.data.inServiceTime }, () => {
      this.reFetchOrders()
    })
  },

  // 日期筛选变化
  onDateChange(e) {
    this.setData({ filterDate: e.detail.value }, () => {
      this.reFetchOrders()
    })
  },

  // 清除日期筛选
  clearDate() {
    this.setData({ filterDate: '' }, () => {
      this.reFetchOrders()
    })
  },

  // 重置下拉筛选条件
  resetFilters() {
    this.setData({
      inServiceRange: false,
      inServiceTime: false,
      filterDate: ''
    }, () => {
      this.reFetchOrders()
    })
  },

  reFetchOrders() {
    // 重新获取订单：如果有手动更新的工作台位置，保持当前工作台位置；否则重新初始化
    if (this.data.customLocation) {
      this.loadNearby(this.data.customLocation, '工作台位置')
    } else {
      this.initStaffHome()
    }
  },

  loadNearbyWithSavedLocation() {
    const location = getSelectedLocation()
    if (!location) {
      this.setData({ directOrders: [], nearbyOrders: [], locationReady: false, locationText: '请先选择服务位置' })
      return
    }
    this.loadNearby(location, '已推荐订单')
  },

  refreshNearby() {
    this.choosingWorkbenchLocation = true
    requirePrivacyAuthorize()
      .then(() => new Promise((resolve, reject) => {
        wx.chooseLocation({
          success: resolve,
          fail: reject
        })
      }))
      .then((rawLocation) => {
        this.choosingWorkbenchLocation = false
        this.lastWorkbenchLocationUpdatedAt = Date.now()
        const location = {
          name: rawLocation.name || rawLocation.address || '工作台位置',
          address: rawLocation.address || rawLocation.name || '',
          latitude: Number(rawLocation.latitude || 0),
          longitude: Number(rawLocation.longitude || 0),
          accuracy: Number(rawLocation.accuracy || 0),
          updatedAt: Date.now()
        }
        if (!hasCoordinate(location.latitude, location.longitude)) throw new Error('位置信息无效')
        const locationCity = getLocationCity(location)
        const updates = {
          customLocation: location,
          currentWorkbenchLocation: location,
          locationText: formatWorkbenchLocationText('更新后位置', location)
        }
        if (locationCity) {
          updates.selectedCity = locationCity
          this.cityManuallySelected = true
        }
        this.setData(updates, () => {
          this.loadNearby(location, '更新后位置', true)
        })
      })
      .catch((error) => {
        this.choosingWorkbenchLocation = false
        showError(error)
      })
  },


  loadNearby(location, locationText, force = false) {
    if (this.data.loadingNearby && !force) return
    this.setData({ loadingNearby: true })
    const data = {
      latitude: Number(location ? location.latitude : 0),
      longitude: Number(location ? location.longitude : 0),
      accuracy: Number(location ? location.accuracy : 0),
      city: this.data.selectedCity,
      inServiceRange: this.data.inServiceRange,
      inServiceTime: this.data.inServiceTime,
      filterDate: this.data.filterDate
    }

    // 静默尝试更新宠托师当前定位，不阻断订单列表与距离重算的加载
    callFunction('staff', 'updateCurrentLocation', data).catch(() => {})

    Promise.all([
      callFunction('staff', 'listDirectOrders', data),
      callFunction('staff', 'listNearbyOrders', data)
    ])
      .then(([directOrders, nearbyOrders]) => {
        const recalculatedDirectOrders = applyWorkbenchDistances(directOrders, location)
        let recalculatedNearbyOrders = applyWorkbenchDistances(applyCityFilter(nearbyOrders, this.data.selectedCity), location)
        recalculatedNearbyOrders = applyOrderFlags(recalculatedNearbyOrders, this.data.staffRadiusKm, this.data.staffSchedule)
        if (this.data.inServiceRange) recalculatedNearbyOrders = recalculatedNearbyOrders.filter((o) => o.inRange)
        if (this.data.inServiceTime) recalculatedNearbyOrders = recalculatedNearbyOrders.filter((o) => o.inTime)
        recalculatedNearbyOrders.sort((a, b) => (a.distanceKm === null ? 999999 : a.distanceKm) - (b.distanceKm === null ? 999999 : b.distanceKm))
        this.setData({
          directOrders: recalculatedDirectOrders,
          nearbyOrders: recalculatedNearbyOrders,
          locationReady: true,
          currentWorkbenchLocation: location || null,
          locationText: formatWorkbenchLocationText(locationText, location),
          loadingNearby: false
        })
      })
      .catch((error) => {
        this.setData({ loadingNearby: false })
        showError(error)
      })
  },

  openNavigation(e) {
    const { latitude, longitude, name, address } = e.currentTarget.dataset
    const lat = Number(latitude)
    const lng = Number(longitude)
    if (!lat || !lng) {
      wx.showToast({ title: '订单缺少定位，无法导航', icon: 'none' })
      return
    }
    wx.openLocation({
      latitude: lat,
      longitude: lng,
      name: name || '服务地址',
      address: address || name || '服务地址',
      scale: 16
    })
  },

  accept(e) {
    const orderId = e.currentTarget.dataset.id
    callFunction('staff', 'acceptOrder', { orderId })
      .then(() => {
        wx.showToast({ title: '接单成功' })
        const location = this.data.customLocation || this.data.currentWorkbenchLocation
        if (location) this.loadNearby(location, '已按工作台位置推荐订单')
        else this.loadNearbyWithSavedLocation()
      })
      .catch(showError)
  }
})
