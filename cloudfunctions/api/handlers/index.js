const loaders = {
  system: () => require('./system'),
  auth: () => require('./auth'),
  playground: () => require('./playground'),
  pet: () => require('./pet'),
  petBeauty: () => require('./petBeauty'),
  client: () => require('./client'),
  homeSecurity: () => require('./homeSecurity'),
  order: () => require('./order'),
  coupon: () => require('./coupon'),
  memberLevel: () => require('./memberLevel'),
  rewardMail: () => require('./rewardMail'),
  lottery: () => require('./lottery'),
  mall: () => require('./mall'),
  adminMall: () => require('./adminMall'),
  payment: () => require('./payment'),
  finance: () => require('./finance'),
  staff: () => require('./staff'),
  track: () => require('./track'),
  checkin: () => require('./checkin'),
  incident: () => require('./incident'),
  admin: () => require('./admin'),
  ai: () => require('./ai'),
  message: () => require('./message'),
  staffMessage: () => require('./staffMessage'),
  initData: () => require('./initData')
}

module.exports = function createRegistry(context) {
  const cache = new Map()
  return function getHandler(name) {
    if (!Object.prototype.hasOwnProperty.call(loaders, name)) return null
    if (!cache.has(name)) cache.set(name, loaders[name]()(context))
    return cache.get(name)
  }
}
