module.exports = function createService({
  
}) {
  function isActiveCheckin(item = {}) {
    return !item.deletedAt
  }

  function hasCheckinPhoto(item = {}) {
    return isActiveCheckin(item) && Boolean(item.mediaFileId)
  }

  function toCheckinPhotoView(item = {}) {
    return {
      _id: item._id || '',
      eventType: item.eventType || '',
      mediaFileId: item.mediaFileId || '',
      remark: item.remark || '',
      recordedAt: item.recordedAt || item.createdAt || item.serverTime || '',
      createdAt: item.createdAt || '',
      latitude: item.latitude,
      longitude: item.longitude
    }
  }

  function groupCheckinsByEventType(checkins = []) {
    return checkins.filter(hasCheckinPhoto).reduce((map, item) => {
      const eventType = item.eventType || ''
      if (!eventType) return map
      if (!map[eventType]) map[eventType] = { count: 0, photos: [] }
      map[eventType].count += 1
      map[eventType].photos.push(toCheckinPhotoView(item))
      return map
    }, {})
  }

  return {
    isActiveCheckin,
    hasCheckinPhoto,
    toCheckinPhotoView,
    groupCheckinsByEventType
  }
}
