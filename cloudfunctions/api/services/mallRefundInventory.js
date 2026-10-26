const { readOptionalDocument } = require('../utils/documentPages')

module.exports = function createMallRefundInventory({ db, now, normalizeMallProduct, getSkuById }) {
  async function restorePendingStock(orderId) {
    try {
      return await db.runTransaction(async tx => {
        const order = await readOptionalDocument(tx, 'mall_orders', orderId)
        if (!order || !order.stockRestorePending || order.stockRestored) return { restored: false }
        if (order.paymentStatus !== 'refunded') throw new Error('退款尚未完成，不能恢复库存')
        const products = new Map()
        for (const item of order.items || []) {
          const quantity = Number(item.quantity)
          if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('退款商品数量异常，请核对库存')
          let product = products.get(item.productId)
          if (!product) {
            const raw = await readOptionalDocument(tx, 'mall_products', item.productId)
            if (!raw) throw new Error('退款商品不存在，请核对库存')
            product = normalizeMallProduct(raw)
          }
          const sku = getSkuById(product, item.skuId)
          if (!sku) throw new Error('退款商品规格不存在，请核对库存')
          const skus = product.skus.map(row => row.skuId === sku.skuId ? { ...row,
            stock: Number(row.stock || 0) + quantity,
            salesCount: Math.max(0, Number(row.salesCount || 0) - quantity) } : row)
          const changed = skus.find(row => row.skuId === sku.skuId)
          product = normalizeMallProduct({ ...product, skus,
            ...(product.specMode === 'single' ? { stock: changed.stock, salesCount: changed.salesCount } : {}) })
          products.set(item.productId, product)
        }
        if (!products.size) throw new Error('退款商品明细缺失，请核对库存')
        const time = now()
        for (const [id, product] of products) {
          const { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText } = product
          await tx.collection('mall_products').doc(id).update({ data: {
            skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText, updatedAt: time
          } })
        }
        await tx.collection('mall_orders').doc(orderId).update({ data: {
          stockRestored: true, stockRestoredAt: time, stockRestorePending: false,
          stockRestoreError: '', stockRestoreCheckedAt: time
        } })
        return { restored: true }
      })
    } catch (error) {
      const message = String(error.message || error).slice(0, 300)
      // The financial result is already committed. Inventory recovery has its
      // own durable queue and must never roll back a successful gateway refund.
      await db.collection('mall_orders').where({ _id: orderId, stockRestorePending: true, stockRestored: db.command.neq(true) })
        .update({ data: { stockRestoreError: message, stockRestoreCheckedAt: now() } })
        .catch(writeError => console.error('[refund-inventory-error-record]', { orderId, message: writeError.message }))
      console.error('[refund-inventory-pending]', { orderId, message })
      return { restored: false, error: message }
    }
  }

  async function retryPendingStock() {
    const rows = (await db.collection('mall_orders').where({ stockRestorePending: true })
      .orderBy('stockRestoreCheckedAt', 'asc').orderBy('_id', 'asc').limit(10).get()).data || []
    for (const row of rows) await restorePendingStock(row._id)
    return rows.length
  }
  return { restorePendingStock, retryPendingStock }
}
