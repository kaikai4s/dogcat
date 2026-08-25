#!/usr/bin/env node

const path = require('path')

function loadCloudSdk() {
  try {
    return require('wx-server-sdk')
  } catch (error) {
    return require(path.join(__dirname, '../cloudfunctions/api/node_modules/wx-server-sdk'))
  }
}

const cloud = loadCloudSdk()
const { envList } = require('../miniprogram/envList')

const env = process.env.WX_ENV || process.argv.find((arg) => arg.startsWith('--env='))?.slice('--env='.length) || (envList[0] && envList[0].envId)
const secretId = process.env.TENCENTCLOUD_SECRETID || process.env.TENCENTCLOUD_SECRET_ID || process.env.SECRETID || process.env.SECRET_ID
const secretKey = process.env.TENCENTCLOUD_SECRETKEY || process.env.TENCENTCLOUD_SECRET_KEY || process.env.SECRETKEY || process.env.SECRET_KEY
const runDestructive = process.env.RUN_DESTRUCTIVE === '1' || process.argv.includes('--yes')

if (!env) {
  console.error('缺少云开发环境 ID。请设置 WX_ENV 或检查 miniprogram/envList.js')
  process.exit(1)
}

if (!secretId || !secretKey) {
  console.error('本地脚本需要腾讯云密钥。请先设置 TENCENTCLOUD_SECRETID 和 TENCENTCLOUD_SECRETKEY 后重试。')
  console.error('示例：TENCENTCLOUD_SECRETID=xxx TENCENTCLOUD_SECRETKEY=xxx node scripts/clear-order-data.js')
  console.error('正式删除：TENCENTCLOUD_SECRETID=xxx TENCENTCLOUD_SECRETKEY=xxx RUN_DESTRUCTIVE=1 node scripts/clear-order-data.js')
  process.exit(1)
}

cloud.init({
  env,
  ...(secretId && secretKey ? { secretId, secretKey } : {})
})
const db = cloud.database()
const _ = db.command

const wipeCollections = [
  'orders',
  'payments',
  'payment_events',
  'refunds',
  'order_home_security',
  'order_early_start_requests',
  'track_logs',
  'checkin_logs',
  'unlock_code_logs',
  'order_incidents',
  'incident_comments',
  'incident_actions',
  'service_reviews',
  'order_timeline',
  'staff_earnings',
  'home_security_notifications'
]

const filteredCollections = [
  {
    name: 'admin_operation_logs',
    shouldDelete: (item) => item.targetType === 'order' || item.orderId || String(item.action || '').toLowerCase().includes('order')
  },
  {
    name: 'finance_logs',
    shouldDelete: (item) => item.orderId || ['order', 'payment', 'refund', 'staff_earning'].includes(item.targetType)
  }
]

async function listBatch(collectionName) {
  const res = await db.collection(collectionName).where({ _id: _.exists(true) }).limit(100).get()
  return res.data || []
}

async function countCollection(collectionName) {
  try {
    const res = await db.collection(collectionName).where({ _id: _.exists(true) }).count()
    return res.total || 0
  } catch (error) {
    console.warn(`${collectionName}: 无法统计，可能集合不存在：${error.message || error.errMsg || error}`)
    return 0
  }
}

async function wipeCollection(collectionName) {
  if (!runDestructive) {
    const total = await countCollection(collectionName)
    console.log(`[DRY RUN] ${collectionName}: 将删除 ${total} 条`)
    return total
  }

  let total = 0
  while (true) {
    const batch = await listBatch(collectionName)
    if (!batch.length) break
    await Promise.all(batch.map((item) => db.collection(collectionName).doc(item._id).remove()))
    total += batch.length
    console.log(`${collectionName}: 已删除 ${total} 条`)
  }
  return total
}

async function deleteFiltered(collectionName, shouldDelete) {
  let total = 0
  while (true) {
    const batch = await listBatch(collectionName)
    const targets = batch.filter(shouldDelete)
    if (runDestructive && targets.length) {
      await Promise.all(targets.map((item) => db.collection(collectionName).doc(item._id).remove()))
    }
    total += targets.length
    if (batch.length < 100 || !targets.length) break
    if (!runDestructive) break
  }
  console.log(`${runDestructive ? '' : '[DRY RUN] '}${collectionName}: 将删除/已删除 ${total} 条订单相关记录`)
  return total
}

async function main() {
  console.log(`云环境：${env}`)
  console.log(runDestructive ? '模式：正式删除' : '模式：预演，不会删除。正式执行需加 RUN_DESTRUCTIVE=1')

  const summary = {}
  for (const collectionName of wipeCollections) {
    summary[collectionName] = await wipeCollection(collectionName)
  }
  for (const item of filteredCollections) {
    summary[item.name] = await deleteFiltered(item.name, item.shouldDelete)
  }

  console.log('完成：')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  const message = error && (error.message || error.errMsg) || String(error)
  if (message.includes('missing secretId') || message.includes('secretKey')) {
    console.error('本地脚本需要腾讯云密钥。请先设置 TENCENTCLOUD_SECRETID 和 TENCENTCLOUD_SECRETKEY 后重试。')
    console.error('示例：TENCENTCLOUD_SECRETID=xxx TENCENTCLOUD_SECRETKEY=xxx RUN_DESTRUCTIVE=1 node scripts/clear-order-data.js')
  } else {
    console.error(error)
  }
  process.exit(1)
})
