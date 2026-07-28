# VIP 上门遛狗/宠护微信小程序软件开发需求与设计文档 V1.1

## 1. 项目概述

### 1.1 项目定位

本项目是一套面向中高端宠物主的上门宠物服务系统，核心服务包括：

- 上门遛狗
- 上门喂养
- 入户照看
- 服务过程可视化监管
- 服务证据链留存
- 隐私与家庭安全保护

系统的核心信任机制围绕以下能力建设：

1. **可视化履约**：通过 GPS 实时轨迹、入户/离户打卡、照片/视频水印，向宠物主证明服务真实发生。
2. **隐私保护**：通过虚拟号、限时门锁密码、敏感信息权限隔离，减少用户隐私泄露风险。
3. **安全合规**：通过宠托师实名认证、资质审核、保险契约、证据链归档，提升纠纷处理能力。
4. **标准化服务流程**：将服务动作拆解为强制打卡节点，降低员工自由发挥带来的服务不确定性。

### 1.2 目标用户

#### 宠物主

- 有中高频宠物照护需求的城市用户
- 中高端社区住户
- 经常出差、加班、旅行的宠物主人
- 对宠物安全、家庭隐私、服务透明度要求较高的用户

#### 宠托师 / 员工

- 经过平台认证的宠物服务人员
- 具备基础宠物照护、牵引、防爆冲、应急处理能力
- 接受平台统一调度与服务流程约束

#### 平台管理员

- 负责订单调度
- 负责员工资质审核
- 负责异常订单干预
- 负责客诉仲裁与财务结算

### 1.3 系统端划分

| 端 | 使用对象 | 主要能力 |
|---|---|---|
| 客户端微信小程序 | 宠物主 | 宠物建档、预约下单、支付、轨迹查看、报告查看、联系客服 |
| 员工端微信小程序 | 宠托师 | 接单、查看任务、限时解锁、GPS 上报、拍照打卡、SOS |
| 管理后台 PC Web | 管理员 | 订单调度、员工审核、异常监控、财务结算、证据链导出 |
| 后端 API 服务 | 系统服务 | 鉴权、订单、支付、定位、打卡、加密、通知、风控 |

---

## 2. 技术栈建议

### 2.1 前端技术栈

#### 微信小程序端

推荐方案：**Uni-app + Vue 3 + TypeScript**

原因：

- 可同时支持客户端与员工端代码复用
- 对微信小程序生态兼容较好
- Vue 3 生态成熟，适合快速开发业务页面
- 后续如需扩展 H5 或 App，可保留一定跨端能力

可选方案：

- 微信小程序原生开发：更贴近微信能力，但工程复用弱
- Taro + React：适合 React 团队，但小程序兼容成本略高

#### 管理后台

推荐方案：**Vue 3 + Vite + TypeScript + Element Plus**

主要原因：

- 后台管理系统开发效率高
- 表格、表单、弹窗、权限菜单等组件成熟
- 适合订单、审核、财务、证据链等运营管理场景

### 2.2 后端技术栈

推荐方案：**Node.js + NestJS + TypeScript**

原因：

- 模块化清晰，适合订单、支付、定位、打卡、认证等领域拆分
- TypeScript 类型约束利于长期维护
- 与前端技术栈统一，降低团队协作成本
- 生态中支付、OSS、图片处理、队列任务支持完整

可选方案：

- Python + FastAPI：接口开发快，适合 Python 团队
- Django：后台管理能力强，但实时轨迹和模块拆分需额外设计

### 2.3 数据库与中间件

| 类型 | 推荐 | 用途 |
|---|---|---|
| 主数据库 | MySQL 8 / PostgreSQL | 用户、宠物、订单、财务、审核数据 |
| 缓存 | Redis | 登录态、验证码、订单锁、定位缓存、限流 |
| 对象存储 | 腾讯云 COS / 阿里云 OSS | 图片、视频、资质文件、水印图 |
| 队列 | BullMQ / RabbitMQ | 轨迹异步入库、水印处理、消息通知、结算任务 |
| 地图服务 | 腾讯位置服务 / 高德地图 | 地址解析、路线展示、距离计算 |
| 支付 | 微信支付 | 小程序支付、退款、企业付款到零钱 |
| 通知 | 微信订阅消息 + SMS | 订单状态、服务提醒、异常告警 |

---

## 3. 总体架构设计

### 3.1 架构说明

系统采用前后端分离架构：

