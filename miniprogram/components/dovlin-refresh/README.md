# Dovlin 品牌专属下拉刷新组件 (`<dovlin-refresh>`)

## 特性亮点
1. **100% 官方原图还原**：纯白身体小狗、深绿轮廓（`#145938`）、暖黄牵引绳项圈（`#F7C346`）、原图精准内外镂空 Dovlin 字标。
2. **360° 环绕跑动小爪印**：8 个黄色爪印分布在四周，下拉时像小狗奔跑踩步般随机跳跃浮现，同时爪印整体跟随下拉进度向前转动。
3. **Loading 持续无限旋转**：进入加载中状态后，爪印群保持点亮，**以 1.35s 周期无休止地持续围绕中央图标 360° 旋转**，绝不停滞！
4. **开心点头回弹收尾**：刷新完成播放开心的点头回弹与弹性收缩动画。

---

## 快速接入指南

### 方式一：容器包裹模式（推荐，极简无缝接入）

在任意页面中直接用 `<dovlin-refresh>` 包裹列表或页面内容：

#### 1. 页面配置 `index.json`
```json
{
  "usingComponents": {
    "dovlin-refresh": "/components/dovlin-refresh/index"
  },
  "disableScroll": false
}
```

#### 2. 页面模板 `index.wxml`
```xml
<dovlin-refresh id="dovlinRefresh" bind:refresh="onPullDownRefresh">
  <!-- 你的原页面列表或内容 -->
  <view class="pet-service-list">
    <block wx:for="{{list}}" wx:key="id">
      <view class="card">{{item.title}}</view>
    </block>
  </view>
</dovlin-refresh>
```

#### 3. 页面逻辑 `index.js`
```javascript
Page({
  data: {
    list: []
  },

  // 触发下拉刷新
  onPullDownRefresh() {
    this.loadData().then(() => {
      // 业务数据加载完成后，调用 finishRefresh 优雅收起
      const refreshComp = this.selectComponent('#dovlinRefresh');
      if (refreshComp) {
        refreshComp.finishRefresh('更新完毕 ✨');
      }
    });
  },

  loadData() {
    return new Promise((resolve) => {
      setTimeout(resolve, 1500); // 模拟网络请求
    });
  }
});
```

---

### 方式二：微信原生 `scroll-view` 自定义 Refresher 插槽模式

如果你的页面已经使用了 `<scroll-view>`，可以直接将其作为插槽：

```xml
<scroll-view 
  scroll-y 
  refresher-enabled="{{true}}" 
  refresher-default-style="none" 
  refresher-triggered="{{isTriggered}}" 
  bindrefresherpulling="onPulling" 
  bindrefresherrefresh="onRefresh" 
  bindrefresherrestore="onRestore">
  
  <!-- 自定义下拉刷新头 -->
  <view slot="refresher">
    <dovlin-refresh 
      is-slot-mode="{{true}}" 
      progress="{{pullProgress}}" 
      status="{{refreshStatus}}" />
  </view>

  <!-- 页面内容 -->
  <view class="content">...</view>
</scroll-view>
```

---

## 组件属性表 (Properties)

| 属性名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `threshold` | Number | `90` | 下拉触发刷新阈值 (单位 px) |
| `maxPull` | Number | `140` | 最大允许下拉位移 (单位 px) |
| `damp` | Number | `0.45` | 橡皮筋手势阻尼系数 (0.3 ~ 0.6) |
| `showTips` | Boolean | `true` | 是否在图标下方显示状态提示文案 |
| `isSlotMode` | Boolean | `false` | 是否用于 `scroll-view` 的 `slot="refresher"` |
| `progress` | Number | `0` | 外部传入进度 (0~1)，仅在 slot 模式有效 |
| `status` | String | `'pulling'` | 外部传入状态 (`'pulling'` / `'loading'` / `'success'`) |

## 组件对外事件 (Events)

| 事件名 | 触发时机 | 返回参数 |
| :--- | :--- | :--- |
| `bind:refresh` | 下拉超过阈值松手时触发 | 无 |
| `bind:pulling` | 手指下拉拖动过程中持续触发 | `{ progress: 0~1 }` |
| `bind:restore` | 刷新结束并且回弹复位后触发 | 无 |

## 组件方法 (通过 `selectComponent` 调用)

| 方法名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `startLoading()` | 无 | 主动启动 loading 加载动画（爪印持续旋转） |
| `finishRefresh(text)` | `text: string` | 业务完成时调用，播放小狗开心点头与流光收拢，随后自动复位 |
| `shufflePaws()` | 无 | 随机打乱四周爪印激活次序 |
| `resetPosition()` | 无 | 强制立即弹性回弹复位 |
