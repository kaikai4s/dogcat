module.exports = function createHelpers({ db, safeText }) {
async function getAllDocuments(collectionName, orderByField = 'createdAt', orderDirection = 'desc') {
  const limit = 100
  let allData = []
  let hasMore = true
  let offset = 0

  while (hasMore) {
    let query = db.collection(collectionName)
    if (orderByField) {
      query = query.orderBy(orderByField, orderDirection)
    }
    // A unique tie-breaker keeps equal timestamps from losing documents.
    if (orderByField !== '_id') query = query.orderBy('_id', 'asc')
    query = query.skip(offset).limit(limit)

    const res = await query.get()
    const data = res.data || []
    allData = allData.concat(data)

    if (data.length < limit) {
      hasMore = false
    } else {
      offset += data.length
    }
  }

  return allData
}

async function getDocOrNull(collectionName, id) {
  if (!id) return null
  try {
    const res = await db.collection(collectionName).doc(id).get()
    return res.data ? { _id: id, ...res.data } : null
  } catch (error) {
    return null
  }
}

async function findByClientRequestId(collectionName, scope) {
  const clientRequestId = safeText(scope.clientRequestId).trim()
  if (!clientRequestId) return null
  const where = { clientRequestId }
  if (scope.openid) where.openid = scope.openid
  if (scope.orderId) where.orderId = scope.orderId
  if (scope.staffOpenid) where.staffOpenid = scope.staffOpenid
  const res = await db.collection(collectionName).where(where).limit(1).get()
  return res.data[0] || null
}

return { getAllDocuments, getDocOrNull, findByClientRequestId }
}
