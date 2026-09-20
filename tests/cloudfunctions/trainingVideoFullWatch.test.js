const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('training video full watch enforcement and anti-forward verification', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'staff_openid', roles: ['staff'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'staff_openid',
        realName: '王宠托',
        auditStatus: 'approved',
        staffLevel: 'applicant',
        onboardingStatus: 'quiz_passed',
        quizPassedAt: '2026-09-20 10:00',
        trainingVideoProgress: {},
        videoAuditStatus: 'not_started'
      }
    ],
    platform_configs: []
  })

  const staffApi = loadCloudFunction('api', db, 'staff_openid')

  // 1. 尝试跳跃快进/未看完上报（300秒视频只上报50秒），后端必须拦截
  const rejectRes = await staffApi.main({
    action: 'markTrainingVideoWatched',
    module: 'staff',
    data: {
      videoKey: 'platform_rules',
      watchedSeconds: 50,
      duration: 300
    }
  })
  assert.equal(rejectRes.ok, false)
  assert.match(rejectRes.message, /培训视频须全程完整观看/)

  // 此时未记录该视频进度
  const profileAfterReject = db.state.staff_profiles[0]
  assert.equal(profileAfterReject.trainingVideoProgress.platform_rules, undefined)

  // 2. 正常完整看完第一个视频（300秒，观看了295秒，达到标准）
  const finishVideo1 = await staffApi.main({
    action: 'markTrainingVideoWatched',
    module: 'staff',
    data: {
      videoKey: 'platform_rules',
      watchedSeconds: 295,
      duration: 300
    }
  })
  assert.equal(finishVideo1.ok, true)
  assert.equal(finishVideo1.data.videoKey, 'platform_rules')
  assert.equal(finishVideo1.data.allWatched, false)

  // 检查已记录的进度数据
  const profile1 = db.state.staff_profiles[0]
  assert.equal(profile1.trainingVideoProgress.platform_rules.watched, true)
  assert.equal(profile1.trainingVideoProgress.platform_rules.watchedSeconds, 295)
  assert.equal(profile1.trainingVideoProgress.platform_rules.duration, 300)

  // 3. 完整看完剩余视频
  const finishVideo2 = await staffApi.main({
    action: 'markTrainingVideoWatched',
    module: 'staff',
    data: {
      videoKey: 'home_service',
      watchedSeconds: 360,
      duration: 360
    }
  })
  assert.equal(finishVideo2.ok, true)
  assert.equal(finishVideo2.data.allWatched, false)

  const finishVideo3 = await staffApi.main({
    action: 'markTrainingVideoWatched',
    module: 'staff',
    data: {
      videoKey: 'pet_safety',
      watchedSeconds: 480,
      duration: 480
    }
  })
  assert.equal(finishVideo3.ok, true)
  assert.equal(finishVideo3.data.allWatched, true)

  // 4. 全部视频看完，自动推进为 videos_completed
  const finalProfile = db.state.staff_profiles[0]
  assert.ok(finalProfile.trainingVideosCompletedAt)
  assert.equal(finalProfile.onboardingStatus, 'videos_completed')
})
