const crypto = require('crypto')
const { readOptionalDocument } = require('../utils/documentPages')
const containsFile = (value, fileId) => value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
  ['fileId', 'sourceFileId', 'textFileId'].includes(key) && child === fileId || containsFile(child, fileId))
// Queue only immutable files created by the server and not adopted by a record.
async function discardFiles(context, fileIds, referenceIds = []) {
  for (const fileId of [...new Set(fileIds.filter(Boolean))]) {
    const id = 'memorial_unused_file_' + crypto.createHash('sha256').update(fileId).digest('hex').slice(0, 32)
    await context.db.collection('platform_configs').doc(id).set({ data: { key: 'memorial_unused_file', fileId, referenceIds: [...new Set(referenceIds.filter(Boolean))], createdAt: context.now() } })
  }
}
async function cleanupUnusedFiles(context) {
  const rows = await context.db.collection('platform_configs').where({ key: 'memorial_unused_file' }).limit(30).get()
  for (const row of rows.data || []) {
    try {
      // A transaction can commit even when its acknowledgement is lost. The
      // same document IDs also protect archived content during the recovery period.
      const references = await Promise.all((row.referenceIds || []).map(id => readOptionalDocument(context.db, 'platform_configs', id)))
      if (references.some(value => containsFile(value, row.fileId))) {
        await context.db.collection('platform_configs').doc(row._id).remove()
        continue
      }
      const result = await context.cloud.deleteFile({ fileList: [row.fileId] })
      const file = result && result.fileList && result.fileList[0]
      if (!file || Number(file.status) !== 0 && !/not.?exist|not.?found|不存在/i.test(file.errMsg || '')) continue
      await context.db.collection('platform_configs').doc(row._id).remove()
    } catch (error) { console.error('[memorial-unused-file]', row._id, error.message) }
  }
}
module.exports = { discardFiles, cleanupUnusedFiles }
