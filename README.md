# 云开发 quickstart

这是云开发的快速启动指引，其中演示了如何上手使用云开发的三大基础能力：

- 数据库：一个既可在小程序前端操作，也能在云函数中读写的 JSON 文档型数据库
- 文件存储：在小程序前端直接上传/下载云端文件，在云开发控制台可视化管理
- 云函数：在云端运行的代码，微信私有协议天然鉴权，开发者只需编写业务逻辑代码

## 参考文档

- [云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)

## 本地维护与验收

安装根目录依赖后运行 `npm test`；资源检查运行 `npm run check:icons`，本地源码体积/服务装配耗时运行 `npm run benchmark:local`。字体重新生成运行 `npm run optimize:icons`，需 Python 的 FontTools 与 Brotli。

历史资金快照检查：`npm run audit:finance -- snapshot.json`。账单核对及日汇总：`npm run reconcile:finance -- snapshot.json statement.json [costs.json]`，工具只读本地 JSON，不连接云端。

- [本地结果与发布前验收](LOCAL_ACCEPTANCE.md)
- [架构和维护边界](cloudfunctions/api/ARCHITECTURE.md)
- [优化进展](REMAINING_OPTIMIZATION_PLAN.md)

