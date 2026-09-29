const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

for (const route of ['home', 'orders/list', 'orders/detail']) {
  test(`${route}: private previews, invalid coordinates and map failures are handled`, () => {
    let page
    const opened = []
    const toasts = []
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff', route, 'index.js'), 'utf8'), {
      require: () => ({ navMethods: () => ({}) }),
      Page: (config) => { page = config },
      wx: { openLocation: (options) => opened.push(options), showToast: (options) => toasts.push(options.title) }
    })
    function navigate(latitude, longitude, address, approximate = false) {
      page.data.order = { addressLatitude: latitude, addressLongitude: longitude, addressDetail: address, serviceAddress: '服务小区', doorplate: '101', locationIsApproximate: approximate }
      page.openNavigation({ currentTarget: { dataset: { latitude, longitude, address, approximate, name: '服务小区' } } })
    }
    navigate(null, null, '接单后可见')
    assert.equal(opened.length, 0)
    assert.equal(toasts.pop(), '订单缺少定位，无法导航')
    for (const [lat, lng] of [[null, 121], ['', 121], [31, undefined], ['bad', 121], [91, 121], [31, 181], [Infinity, 121], [0, 0]]) {
      navigate(lat, lng, '服务地址')
      assert.equal(opened.length, 0)
      assert.equal(toasts.pop(), '订单缺少定位，无法导航')
    }
    navigate('31.21', '121.52', '接单后可见', true)
    assert.equal(opened[0].latitude, 31.21)
    assert.equal(opened[0].longitude, 121.52)
    assert.equal(opened[0].name, '服务区域（模糊位置）')
    assert.match(opened[0].address, /参考位置/)
    assert.equal(opened[0].scale, 14)
    opened.length = 0
    navigate('31.2', '121.5', '服务地址')
    assert.equal(opened.length, 1)
    assert.equal(opened[0].latitude, 31.2)
    assert.equal(opened[0].longitude, 121.5)
    opened[0].fail({ errMsg: 'openLocation:fail' })
    assert.equal(toasts.pop(), '地图打开失败，请稍后重试')
  })
}
