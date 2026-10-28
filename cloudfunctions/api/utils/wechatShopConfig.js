const SHOP_CONFIG_ID = 'wechat_shop'

async function readWechatShopConfig(db) {
  const configs = db.collection('platform_configs')
  const canonical = await configs.where({ _id: SHOP_CONFIG_ID, key: 'wechat_shop' }).limit(1).get()
  if (canonical.data && canonical.data[0]) return canonical.data[0]
  const legacy = await configs.where({ key: 'wechat_shop' }).limit(1).get()
  return legacy.data[0] || {}
}

module.exports = { SHOP_CONFIG_ID, readWechatShopConfig }