```text
微信小程序客户端 / 员工端
        │
        │ HTTPS API
        ▼
NestJS API 服务
        │
        ├── MySQL / PostgreSQL：业务主数据
        ├── Redis：缓存、锁、实时定位
        ├── OSS/COS：图片、视频、证件文件
        ├── 微信支付：支付、退款、结算
        ├── 地图 SDK：定位、路线、距离
        └── 消息队列：异步水印、通知、结算

PC 管理后台
        │
        └── 通过 Admin API 管理订单、员工、财务、风控
```

### 3.2 核心业务流程

#### 客户下单流程

```text
登录/手机号授权
  → 创建或选择宠物档案
  → 填写家庭安防信息
  → 选择服务类型与时间段
  → 系统计算价格
  → 创建待支付订单
  → 微信支付
  → 支付成功
  → 自动生成保险记录
  → 等待平台派单或自动匹配员工
```

#### 员工履约流程

```text
员工认证通过
  → 接收订单任务
  → 服务开始前 30 分钟可查看任务详情
  → 到达客户地址
  → 请求限时门锁密码
  → 入户拍照打卡
  → 开启后台 GPS 定位
  → 执行遛狗/喂养服务
  → 按节点完成排便、饮水、异常等打卡
  → 离户拍照打卡
  → 结束服务
  → 清除本地敏感缓存
  → 生成服务报告
```

#### 管理后台监控流程

```text
查看进行中订单
  → 监控员工位置与订单状态
  → 系统识别异常：超时未到、轨迹停滞、提前结束、密码异常请求
  → 后台弹窗预警
  → 管理员介入联系双方
  → 必要时导出证据链处理客诉
```

---

## 4. 功能模块设计

## 4.1 客户端微信小程序

### 4.1.1 登录与用户管理

#### 功能说明

- 微信授权登录
- 获取 openid / unionid
- 微信手机号一键绑定
- 用户资料维护
- 客户、员工、管理员角色识别

#### 关键规则

- 手机号必须绑定后才允许下单
- openid 作为微信生态身份标识，不直接暴露给前端业务页面
- 用户角色由后端控制，前端不得自行切换身份

### 4.1.2 宠物档案管理

#### 字段设计

- 宠物名称
- 品种
- 体重
- 性别
- 是否绝育
- 疫苗状态
- 是否有攻击倾向
- 是否护食
- 是否爆冲
- 是否分离焦虑
- 过敏信息
- 喂食说明
- 牵引说明
- 宠物照片

#### 业务规则

- 每个用户可创建多个宠物档案
- 下单时必须选择一个宠物
- 敏感备注需要在员工接单后展示给员工
- 敏感备注需在员工服务结束后隐藏，避免长期暴露

### 4.1.3 家庭安防信息管理

#### 功能说明

用户可维护：

- 门锁密码
- 钥匙存放位置
- 入户注意事项
- 室内监控位置说明
- 禁止进入区域说明
- 紧急联系人

#### 安全规则

- 前端提交门锁密码前使用后端下发的 RSA 公钥加密
- 后端解密后使用 AES-256-GCM 加密保存
- 数据库不存储明文密码
- 员工端仅在服务时间窗口内可申请查看
- 管理员默认不可直接查看明文密码，除非进入受审计的安全操作流程

### 4.1.4 预约与下单

#### 功能说明

- 选择服务类型：遛狗 / 上门喂养
- 选择服务日期和时间段
- 选择宠物
- 自动计算价格
- 支付订单
- 查看订单状态

#### 价格规则示例

| 宠物体重 | 遛狗基础价 | 喂养基础价 |
|---|---:|---:|
| 10kg 以下 | 69 元 / 次 | 59 元 / 次 |
| 10kg - 25kg | 89 元 / 次 | 69 元 / 次 |
| 25kg 以上 | 119 元 / 次 | 89 元 / 次 |

附加费用：

- 夜间服务费
- 节假日服务费
- 多宠服务费
- 超距离服务费
- 加急预约费

### 4.1.5 实时履约监控

#### 功能说明

客户可在服务中查看：

- 宠托师当前位置
- GPS 轨迹线
- 服务开始时间
- 当前服务时长
- 总里程
- 打卡时间轴
- 打卡照片/视频
- 异常备注

#### 展示内容

```text
订单进行中
  - 宠托师已入户 10:02
  - 已开始遛狗 10:08
  - 排便打卡 10:22，含照片与定位
  - 饮水打卡 10:36，含照片与定位
  - 已离户并确认闭锁 11:03
```

### 4.1.6 服务报告

