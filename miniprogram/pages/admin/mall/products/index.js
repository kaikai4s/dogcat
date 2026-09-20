const { callFunction, showError } = require('../../../../utils/cloud')

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

function emptySpecGroup() { return { name: '', valuesText: '' } }
function emptyProduct() {
  return { _id: '', categoryId: '', categoryName: '', name: '', subtitle: '', coverFileId: '', imageFileIds: [], price: '', originalPrice: '', stock: '', specText: '', specMode: 'single', specGroupsForm: [emptySpecGroup()], skus: [], description: '', sortOrder: 0, status: 'on_sale' }
}

const emptyCategory = { _id: '', name: '', icon: '', sortOrder: 0, enabled: true }

function splitSpecValues(value = '') {
  return Array.from(new Set(String(value || '').split(/,|，|、|\n/).map((item) => item.trim()).filter(Boolean)))
}

function normalizeSpecGroupsForForm(product = {}) {
  const groups = Array.isArray(product.specGroups) ? product.specGroups : []
  if (!groups.length) return [emptySpecGroup()]
  const merged = new Map()
  groups.forEach((group) => {
    const name = String(group.name || '').trim()
    const values = (group.values || []).map((value) => String(value || '').trim()).filter(Boolean)
    if (name && values.length) merged.set(name, Array.from(new Set((merged.get(name) || []).concat(values))))
  })
  return Array.from(merged, ([name, values]) => ({ name, valuesText: values.join('、') }))
}

function buildSpecGroups(form = {}) {
  const groups = (form.specGroupsForm || []).map((group) => ({ name: String(group.name || '').trim(), values: splitSpecValues(group.valuesText) })).filter((group) => group.name || group.values.length)
  if (!groups.length || groups.length > 3) throw new Error('请填写1至3个属性')
  const names = new Set()
  groups.forEach((group) => {
    if (!group.name || names.has(group.name)) throw new Error('属性名称不能为空或重复')
    if (group.values.length > 20) throw new Error('每个属性最多20个值')
    names.add(group.name)
  })
  return groups
}

function skuKey(specs = {}) {
  return JSON.stringify(Object.keys(specs).sort().map((key) => [key, specs[key]]))
}

function cartesianSpecRows(groups = []) {
  return groups.reduce((rows, group) => {
    const nextRows = []
    rows.forEach((row) => {
      group.values.forEach((value) => nextRows.push({ specs: { ...row.specs, [group.name]: value }, values: row.values.concat(value) }))
    })
    return nextRows
  }, [{ specs: {}, values: [] }])
}

function productPriceText(product = {}) {
  if (product.priceText) return product.priceText
  const min = Number(product.minPrice || product.price || 0)
  const max = Number(product.maxPrice || min)
  return min === max ? `¥${min}` : `¥${min}-${max}`
}

function normalizeSkusForForm(product = {}) {
  const skus = Array.isArray(product.skus) ? product.skus : []
  if (skus.length) return skus.map((sku, index) => ({ skuId: sku.skuId || `sku_${Date.now()}_${index}`, specText: sku.specText || '默认规格', specs: sku.specs || {}, price: sku.price == null ? '' : sku.price, originalPrice: sku.originalPrice == null ? '' : sku.originalPrice, stock: sku.stock == null ? '' : sku.stock, imageFileId: sku.imageFileId || '', status: sku.status === 'off_sale' ? 'off_sale' : 'on_sale' }))
  return []
}

function buildProductForm(product = {}, categories = []) {
  const category = categories.find((item) => item._id === product.categoryId)
  return {
    ...emptyProduct(),
    ...product,
    categoryName: category ? category.name : (product.categoryName || ''),
    imageFileIds: Array.isArray(product.imageFileIds) ? product.imageFileIds : [],
    specMode: product.specMode === 'multi' ? 'multi' : 'single',
    specGroupsForm: normalizeSpecGroupsForForm(product),
    skus: normalizeSkusForForm(product)
  }
}

