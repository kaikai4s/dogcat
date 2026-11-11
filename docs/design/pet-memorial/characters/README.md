# 宠物纪念园人物素材 · 第一版

两位角色 × 四个朝向 × 待机/行走，每组 12 帧，共 16 张图集、192 帧。

## 使用

- `runtime/{boy|girl}/{idle|walk}-{sw|se|nw|ne}.png`：1024×768 RGBA，4 列 3 行，逐行播放。
- `frames-256/`：256×256 独立运行帧；`frames-512/`：512×512 独立母版帧。
- `masters/`：2048×1536 母版图集。
- 锚点：运行帧 `(128,230)`，母版 `(256,460)`。绘制时不再按每帧透明边界裁紧或重新居中。
- 待机 8 fps；行走 12 fps。走路时建议按实际移动距离推进相位，停止时切换同朝向待机。
- `sw/se/nw/ne`：屏幕左前、右前、左后、右后；八张方向底图分别保存，无需运行时镜像。
- `preview.html`：浏览器交互预览，支持人物、动作、朝向切换、暂停和逐帧检查。
- `previews/`：GIF 与逐帧联系表。
- `verification.json`：192 帧结构检查结果；不代表已完成小程序真机验收。

## 制作记录与限制

使用用户提供的男女角色图，通过 imagegen CLI 请求平台模型 `gpt-image-2.6-sunburst` 制作四方向底图；模型 ID 是请求值，第三方平台内部模型映射未独立验证。提示词保存在 `prompts/boy-turnaround.txt` 与 `prompts/girl-turnaround.txt`。

模型直接生成的 12 帧及 4 关键姿势样片存在重复单腿步态，未采用。最终动作由四方向底图做确定性的栅格分层动画，包含双腿交替、身体起伏和披风轻摆；并非模型逐帧重绘，也不是完整三维骨骼动画。大幅转身、奔跑、鞠躬、献花尚未制作，当前步态应在园区真实移动速度下继续调校。

已在独立 Canvas 预览中检查草坪合成与四方向显示，尚未接入正式纪念园页面。原始生成图返回尺寸与请求尺寸不同，交付文件均经过重新对齐和规范化。

## 重建

使用 Python 3.12 与 Pillow、NumPy。项目脚本：

```bash
/home/ebrook-dev/.local/share/dogcat/imagegen-venv/bin/python scripts/assets/animate-memorial-characters.py --root output/imagegen/pet-memorial
/home/ebrook-dev/.local/share/dogcat/imagegen-venv/bin/python scripts/assets/verify-memorial-characters.py --root output/imagegen/pet-memorial
```

重建只读取 `raw/boy-turnaround.png`、`raw/girl-turnaround.png`，不调用 API。密钥未写入素材或项目。
