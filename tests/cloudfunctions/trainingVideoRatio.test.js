const test = require('node:test')
const assert = require('node:assert/strict')
const constants = require('../../cloudfunctions/api/config/constants')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const service = require('../../cloudfunctions/api/services/staffTraining')({ ...constants, safeText: value => String(value ?? '') })

// All profiles, media metadata and progress in this file are isolated synthetic fixtures.
function fixture(training) {
  const db = createCollectionStore({
    users: [{ _id: 'synthetic-staff', openid: 'synthetic-staff', roles: ['staff'], status: 'active' },
      { _id: 'synthetic-admin', openid: 'synthetic-admin', roles: ['admin'], status: 'active' }],
    staff_profiles: [{ _id: 'synthetic-profile', openid: 'synthetic-staff', auditStatus: 'approved', trainingVideoProgress: {} }],
    platform_configs: [{ _id: 'synthetic-settings', key: 'system_settings', value: { staffTraining: training } }]
  })
  const api = loadCloudFunction('api', db, 'synthetic-staff')
  return { db, api, mark: data => api.main({ module: 'staff', action: 'markTrainingVideoWatched', data: { videoKey: 'synthetic-video', ...data } }) }
}
const video = { key: 'synthetic-video', title: '测试培训视频', fileId: 'cloud://synthetic/video.mp4', durationText: '约 5 分钟' }

test('video ratio defaults to 80 and accepts integer percentages from 1 to 100', () => {
  assert.equal(service.normalizeStaffTrainingConfig().videoPassPercent, 80)
  for (const value of [1, '80', 90, 100]) assert.equal(service.normalizeStaffTrainingConfig({ videoPassPercent: value }).videoPassPercent, Number(value))
  for (const value of [null, '', 0, -1, 101, 80.5, 'invalid', true]) {
    assert.throws(() => service.normalizeStaffTrainingConfig({ videoPassPercent: value }), /观看通过比例/)
  }
})

test('display labels do not supply duration and fractional media metadata survives normalization', () => {
  const [displayOnly, media] = service.normalizeTrainingVideos([video, { ...video, key: 'media', durationSeconds: 0.125, durationFileId: video.fileId }])
  assert.equal(displayOnly.durationSeconds, 0)
  assert.equal(media.durationSeconds, 0.125)
  assert.equal(media.durationFileId, video.fileId)
})

test('legacy approximate duration is corrected by actual playback duration and unlocks the quiz', async () => {
  const { db, api, mark } = fixture({ videos: [{ ...video, durationSeconds: 300 }] })
  const result = await mark({ watchedSeconds: 2.5, duration: 3.125 })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.allWatched, true)
  const progress = db.state.staff_profiles[0].trainingVideoProgress[video.key]
  assert.equal(progress.duration, 3.125)
  assert.equal(progress.watchedSeconds, 2.5)
  assert.equal(progress.videoPassPercent, 80)
  const status = await api.main({ module: 'staff', action: 'getTrainingStatus' })
  assert.equal(status.data.videoPassPercent, 80)
  assert.equal(status.data.quiz.unlocked, true)
  assert.equal(status.data.videos[0].watchedSeconds, 2.5)
  assert.equal(status.data.videos[0].duration, 3.125)
})

test('sub-second and longer videos use identical percentage boundaries without rounding seconds', async () => {
  for (const [duration, percent] of [[0.125, 80], [3.125, 90], [8.25, 100], [300.25, 80]]) {
    const f = fixture({ videoPassPercent: percent, videos: [{ ...video, durationSeconds: duration, durationFileId: video.fileId }] })
    const required = duration * percent / 100
    const pending = await f.mark({ watchedSeconds: required - 0.01, duration })
    assert.equal(pending.ok, false)
    assert.match(pending.message, /未达标/)
    assert.equal(f.db.state.staff_profiles[0].trainingVideoProgress[video.key], undefined)
    const completed = await f.mark({ watchedSeconds: required, duration })
    assert.equal(completed.ok, true, completed.message)
    assert.equal(f.db.state.staff_profiles[0].trainingVideoProgress[video.key].watchedSeconds, required)
  }
})