服务完成后自动生成报告：

- 服务时间
- 服务人员
- 服务路线
- 总里程
- 关键打卡节点
- 宠物状态
- 排便情况
- 饮水情况
- 异常说明
- 图片/视频附件

### 4.1.7 虚拟号联系

#### 功能说明

- 客户与员工之间通过虚拟号联系
- 双方真实手机号互不可见
- 服务结束后一段时间自动失效

#### 规则建议

- 订单分配成功后生成虚拟号绑定关系
- 订单完成后 24 小时失效
- 客诉期内可由管理员延长有效期

---

## 4.2 员工端微信小程序

### 4.2.1 员工入驻与认证

#### 认证资料

- 姓名
- 手机号
- 身份证正反面
- 人脸核验结果
- 无犯罪记录证明
- 宠物相关资格证
- 健康证
- 服务城市
- 可服务区域
- 紧急联系人

#### 审核状态

```text
待提交 → 待审核 → 审核通过 / 审核拒绝 → 冻结 / 解冻
```

### 4.2.2 接单与任务管理

#### 功能说明

- 查看可接订单
- 查看已分配订单
- 查看服务时间、地址、宠物信息
- 查看宠物敏感注意事项
- 接受或拒绝任务

#### 规则

- 未通过认证的员工不可接单
- 被封禁或冻结的员工不可接单
- 员工同一时间段不可接多个冲突订单
- 接单后需确认已阅读宠物注意事项

### 4.2.3 限时门锁密码解锁

#### 解锁条件

员工请求 `/api/order/unlock-code` 时，后端必须校验：

1. 请求用户已登录且角色为 staff
2. 员工是该订单绑定的 staff_id
3. 订单状态为 assigned 或 in_service
4. 当前服务器时间处于 `[start_time - 30 分钟, end_time]`
5. 订单未取消、未完成
6. 请求频率未超过安全限制

通过后返回明文密码或钥匙说明。

#### 结束后控制

- 员工点击离户打卡后，前端立即清除本地缓存
- 服务完成后接口不再返回密码
- 后端记录每次密码查看日志
- 异常频繁查看触发风控告警

### 4.2.4 标准化打卡流程

#### 遛狗服务打卡节点

| 节点 | 是否强制 | 说明 |
|---|---|---|
| 到达小区 | 建议 | 定位确认到达 |
| 入户打卡 | 强制 | 拍摄门锁或玄关状态 |
| 牵引出门 | 强制 | 拍摄宠物佩戴牵引状态 |
| 排便打卡 | 可选/建议 | 拍照记录排便情况 |
| 饮水打卡 | 可选/建议 | 拍照记录饮水 |
| 回家入户 | 强制 | 拍摄宠物回家状态 |
| 离户闭锁 | 强制 | 拍摄门锁关闭状态 |

#### 喂养服务打卡节点

| 节点 | 是否强制 | 说明 |
|---|---|---|
| 入户打卡 | 强制 | 拍摄入户状态 |
| 食盆打卡 | 强制 | 拍摄喂食前后状态 |
| 水碗打卡 | 强制 | 拍摄换水前后状态 |
| 猫砂/排泄区 | 可选 | 根据订单要求 |
| 宠物状态 | 强制 | 拍摄宠物精神状态 |
| 离户闭锁 | 强制 | 拍摄门锁关闭状态 |

### 4.2.5 相机防伪机制

#### 前端要求

- 使用微信小程序原生 `<camera>` 组件
- 禁止从相册选择
- 不使用普通 `<input type="file">`
- 上传原始拍摄文件
- 同时提交定位信息、订单信息、打卡类型

#### 后端要求

- 使用服务器时间作为权威时间
- 使用后端接收到的定位数据与服务订单进行校验
- 使用 Canvas / Sharp / ImageMagick 写入不可篡改像素水印
- 原图和水印图可分开存储
- 图片元数据不作为唯一证据，必须以像素水印和服务日志为准

### 4.2.6 后台 GPS 定位上报

#### 小程序配置

`app.json` 需要声明：

```json
{
  "requiredBackgroundModes": ["location"]
}
```

#### 前端示例

```js
wx.startLocationUpdateBackground({
  success: () => {
    wx.onLocationChange((location) => {
      // 建议本地队列缓存，批量上报
      enqueueTrackPoint({
        latitude: location.latitude,
        longitude: location.longitude,
        speed: location.speed,
        recordedAt: Date.now()
      })
    })
  },
  fail: (err) => {
    console.error('后台定位权限开启失败', err)
  }
})
```