function withCategoryName(product, categories = []) {
  const category = categories.find((item) => item._id === product.categoryId)
  const stock = Number(product.totalStock || product.stock || 0)
  const status = product.status === 'off_sale' ? 'off_sale' : 'on_sale'
  const soldOut = stock <= 0
  const lowStock = stock > 0 && stock <= 5
  return {
    ...product,
    categoryName: category ? category.name : '未分类',
    statusText: status === 'on_sale' ? '上架中' : '已下架',
    statusClass: status === 'on_sale' ? 'success' : 'muted-badge',
    stockText: soldOut ? '售罄' : (lowStock ? '低库存' : '库存充足'),
    stockClass: soldOut ? 'danger-badge' : (lowStock ? 'warning' : 'success'),
    imageCount: (product.imageFileIds || []).length || (product.coverFileId ? 1 : 0),
    cover: product.coverFileId || (product.imageFileIds || [])[0] || '',
    specText: product.hasSku ? `${product.skuCount || 0}个规格` : (product.specText || '默认规格'),
    priceText: productPriceText(product)
  }
}

function categoryStats(categories = [], products = []) {
  return {
    totalCategories: categories.length,
    enabledCategories: categories.filter((item) => item.enabled !== false).length,
    totalProducts: products.length,
    onSaleProducts: products.filter((item) => item.status === 'on_sale').length,
    lowStockProducts: products.filter((item) => Number(item.totalStock || item.stock || 0) <= 5).length
  }
}

