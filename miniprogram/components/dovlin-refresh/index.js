// miniprogram/components/dovlin-refresh/index.js

// 精致紧凑的 64px 容器爪印极坐标分布 (中心 32, 32，半径 27)
const PAW_POSITIONS = [
  { id: 0, deg: 35, x: 49.1, y: 42.5, rot: 125, threshold: 0.60, active: false, delay: 0.10 },
  { id: 1, deg: 80, x: 31.7, y: 53.6, rot: 170, threshold: 0.10, active: false, delay: 0.30 },
  { id: 2, deg: 125, x: 11.5, y: 49.1, rot: 215, threshold: 0.84, active: false, delay: 0.50 },
  { id: 3, deg: 170, x: 0.4, y: 31.7, rot: 260, threshold: 0.46, active: false, delay: 0.20 },
  { id: 4, deg: 215, x: 4.9, y: 11.5, rot: 305, threshold: 0.72, active: false, delay: 0.40 },
  { id: 5, deg: 260, x: 22.3, y: 0.4, rot: 350, threshold: 0.22, active: false, delay: 0.25 },
  { id: 6, deg: 305, x: 42.5, y: 4.9, rot: 395, threshold: 0.96, active: false, delay: 0.60 },
  { id: 7, deg: 350, x: 53.6, y: 22.3, rot: 440, threshold: 0.34, active: false, delay: 0.15 }
];

Component({
  options: {
    multipleSlots: true,
    pureDataPattern: /^_/
  },

  properties: {
    // 是否启用纵向滚动
    scrollY: {
      type: Boolean,
      value: true
    },
    // 是否处于刷新状态
    refreshing: {
      type: Boolean,
      value: false
    },
    // 下拉触发刷新阈值与停靠高度 (px) - 精确匹配 92px 视口
    threshold: {
      type: Number,
      value: 92
    },
    // 是否显示状态文字
    showTips: {
      type: Boolean,
      value: true
    },
    // 是否处于纯插槽视图模式
    isSlotMode: {
      type: Boolean,
      value: false
    },
    // 外部传入进度 (0 ~ 1)
    progress: {
      type: Number,
      value: 0
    },
    // 外部传入状态 ('pulling' | 'loading' | 'success')
    status: {
      type: String,
      value: 'pulling'
    }
  },

  data: {
    isRefreshing: false,
    statusClass: 'state-pulling',
    currentTips: '下拉刷新',
    ringDeg: 0,
    orbitStyle: '',
    pawsList: PAW_POSITIONS
  },

  observers: {
    'refreshing': function (val) {
      if (val && !this.data.isRefreshing) {
        this.setData({ isRefreshing: true });
        this.startLoading();
      } else if (!val && this.data.isRefreshing) {
        this.finishRefresh();
      }
    },
    'progress': function (val) {
      if (this.data.isSlotMode && !this.data.isRefreshing) {
        this.updatePullProgress(val);
      }
    },
    'status': function (val) {
      if (this.data.isSlotMode) {
        if (val === 'loading') {
          this.startLoading();
        } else if (val === 'success') {
          this.finishRefresh();
        } else {
          this.setData({ statusClass: 'state-pulling' });
        }
      }
    }
  },

  lifetimes: {
    attached() {
      this.shufflePaws();
    }
  },

  methods: {
    /**
     * 随机打乱四周爪印激活次序 (四周随机显现)
     */
    shufflePaws() {
      const order = [0, 1, 2, 3, 4, 5, 6, 7];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = order[i];
        order[i] = order[j];
        order[j] = temp;
      }

      const updated = this.data.pawsList.map((paw, idx) => {
        const rank = order.indexOf(idx);
        return {
          ...paw,
          threshold: +(0.10 + rank * 0.12).toFixed(2),
          active: false,
          delay: +(Math.random() * 0.8).toFixed(2)
        };
      });

      this.setData({ pawsList: updated });
    },

    /**
     * 更新下拉进度核心算法
     * @param {number} val (0 ~ 1)
     */
    updatePullProgress(val) {
      val = Math.max(0, Math.min(1, val));
      const ringDeg = +(val * 360).toFixed(1);
      const orbitAngle = +(val * 180).toFixed(1);

      const updatedPaws = this.data.pawsList.map(paw => ({
        ...paw,
        active: val >= paw.threshold
      }));

      const tips = val >= 1 ? '松手立即刷新' : '下拉刷新';

      this.setData({
        ringDeg,
        orbitStyle: `transform: rotate(${orbitAngle}deg);`,
        pawsList: updatedPaws,
        currentTips: tips
      });

      this.triggerEvent('pulling', { progress: val });
    },

    onRefresherPulling(e) {
      if (this.data.isRefreshing) return;
      const dy = (e && e.detail && e.detail.dy) || 0;
      let progress = e && e.detail && typeof e.detail.p === 'number' 
        ? e.detail.p 
        : dy / this.data.threshold;
      
      this.updatePullProgress(progress);
    },

    onRefresherRefresh() {
      this.setData({ isRefreshing: true });
      this.startLoading();
    },

    onRefresherAbort() {
      this.resetPosition();
    },

    onRefresherRestore() {
      this.resetPosition();
    },

    onScroll(e) {
      this.triggerEvent('scroll', e.detail);
    },

    onScrollToLower(e) {
      this.triggerEvent('scrolltolower', e.detail);
    },

    /**
     * 进入 Loading 状态 (爪印持续 360° 无限旋转)
     */
    startLoading() {
      const allActive = this.data.pawsList.map(paw => ({ ...paw, active: true }));

      this.setData({
        statusClass: 'state-loading',
        currentTips: '正在加载中...',
        ringDeg: 280,
        orbitStyle: '', // 清空内联，激活 CSS 持续 360° 无限奔跑旋转
        pawsList: allActive
      });

      this.triggerEvent('refresh');
    },

    /**
     * 业务加载完成调用此方法收工
     * @param {string} successText
     */
    finishRefresh(successText = '刷新完成 ✨') {
      this.setData({
        statusClass: 'state-success',
        ringDeg: 360,
        currentTips: successText
      });

      // 播放小狗开心点头动画 500ms 后收回
      setTimeout(() => {
        this.setData({
          isRefreshing: false
        });
        this.resetPosition();
        this.triggerEvent('restore');
      }, 500);
    },

    /**
     * 回弹复位
     */
    resetPosition() {
      this.setData({
        ringDeg: 0,
        statusClass: 'state-pulling',
        currentTips: '下拉刷新',
        orbitStyle: 'transform: rotate(0deg);',
        pawsList: this.data.pawsList.map(paw => ({ ...paw, active: false }))
      });
      this.shufflePaws();
    }
  }
});