#### 上报规则

- 服务中每 5-10 秒采集一次定位
- 每 10-30 秒批量上报一次
- 网络异常时写入本地缓存
- 网络恢复后按时间顺序补传
- 后端根据订单状态决定是否接收定位点
- 非服务时间段拒绝上报或仅记录异常日志

### 4.2.7 一键 SOS

#### 触发场景

- 宠物突发疾病
- 宠物挣脱牵引
- 宠物咬伤他人
- 员工受伤
- 入户异常
- 门锁无法关闭

#### 触发后动作

- 立即通知平台管理员
- 通知宠物主
- 记录员工位置
- 允许上传现场图片/视频
- 生成异常事件记录
- 后台进入应急处理流程

---

## 4.3 PC 管理后台

### 4.3.1 仪表盘

展示：

- 今日订单数
- 进行中订单数
- 异常订单数
- 待审核员工数
- 今日收入
- 待结算佣金
- 服务城市分布

### 4.3.2 订单管理

#### 功能

- 订单列表
- 订单详情
- 分配员工
- 修改服务状态
- 取消订单
- 退款处理
- 查看轨迹
- 查看打卡
- 导出证据链

#### 异常预警

- 距离服务开始 10 分钟仍未到达
- 服务开始后未入户打卡
- GPS 长时间不动
- 轨迹明显偏离服务区域
- 未完成强制打卡却提交完成
- 密码查看次数异常

### 4.3.3 员工审核管理

#### 功能

- 查看认证资料
- 审核通过/拒绝
- 冻结/解冻员工
- 查看历史服务记录
- 查看投诉记录
- 调整服务区域

### 4.3.4 财务结算

#### 功能

- 订单收入统计
- 平台抽成配置
- 员工佣金计算
- 提现申请审核
- 微信企业付款到零钱
- 退款记录
- 发票记录

#### 结算规则示例

```text
订单完成后进入待结算
  → 客诉保护期结束
  → 系统计算员工佣金
  → 员工申请提现
  → 后台审核
  → 微信企业付款
  → 更新结算状态
```

### 4.3.5 客诉与证据链

#### 证据链内容

- 订单基本信息
- 客户与员工信息脱敏展示
- 服务开始/结束时间
- GPS 轨迹点
- 打卡日志
- 水印图片/视频
- 虚拟号通话记录摘要
- 聊天记录
- 密码查看日志
- 管理员操作日志

---

## 5. 数据库设计

> 以下为核心表结构，可根据实际 ORM 进行字段类型调整。

### 5.1 用户表 users