Page({
  data: { categories: [], products: [], stats: categoryStats(), keyword: '', status: '', page: 1, pageSize: 10, hasMore: true, loading: false, uploadingImage: false, editingProduct: false, productForm: emptyProduct(), editingCategory: false, categoryForm: emptyCategory },

  onShow() { this.loadAll() },
  onReachBottom() { this.loadMore() },

  syncStats(nextState = {}) {
    const categories = nextState.categories || this.data.categories
    const products = nextState.products || this.data.products
    this.setData({ stats: categoryStats(categories, products) })
  },
  loadAll() { this.loadCategories(); this.loadProducts({ reset: true }) },
  loadCategories() {
    callFunction('adminMall', 'listCategories')
      .then((categories) => {
        const products = this.data.products.map((item) => withCategoryName(item, categories))
        this.setData({ categories, products })
        this.syncStats({ categories, products })
      })
      .catch(showError)
  },
  loadProducts(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('adminMall', 'listProducts', { keyword: this.data.keyword, status: this.data.status, page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        const pageProducts = pageData.list.map((item) => withCategoryName(item, this.data.categories))
        const products = reset ? pageProducts : this.data.products.concat(pageProducts)
        this.setData({ products, page: pageData.page, hasMore: pageData.hasMore, loading: false })
        this.syncStats({ products })
      })
      .catch((error) => { this.setData({ loading: false }); showError(error) })
  },
  loadMore() { if (!this.data.hasMore || this.data.loading) return; this.setData({ page: this.data.page + 1 }, () => this.loadProducts()) },
  inputKeyword(e) { this.setData({ keyword: e.detail.value }) },
  search() { this.setData({ page: 1, hasMore: true }, () => this.loadProducts({ reset: true })) },
  filterStatus(e) { this.setData({ status: e.currentTarget.dataset.status || '', page: 1, hasMore: true }, () => this.loadProducts({ reset: true })) },

  showProduct(e) {
    const product = this.data.products.find((item) => item._id === e.currentTarget.dataset.id)
    const firstCategory = this.data.categories[0]
    const form = product ? buildProductForm(product, this.data.categories) : { ...emptyProduct(), categoryId: firstCategory && firstCategory._id || '', categoryName: firstCategory && firstCategory.name || '' }
    this.setData({ editingProduct: true, productForm: form })
  },
  hideProduct() { this.setData({ editingProduct: false }) },
  inputProduct(e) { this.setData({ ['productForm.' + e.currentTarget.dataset.field]: e.detail.value }) },
  chooseCategory(e) { const item = this.data.categories[e.detail.value]; if (item) this.setData({ ['productForm.categoryId']: item._id, ['productForm.categoryName']: item.name }) },
  setSpecMode(e) {
    const mode = e.currentTarget.dataset.mode || 'single'
    if (mode === this.data.productForm.specMode) return
    wx.showModal({ title: '切换规格模式', content: '切换为单规格保存时将清除多规格；切换为多规格后请同步SKU并核对价格库存。', success: (res) => {
      if (res.confirm) this.setData({ ['productForm.specMode']: mode, ['productForm.specsDirty']: true })
    } })
  },
  inputSpecGroup(e) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field
    this.setData({ [`productForm.specGroupsForm[${index}].${field}`]: e.detail.value, ['productForm.specsDirty']: true })
  },
  addSpecGroup() {
    const groups = this.data.productForm.specGroupsForm || []
    if (groups.length >= 3) return wx.showToast({ title: '最多添加3个规格名', icon: 'none' })
    this.setData({ ['productForm.specGroupsForm']: groups.concat(emptySpecGroup()), ['productForm.specsDirty']: true })
  },
  removeSpecGroup(e) {
    const groups = (this.data.productForm.specGroupsForm || []).slice()
    if (groups.length <= 1) return wx.showToast({ title: '至少保留一个规格名', icon: 'none' })
    wx.showModal({ title: '删除属性', content: '删除后须重新同步SKU，无法对应的旧组合不会保留，请核对价格库存。', success: (res) => {
      if (!res.confirm) return
      groups.splice(Number(e.currentTarget.dataset.index), 1)
      this.setData({ ['productForm.specGroupsForm']: groups, ['productForm.specsDirty']: true })
    } })
  },
  inputSku(e) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field
    this.setData({ [`productForm.skus[${index}].${field}`]: e.detail.value })
  },
  toggleSkuStatus(e) {
    const index = Number(e.currentTarget.dataset.index)
    const sku = this.data.productForm.skus[index]
    if (!sku) return
    this.setData({ [`productForm.skus[${index}].status`]: sku.status === 'off_sale' ? 'on_sale' : 'off_sale' })
  },
  generateSkus() {
    const form = this.data.productForm
    let groups
    try {
      groups = buildSpecGroups(form)
      if (groups.reduce((count, group) => count * group.values.length, 1) > 80) throw new Error('组合超过80个，请减少属性值')
    } catch (error) { return showError(error) }
    const oldMap = new Map()
    ;(form.skus || []).forEach((sku) => {
      const key = skuKey(sku.specs || {})
      oldMap.set(key, oldMap.has(key) ? null : sku)
    })
    const skus = cartesianSpecRows(groups).map((row, index) => {
      const old = oldMap.get(skuKey(row.specs)) || {}
      return { ...old, skuId: old.skuId || `sku_${Date.now()}_${index}`, specs: row.specs, specText: old.specText || row.values.join(' / '), price: old.price == null ? '' : old.price, originalPrice: old.originalPrice == null ? '' : old.originalPrice, stock: old.stock == null ? '' : old.stock, imageFileId: old.imageFileId || '', status: old.status || 'on_sale' }
    })
    this.setData({ ['productForm.skus']: skus, ['productForm.specsDirty']: false })
  },
  chooseCoverImage() { this.chooseMallImages('cover') },
  chooseCarouselImages() { this.chooseMallImages('carousel') },
  chooseSkuImage(e) { this.chooseMallImages('sku', Number(e.currentTarget.dataset.index)) },
  chooseMallImages(type, skuIndex) {
    const current = this.data.productForm.imageFileIds || []
    const count = type === 'carousel' ? Math.max(9 - current.length, 1) : 1
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = res.tempFiles || []
        if (!files.length) return
        this.setData({ uploadingImage: true })
        wx.showLoading({ title: '上传图片中...' })
        files.reduce((chain, file) => chain.then(() => this.uploadMallImage(file.tempFilePath, type, skuIndex)), Promise.resolve())
          .then(() => { wx.hideLoading(); this.setData({ uploadingImage: false }); wx.showToast({ title: '图片已上传' }) })
          .catch((err) => { wx.hideLoading(); this.setData({ uploadingImage: false }); showError(err) })
      },
      fail: (err) => { if (err && err.errMsg && !err.errMsg.includes('cancel')) showError(err) }
    })
  },
  uploadMallImage(filePath, type, skuIndex) {
    const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
    const cloudPath = `mall/products/${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: (upload) => {
          const fileID = upload.fileID
          if (type === 'cover') this.setData({ ['productForm.coverFileId']: fileID })
          else if (type === 'sku') this.setData({ [`productForm.skus[${skuIndex}].imageFileId`]: fileID })
          else this.setData({ ['productForm.imageFileIds']: (this.data.productForm.imageFileIds || []).concat(fileID).slice(0, 9) })
          resolve(fileID)
        },
        fail: reject
      })
    })
  },
  removeCarouselImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const images = (this.data.productForm.imageFileIds || []).slice()
    images.splice(index, 1)
    this.setData({ ['productForm.imageFileIds']: images })
  },
  removeSkuImage(e) { this.setData({ [`productForm.skus[${Number(e.currentTarget.dataset.index)}].imageFileId`]: '' }) },
  previewMallImage(e) {
    const current = e.currentTarget.dataset.url
    const skuImages = (this.data.productForm.skus || []).map((item) => item.imageFileId).filter(Boolean)
    const urls = [this.data.productForm.coverFileId].concat(this.data.productForm.imageFileIds || [], skuImages).filter(Boolean)
    if (current && urls.length) wx.previewImage({ current, urls })
  },
  saveProduct() {
    const form = this.data.productForm
    const imageFileIds = Array.isArray(form.imageFileIds) ? form.imageFileIds : []
    const specMode = form.specMode === 'multi' ? 'multi' : 'single'
    const data = { ...form, id: form._id, price: Number(form.price || 0), originalPrice: Number(form.originalPrice || 0), stock: Number(form.stock || 0), sortOrder: Number(form.sortOrder || 0), imageFileIds, specMode }
    if (specMode === 'multi') {
      let groups
      try {
        groups = buildSpecGroups(form)
        if (form.specsDirty || !form.skus.length || form.skus.some((sku) => Object.keys(sku.specs || {}).length !== groups.length || groups.some((group) => !group.values.includes((sku.specs || {})[group.name])))) throw new Error('属性已更改，请重新同步SKU')
        if (form.skus.some((sku) => String(sku.price == null ? '' : sku.price).trim() === '' || String(sku.stock == null ? '' : sku.stock).trim() === '')) throw new Error('请填写每个SKU的价格和库存')
      } catch (error) { return showError(error) }
      data.specGroups = groups
      data.skus = (form.skus || []).map((sku) => ({ ...sku, specs: sku.specs || {}, price: Number(sku.price || 0), originalPrice: Number(sku.originalPrice || 0), stock: Number(sku.stock || 0), imageFileId: sku.imageFileId || '' }))
    }
    callFunction('adminMall', 'saveProduct', data).then(() => { wx.showToast({ title: '已保存' }); this.setData({ editingProduct: false }); this.loadProducts({ reset: true }) }).catch(showError)
  },
  toggleStatus(e) {
    const id = e.currentTarget.dataset.id
    const status = e.currentTarget.dataset.status === 'on_sale' ? 'off_sale' : 'on_sale'
    callFunction('adminMall', 'toggleProductStatus', { id, status }).then(() => this.loadProducts({ reset: true })).catch(showError)
  },

  showCategory(e) {
    const category = this.data.categories.find((item) => item._id === e.currentTarget.dataset.id)
    this.setData({ editingCategory: true, categoryForm: category ? { ...category } : { ...emptyCategory } })
  },
  hideCategory() { this.setData({ editingCategory: false }) },
  inputCategory(e) { this.setData({ ['categoryForm.' + e.currentTarget.dataset.field]: e.detail.value }) },
  switchCategory(e) { this.setData({ ['categoryForm.enabled']: e.detail.value }) },
  saveCategory() {
    const form = this.data.categoryForm
    callFunction('adminMall', 'saveCategory', { ...form, id: form._id, sortOrder: Number(form.sortOrder || 0) }).then(() => { wx.showToast({ title: '已保存' }); this.setData({ editingCategory: false }); this.loadCategories() }).catch(showError)
  },
  deleteCategory(e) {
    wx.showModal({ title: '删除分类', content: '分类下没有商品时才可删除，确认删除？', success: (res) => { if (res.confirm) callFunction('adminMall', 'deleteCategory', { id: e.currentTarget.dataset.id }).then(() => this.loadCategories()).catch(showError) } })
  }
})