test('missing media duration remains pending and can be completed after metadata is available', async () => {
  const { db, mark } = fixture({ videos: [video] })
  const pending = await mark({ watchedSeconds: 0, duration: 0 })
  assert.equal(pending.ok, false)
  assert.match(pending.message, /实际时长/)
  assert.equal(db.state.staff_profiles[0].trainingVideoProgress[video.key], undefined)
  assert.equal((await mark({ watchedSeconds: 1, duration: 1 })).ok, true)
})

test('admin saves the ratio and bound media duration for staff to read after reload', async () => {
  const { db } = fixture({ videos: [video] })
  const admin = loadCloudFunction('api', db, 'synthetic-admin')
  const settings = { videoPassPercent: 95, videos: [{ ...video, durationSeconds: 1.375, durationFileId: video.fileId }] }
  const saved = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { staffTraining: settings } })
  assert.equal(saved.ok, true, saved.message)
  const reloaded = await admin.main({ module: 'admin', action: 'getSystemSettings' })
  assert.equal(reloaded.data.staffTraining.videoPassPercent, 95)
  assert.equal(reloaded.data.staffTraining.videos[0].durationSeconds, 1.375)
  assert.equal(reloaded.data.staffTraining.videos[0].durationFileId, video.fileId)
  const staff = loadCloudFunction('api', db, 'synthetic-staff')
  const status = await staff.main({ module: 'staff', action: 'getTrainingStatus' })
  assert.equal(status.data.videoPassPercent, 95)
})

test('two legitimately completed videos save concurrently without losing either progress record', async () => {
  const second = { ...video, key: 'synthetic-second', fileId: 'cloud://synthetic/second.mp4' }
  const { db, api } = fixture({ videoPassPercent: 80, videos: [video, second] })
  db.state.staff_profiles[0].quizPassedAt = '2026-11-08 10:00:00'
  const results = await Promise.all([video, second].map(item => api.main({ module: 'staff', action: 'markTrainingVideoWatched',
    data: { videoKey: item.key, fileId: item.fileId, watchedSeconds: 4, duration: 5 } })))
  assert.ok(results.every(result => result.ok), results.map(result => result.message).join('; '))
  const profile = db.state.staff_profiles[0]
  assert.equal(profile.trainingVideoProgress[video.key].watched, true)
  assert.equal(profile.trainingVideoProgress[second.key].watched, true)
  assert.equal(profile.onboardingStatus, 'videos_completed')
  assert.ok(profile.trainingVideosCompletedAt)
  const status = await api.main({ module: 'staff', action: 'getTrainingStatus' })
  assert.equal(status.data.quiz.unlocked, true)
})

test('replacement media requires its own completed progress while legacy records remain compatible', async () => {
  const { db, api } = fixture({ videos: [video] })
  db.state.staff_profiles[0].trainingVideoProgress[video.key] = { watched: true }
  const status = () => api.main({ module: 'staff', action: 'getTrainingStatus' })
  assert.equal((await status()).data.videos[0].watched, true)
  const replacement = { ...video, fileId: 'cloud://synthetic/replacement.mp4', durationFileId: 'cloud://synthetic/replacement.mp4', durationSeconds: 2 }
  db.state.platform_configs[0].value.staffTraining.videos = [replacement]
  assert.equal((await status()).data.videos[0].watched, false)
  assert.equal((await status()).data.quiz.unlocked, false)
  const result = await api.main({ module: 'staff', action: 'markTrainingVideoWatched', data: { videoKey: video.key,
    fileId: replacement.fileId, watchedSeconds: 1.6, duration: 2 } })
  assert.equal(result.ok, true, result.message)
  assert.equal(db.state.staff_profiles[0].trainingVideoProgress[video.key].fileId, replacement.fileId)
  assert.equal((await status()).data.quiz.unlocked, true)
})

test('duplicate completion acknowledgements keep the original accurate seconds and completion timestamp', async () => {
  const { db, mark } = fixture({ videos: [video] })
  assert.equal((await mark({ watchedSeconds: 4.5, duration: 5 })).ok, true)
  const original = structuredClone(db.state.staff_profiles[0].trainingVideoProgress[video.key])
  const completedAt = db.state.staff_profiles[0].trainingVideosCompletedAt
  assert.equal((await mark({ watchedSeconds: 4, duration: 5 })).ok, true)
  assert.deepEqual(db.state.staff_profiles[0].trainingVideoProgress[video.key], original)
  assert.deepEqual(db.state.staff_profiles[0].trainingVideosCompletedAt, completedAt)
})
