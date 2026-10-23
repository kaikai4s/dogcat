const { callFunction, showError, getCloudEnv, setCachedSystemSettings } = require('../../../utils/cloud')
const MAX_BYTES = 768 * 1024
function chooseFile() {
  return new Promise((resolve, reject) => {
    if (typeof wx.chooseMessageFile !== 'function') return reject(new Error('当前微信版本不支持选择文件，请更新微信后重试'))
    wx.chooseMessageFile({ count: 1, type: 'file', extension: ['json'], success: result => resolve((result.tempFiles || [])[0]), fail: reject })
  })
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || file.size > MAX_BYTES) return reject(new Error('请选择不超过 768KB 的配置 JSON 文件'))
    wx.getFileSystemManager().readFile({ filePath: file.path, encoding: 'utf8', success: result => {
      try { resolve(JSON.parse(String(result.data).replace(/^\uFEFF/, ''))) } catch (_) { reject(new Error('JSON 文件格式有误，请重新导出')) }
    }, fail: reject })
  })
}
Page({
  data: { envId: '', busy: false, preview: null, selectedName: '', backupId: '', result: null, savedPath: '' },
  onShow() {
    const envId = getCloudEnv()
    const backupId = wx.getStorageSync('config_migration_last_backup_' + envId) || ''
    this.setData({ envId, backupId })
  },
  onUnload() { this._closed = true },
  async saveJson(snapshot, filename) {
    const path = wx.env.USER_DATA_PATH + '/' + filename
    await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath: path, data: JSON.stringify(snapshot, null, 2), encoding: 'utf8', success: resolve, fail: reject }))
    if (this._closed) return
    this.setData({ savedPath: path })
    if (typeof wx.shareFileMessage === 'function') {
      await new Promise(resolve => wx.shareFileMessage({ filePath: path, fileName: filename, success: resolve, fail: error => {
        if (!/cancel/.test(error.errMsg || '')) wx.showToast({ title: '文件已生成，可点击再次分享', icon: 'none' })
        resolve()
      } }))
    } else wx.showModal({ title: '配置文件已生成', content: '当前微信不支持文件分享，请在支持分享的微信版本使用此功能。', showCancel: false })
  },
  async exportConfig() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      const snapshot = await callFunction('configMigration', 'export')
      await this.saveJson(snapshot, 'dogcat-config-' + this.data.envId + '-' + Date.now() + '.json')
    } catch (error) { if (!this._closed) showError(error) }
    finally { if (!this._closed) this.setData({ busy: false }) }
  },
  async chooseImport() {
    if (this.data.busy) return
    this._snapshot = null
    this._requestId = ''
    this.setData({ busy: true, preview: null, result: null, selectedName: '' })
    try {
      const file = await chooseFile()
      const snapshot = await readFile(file)
      const preview = await callFunction('configMigration', 'preview', { snapshot })
      if (this._closed) return
      this._snapshot = snapshot
      this._requestId = 'config_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12)
      this.setData({ selectedName: file.name || '配置文件.json', preview })
    } catch (error) { if (!this._closed && !/cancel/.test(error.errMsg || '')) showError(error) }
    finally { if (!this._closed) this.setData({ busy: false }) }
  },
  async importConfig() {
    if (this.data.busy || !this._snapshot || !this.data.preview) return
    const preview = this.data.preview
    if (preview.target.envId !== getCloudEnv()) return showError(new Error('当前环境已变化，请重新预览'))
    this.setData({ busy: true })
    try {
      const confirmed = await new Promise(resolve => wx.showModal({ title: '确认导入到当前环境',
        content: `来源：${preview.source.envId}\n目标：${preview.target.envId}\n将写入 ${preview.changedCount} 项配置，并保留导入前备份。图片和视频需已按相同路径上传到目标环境。`,
        confirmText: '确认导入', success: result => resolve(result.confirm), fail: () => resolve(false) }))
      if (!confirmed || this._closed) return
      const result = await callFunction('configMigration', 'import', { snapshot: this._snapshot, token: preview.token,
        requestId: this._requestId, confirmEnvId: preview.target.envId })
      if (this._closed) return
      wx.setStorageSync('config_migration_last_backup_' + preview.target.envId, result.backupId)
      this.setData({ result, backupId: result.backupId, preview: null })
      this._snapshot = null
      await callFunction('system', 'getSettings').then(setCachedSystemSettings).catch(() => {})
      wx.showToast({ title: '配置导入成功' })
    } catch (error) { if (!this._closed) showError(error) }
    finally { if (!this._closed) this.setData({ busy: false }) }
  },
  async exportBackup() {
    if (this.data.busy || !this.data.backupId) return
    this.setData({ busy: true })
    try {
      const snapshot = await callFunction('configMigration', 'backup', { id: this.data.backupId })
      await this.saveJson(snapshot, 'dogcat-before-import-' + this.data.backupId + '.json')
    } catch (error) { if (!this._closed) showError(error) }
    finally { if (!this._closed) this.setData({ busy: false }) }
  },
  async exportAssetList() {
    if (this.data.busy || !this.data.preview) return
    this.setData({ busy: true })
    try { await this.saveJson({ source: this.data.preview.source, target: this.data.preview.target, files: this.data.preview.assets }, 'dogcat-config-assets-' + Date.now() + '.json') }
    catch (error) { if (!this._closed) showError(error) }
    finally { if (!this._closed) this.setData({ busy: false }) }
  },
  shareSaved() {
    if (this.data.savedPath && typeof wx.shareFileMessage === 'function') wx.shareFileMessage({ filePath: this.data.savedPath, fail: () => {} })
  }
})