```sql
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    openid VARCHAR(64) UNIQUE NOT NULL,
    unionid VARCHAR(64),
    phone VARCHAR(20),
    nickname VARCHAR(50),
    avatar_url VARCHAR(255),
    role ENUM('client', 'staff', 'admin') DEFAULT 'client',
    status ENUM('active', 'frozen', 'deleted') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### 5.2 宠物档案表 pets

```sql
CREATE TABLE pets (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL,
    name VARCHAR(50) NOT NULL,
    species ENUM('dog', 'cat', 'other') DEFAULT 'dog',
    breed VARCHAR(50),
    weight DECIMAL(5,2),
    gender TINYINT,
    birthday DATE,
    is_sterilized TINYINT DEFAULT 0,
    vaccine_status TINYINT DEFAULT 0,
    has_aggression TINYINT DEFAULT 0,
    has_food_guarding TINYINT DEFAULT 0,
    has_leash_pulling TINYINT DEFAULT 0,
    has_separation_anxiety TINYINT DEFAULT 0,
    allergy_notes TEXT,
    feeding_notes TEXT,
    walking_notes TEXT,
    special_notes TEXT,
    photo_url VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 5.3 家庭安防信息表 home_security

```sql
CREATE TABLE home_security (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL UNIQUE,
    door_lock_code_cipher TEXT,
    door_lock_code_iv VARCHAR(64),
    door_lock_code_tag VARCHAR(64),
    key_location TEXT,
    entry_notes TEXT,
    camera_locations TEXT,
    forbidden_areas TEXT,
    emergency_contact_name VARCHAR(50),
    emergency_contact_phone VARCHAR(20),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 5.4 员工认证表 staff_profiles

```sql
CREATE TABLE staff_profiles (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL UNIQUE,
    real_name VARCHAR(50) NOT NULL,
    id_card_no_cipher TEXT,
    id_card_front_url VARCHAR(255),
    id_card_back_url VARCHAR(255),
    face_verify_status ENUM('pending', 'passed', 'failed') DEFAULT 'pending',
    no_criminal_record_url VARCHAR(255),
    qualification_cert_url VARCHAR(255),
    health_cert_url VARCHAR(255),
    service_city VARCHAR(50),
    service_areas TEXT,
    audit_status ENUM('draft', 'pending', 'approved', 'rejected', 'frozen') DEFAULT 'draft',
    audit_remark TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 5.5 订单表 orders

```sql
CREATE TABLE orders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_no VARCHAR(32) UNIQUE NOT NULL,
    client_id BIGINT NOT NULL,
    staff_id BIGINT,
    pet_id BIGINT NOT NULL,
    service_type ENUM('walk', 'feed') NOT NULL,
    service_address VARCHAR(255) NOT NULL,
    address_latitude DECIMAL(10,7),
    address_longitude DECIMAL(10,7),
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    pay_amount DECIMAL(10,2) NOT NULL,
    status ENUM('pending_pay', 'paid', 'assigned', 'in_service', 'completed', 'cancelled', 'refunded') DEFAULT 'pending_pay',
    insurance_policy_no VARCHAR(64),
    cancel_reason TEXT,
    paid_at DATETIME,
    completed_at DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_client_id (client_id),
    INDEX idx_staff_id (staff_id),
    INDEX idx_status (status),
    INDEX idx_start_time (start_time)
);
```

### 5.6 支付表 payments

```sql
CREATE TABLE payments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id BIGINT NOT NULL,
    payment_no VARCHAR(64) UNIQUE NOT NULL,
    wx_transaction_id VARCHAR(64),
    amount DECIMAL(10,2) NOT NULL,
    status ENUM('pending', 'success', 'failed', 'closed', 'refunded') DEFAULT 'pending',
    paid_at DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_order_id (order_id)
);
```

### 5.7 GPS 轨迹点表 track_logs

```sql
CREATE TABLE track_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id BIGINT NOT NULL,
    staff_id BIGINT NOT NULL,
    latitude DECIMAL(10,7) NOT NULL,
    longitude DECIMAL(10,7) NOT NULL,
    speed DECIMAL(5,2),
    accuracy DECIMAL(8,2),
    recorded_at DATETIME NOT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_order_time (order_id, recorded_at),
    INDEX idx_staff_time (staff_id, recorded_at)
);
```

### 5.8 服务打卡日志表 checkin_logs

```sql
CREATE TABLE checkin_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id BIGINT NOT NULL,
    staff_id BIGINT NOT NULL,
    event_type ENUM('arrive', 'enter_door', 'leash_on', 'poop', 'water', 'feed', 'pet_status', 'return_home', 'leave_door', 'exception') NOT NULL,
    media_url VARCHAR(255) NOT NULL,
    watermarked_media_url VARCHAR(255),
    latitude DECIMAL(10,7),
    longitude DECIMAL(10,7),
    server_time DATETIME NOT NULL,
    remark TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_order_id (order_id),
    INDEX idx_event_type (event_type)
);
```

### 5.9 门锁密码访问日志 unlock_code_logs

```sql
CREATE TABLE unlock_code_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id BIGINT NOT NULL,
    staff_id BIGINT NOT NULL,
    request_ip VARCHAR(64),
    user_agent VARCHAR(255),
    result ENUM('success', 'forbidden', 'expired', 'rate_limited') NOT NULL,
    reason VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_order_id (order_id),
    INDEX idx_staff_id (staff_id)
);
```

### 5.10 异常事件表 order_incidents

```sql
CREATE TABLE order_incidents (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id BIGINT NOT NULL,
    staff_id BIGINT,
    incident_type ENUM('sos', 'late_arrival', 'gps_stuck', 'route_deviation', 'pet_escape', 'injury', 'door_lock_issue', 'other') NOT NULL,
    description TEXT,
    latitude DECIMAL(10,7),
    longitude DECIMAL(10,7),
    status ENUM('open', 'processing', 'resolved', 'closed') DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_order_id (order_id),
    INDEX idx_status (status)
);
```

### 5.11 管理员操作日志 admin_operation_logs

```sql
CREATE TABLE admin_operation_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    admin_id BIGINT NOT NULL,
    target_type VARCHAR(50) NOT NULL,
    target_id BIGINT NOT NULL,
    action VARCHAR(50) NOT NULL,
    detail JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_admin_id (admin_id),
    INDEX idx_target (target_type, target_id)
);
```

---

## 6. API 接口设计

### 6.1 鉴权接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/wechat-login` | 微信登录 |
| POST | `/api/auth/bind-phone` | 绑定手机号 |
| GET | `/api/auth/me` | 获取当前用户信息 |
| POST | `/api/auth/logout` | 退出登录 |

### 6.2 宠物接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/pets` | 获取宠物列表 |
| POST | `/api/pets` | 新增宠物 |
| GET | `/api/pets/:id` | 获取宠物详情 |
| PUT | `/api/pets/:id` | 编辑宠物 |
| DELETE | `/api/pets/:id` | 删除宠物 |

### 6.3 家庭安防接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/home-security` | 获取脱敏安防信息 |
| PUT | `/api/home-security` | 更新安防信息 |
| GET | `/api/security/public-key` | 获取 RSA 公钥 |

### 6.4 订单接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/orders/quote` | 订单试算 |
| POST | `/api/orders` | 创建订单 |
| GET | `/api/orders` | 订单列表 |
| GET | `/api/orders/:id` | 订单详情 |
| POST | `/api/orders/:id/cancel` | 取消订单 |
| POST | `/api/orders/:id/pay` | 发起支付 |
| GET | `/api/orders/:id/report` | 服务报告 |

### 6.5 员工订单接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/staff/orders` | 员工订单列表 |
| POST | `/api/staff/orders/:id/accept` | 接单 |
| POST | `/api/staff/orders/:id/start` | 开始服务 |
| POST | `/api/staff/orders/:id/finish` | 完成服务 |
| POST | `/api/order/unlock-code` | 获取限时门锁密码 |

### 6.6 GPS 轨迹接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/track/batch` | 批量上报轨迹点 |
| GET | `/api/orders/:id/tracks` | 获取订单轨迹 |

### 6.7 打卡接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/checkins` | 创建打卡记录 |
| POST | `/api/checkins/upload` | 上传打卡媒体 |
| GET | `/api/orders/:id/checkins` | 获取订单打卡记录 |

### 6.8 管理后台接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/dashboard` | 后台仪表盘 |
| GET | `/api/admin/orders` | 订单管理列表 |
| POST | `/api/admin/orders/:id/assign` | 分配员工 |
| GET | `/api/admin/staff/audits` | 员工审核列表 |
| POST | `/api/admin/staff/:id/audit` | 审核员工 |
| GET | `/api/admin/incidents` | 异常事件列表 |
| POST | `/api/admin/incidents/:id/resolve` | 处理异常 |
| GET | `/api/admin/orders/:id/evidence` | 导出证据链 |

---

## 7. 核心安全设计

### 7.1 门锁密码加密与解密

#### 存储流程

```text
客户端输入门锁密码
  → 获取后端 RSA 公钥
  → 前端 RSA 加密
  → HTTPS 提交密文
  → 后端 RSA 私钥解密
  → 后端 AES-256-GCM 加密
  → 保存 cipher、iv、tag 到数据库
```

#### 读取流程

```text
员工请求门锁密码
  → 校验登录态
  → 校验员工身份
  → 校验订单归属
  → 校验订单状态
  → 校验时间窗口
  → 校验频率限制
  → 记录访问日志
  → AES 解密
  → 返回明文
```

#### 后端伪代码

```ts
function canAccessUnlockCode(order, staffId, now) {
  const windowStart = subMinutes(order.startTime, 30)
  const windowEnd = order.endTime

  return order.staffId === staffId
    && ['assigned', 'in_service'].includes(order.status)
    && now >= windowStart
    && now <= windowEnd
}
```

### 7.2 权限模型

| 角色 | 权限 |
|---|---|
| client | 管理自己的宠物、订单、安防信息，查看自己的服务报告 |
| staff | 查看被分配订单，服务中上报定位、打卡、限时查看密码 |
| admin | 管理订单、员工、财务、异常、证据链 |

关键要求：

- 所有接口必须做服务端鉴权
- 前端仅负责展示，不作为权限判断依据
- 管理员操作必须写审计日志
- 高风险操作需二次确认或二次鉴权

### 7.3 敏感信息保护

敏感信息包括：

- 手机号
- 门锁密码
- 钥匙位置
- 身份证号
- 家庭地址
- 监控位置
- 宠物敏感备注

保护措施：

- 数据库存储加密或脱敏
- API 返回按角色脱敏
- 管理后台默认不展示明文
- 访问敏感信息记录日志
- OSS 文件使用私有读权限与临时签名 URL

### 7.4 风控策略

| 风险 | 策略 |
|---|---|
| 非服务时间查看密码 | 后端拒绝并记录日志 |
| 员工频繁查看密码 | 限流并触发后台告警 |
| GPS 长时间不动 | 后台预警 |
| 打卡位置偏离地址 | 标记异常 |
| 未强制打卡却完成订单 | 拒绝完成 |
| 轨迹中断 | 要求员工补充说明 |
| 图片疑似非实时拍摄 | 使用原生相机 + 后端水印 |

---

## 8. 订单状态机

### 8.1 状态定义

```text
pending_pay：待支付
paid：已支付，待派单
assigned：已分配员工
in_service：服务中
completed：已完成
cancelled：已取消
refunded：已退款
```

### 8.2 状态流转

```text
pending_pay
  → paid
  → assigned
  → in_service
  → completed

pending_pay → cancelled
paid → cancelled / refunded
assigned → cancelled / refunded
in_service → completed / abnormal
```

### 8.3 状态控制规则

- 未支付订单不可派单
- 未派单订单不可开始服务
- 未完成强制打卡不可完成订单
- 已完成订单不可再次上传轨迹
- 已取消订单不可查看门锁密码
- 已退款订单不可进入服务流程

---

## 9. 目录结构建议

```text
my-dog-walking-app/
├── client-mp/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── index/
│   │   │   ├── login/
│   │   │   ├── pet-profile/
│   │   │   ├── order-create/
│   │   │   ├── order-detail/
│   │   │   ├── order-tracking/
│   │   │   ├── service-report/
│   │   │   └── staff-work/
│   │   ├── components/
│   │   │   ├── TrackMap/
│   │   │   ├── CheckinTimeline/
│   │   │   └── CameraCapture/
│   │   ├── stores/
│   │   ├── utils/
│   │   │   ├── request.ts
│   │   │   ├── location.ts
│   │   │   ├── crypto.ts
│   │   │   └── storage.ts
│   │   ├── App.vue
│   │   └── main.ts
│   └── manifest.json
│
├── admin-web/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── dashboard/
│   │   │   ├── orders/
│   │   │   ├── staff-audit/
│   │   │   ├── finance/
│   │   │   └── incidents/
│   │   ├── components/
│   │   ├── router/
│   │   ├── stores/
│   │   └── api/
│   └── package.json
│
├── server-api/
│   ├── src/
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   ├── user/
│   │   │   ├── pet/
│   │   │   ├── order/
│   │   │   ├── payment/
│   │   │   ├── staff/
│   │   │   ├── track/
│   │   │   ├── checkin/
│   │   │   ├── incident/
│   │   │   ├── admin/
│   │   │   └── notification/
│   │   ├── common/
│   │   │   ├── guards/
│   │   │   ├── decorators/
│   │   │   ├── filters/
│   │   │   ├── interceptors/
│   │   │   └── utils/
│   │   │       ├── crypto.util.ts
│   │   │       ├── storage.util.ts
│   │   │       ├── watermark.util.ts
│   │   │       └── geo.util.ts
│   │   ├── config/
│   │   └── main.ts
│   ├── prisma/ 或 migrations/
│   └── package.json
│
└── docs/
    ├── requirement.md
    ├── api.md
    └── database.md
```

---

## 10. 非功能性需求

### 10.1 性能要求

- 常规 API 响应时间 P95 小于 500ms
- 轨迹上报接口支持批量写入
- 轨迹点查询需按订单和时间建立索引
- 图片水印处理走异步队列，避免阻塞主请求
- 进行中订单定位优先写 Redis，再异步落库

### 10.2 可用性要求

- 核心下单、支付、履约接口需要统一异常处理
- 轨迹上报支持离线补传
- 支付回调必须幂等
- 打卡上传失败时允许短时间内重试
- 服务中断时需要员工补充异常说明

### 10.3 安全要求

- 全站 HTTPS
- 密码、证件、地址等敏感字段加密或脱敏
- 管理后台启用 RBAC 权限
- 管理员高风险操作写审计日志
- OSS 文件私有存储，使用临时签名访问
- 支付回调验签
- 接口限流、防刷、防重放

### 10.4 合规要求

- 明确用户隐私协议
- 明确员工服务协议
- 明确上门入户授权条款
- 明确定位采集范围和用途
- 明确照片/视频留存周期
- 支持用户申请删除个人信息

---

## 11. MVP 版本建议

### 11.1 MVP 必做功能

#### 客户端

- 微信登录与手机号绑定
- 宠物档案管理
- 家庭安防信息维护
- 预约下单
- 微信支付
- 订单详情
- 实时轨迹查看
- 打卡时间轴
- 服务报告

#### 员工端

- 员工登录
- 员工认证提交
- 订单任务列表
- 限时查看门锁密码
- GPS 定位上报
- 原生相机打卡
- 完成服务
- SOS 上报

#### 管理后台

- 订单列表与详情
- 手动派单
- 员工审核
- 实时订单监控
- 异常事件查看
- 证据链查看

#### 后端

- 用户鉴权
- 订单管理
- 支付回调
- 加密存储
- 定位上报
- 打卡上传
- 水印生成
- 基础 RBAC

### 11.2 二期功能

- 自动派单
- 智能排班
- 会员卡/次卡
- 优惠券
- 宠物健康档案
- 聊天系统
- 客诉仲裁流程
- 员工评分体系
- 服务复购推荐
- 数据看板

### 11.3 三期功能

- AI 异常轨迹识别
- 宠物行为分析报告
- 智能定价
- 企业客户服务
- 连锁城市运营后台
- 保险自动理赔接口

---

## 12. 开发里程碑建议

### 阶段一：基础框架

- 搭建小程序项目
- 搭建管理后台项目
- 搭建后端 API 项目
- 完成登录鉴权
- 完成基础用户与角色模型

### 阶段二：下单闭环

- 宠物档案
- 家庭安防信息
- 订单试算
- 创建订单
- 微信支付
- 支付回调

### 阶段三：履约闭环

- 员工任务列表
- 限时密码解锁
- GPS 定位上报
- 打卡上传
- 水印生成
- 服务报告

### 阶段四：后台运营

- 订单管理
- 员工审核
- 手动派单
- 实时订单监控
- 异常事件处理

### 阶段五：安全与上线

- 权限加固
- 日志审计
- 接口限流
- 支付验签
- 隐私协议
- 压测与灰度上线

---

## 13. 关键风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 小程序后台定位权限申请难 | 影响实时轨迹 | 提前准备合规说明，必要时降低为前台定位 + 定时打卡 |
| 员工泄露门锁密码 | 家庭安全风险 | 限时展示、日志审计、服务结束失效、截图提示、员工协议约束 |
| 打卡造假 | 信任受损 | 原生相机、后端水印、定位校验、时间校验 |
| 轨迹丢失 | 服务证据不足 | 本地缓存、批量补传、Redis 临时缓存 |
| 支付/退款异常 | 财务风险 | 回调幂等、订单状态机、财务对账 |
| 客诉取证不足 | 仲裁困难 | 统一证据链归档与导出 |
| 宠物突发风险 | 人身/财产风险 | SOS、保险、员工培训、应急流程 |

---

## 14. 验收标准

### 14.1 客户端验收

- 用户可以完成登录、绑定手机号
- 用户可以创建宠物档案
- 用户可以填写家庭安防信息
- 用户可以预约并支付订单
- 用户可以查看服务中轨迹
- 用户可以查看打卡记录和服务报告

### 14.2 员工端验收

- 员工可以提交认证资料
- 审核通过后可以接收订单
- 只有服务窗口内可以查看门锁密码
- 服务中可以持续上报定位
- 可以通过原生相机完成打卡
- 完成服务后无法再次查看密码

### 14.3 管理后台验收

- 管理员可以审核员工
- 管理员可以派单
- 管理员可以查看进行中订单轨迹
- 管理员可以查看异常事件
- 管理员可以导出订单证据链

### 14.4 安全验收

- 数据库不保存门锁明文密码
- 非订单员工无法获取密码
- 非服务时间无法获取密码
- 敏感接口有访问日志
- 支付回调支持重复通知幂等处理
- OSS 私有文件不可被公开访问

---

## 15. 总结

本系统的核心不是简单的“预约遛狗”，而是建立一套可信的上门宠物服务履约体系。设计重点应放在：

1. 订单履约过程可视化
2. 家庭隐私与门锁密码安全
3. 员工服务动作标准化
4. 异常事件快速响应
5. 客诉证据链完整留存
6. 支付、结算、保险等商业闭环

MVP 阶段建议优先完成“客户下单 → 员工履约 → GPS/打卡 → 服务报告 → 后台监管”的完整闭环，再逐步扩展自动派单、会员体系、智能风控和精细化运营能力。
