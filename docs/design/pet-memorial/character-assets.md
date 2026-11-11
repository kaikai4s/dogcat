# 纪念园人物动作素材制作规格

状态：用户明确要求重新生成，否决移植双手和局部调色。第九版重新调用 `gpt-image-2.6-sunburst` 生成完整八帧行走，预览图集与模型输出逐字节一致，只做切帧。待机保留第五版已认可素材。见 `characters-v9/` 与 `output/imagegen/pet-memorial-sunburst-v9/`；新行走待用户审阅，当前仅男角色左前方，尚未接入正式园区。

## 原图

- 男角色：`source/character-boy-reference.png`，1536 × 1536，RGB。
- 女角色：`source/character-girl-reference.png`，1536 × 1536，RGB。
- 两图均没有 Alpha 通道。男角色背景中的棋盘格是图像内容，女角色的浅色背景也不是透明背景，不能直接作为透明精灵使用。
- 保留金发、无五官的发光面部、金白色服装、披风、飘带、原有身体比例与柔和微光。男角色短发、宽松裤装；女角色长发、贴身衣装。

## 动作与方向

先制作两位角色的四方向待机、行走，每个方向每种动作 12 帧，共 16 张图集、192 帧。快跑作为后续动作；若园区复用现有跑步输入，必须先补齐跑步或明确关闭园区的跑步切换。

| 方向键 | 屏幕朝向 | 可见身体 |
| --- | --- | --- |
| sw | 左下 | 正面三分之四 |
| se | 右下 | 正面三分之四 |
| nw | 左上 | 背面三分之四 |
| ne | 右上 | 背面三分之四 |

背面需要独立制作。左右方向优先独立制作；使用镜像前须核对发型、披风扣、飘带等不对称细节。现有场景的方向命名可以沿用，视角仍需对照纪念园背景校准。

- 待机：呼吸、披风与头发轻摆；双脚保持落地，身体不能整体漂移。
- 行走：原地步态，左右腿交替，手臂反向摆动，披风有轻微滞后；第 12 帧自然衔接第 1 帧，不重复首帧。
- 先完成一位角色一个方向的行走验证，再扩展全套。鞠躬、献花等互动动作待交互确定后制作。

## 文件规格

- 原始单帧：512 × 512 RGBA PNG。
- 运行单帧：256 × 256 RGBA PNG。
- 图集：4 列 × 3 行，按行读取，运行图集尺寸 1024 × 768。
- 文件名：`{boy|girl}/{idle|walk}-{sw|se|nw|ne}.png`。
- 统一地面锚点：原始单帧 `(256, 460)`；运行单帧 `(128, 230)`。整套使用统一比例与基准，禁止逐帧独立缩放造成大小抖动。
- 待机建议 8 fps；行走预览 12 fps，实际移动按行走距离驱动动画相位。
- 光晕保留柔和半透明边缘，不能烘焙白色背景或棋盘格。地面阴影独立绘制，避免不同地面上出现白色光斑贴片。
- 图集从规范单帧确定性拼合；生成结果若边界不齐，必须先提取和校准，不能直接等分后视为合格。
- 最终生成文件与现有庄园角色分开保存；只有经过验收的文件才接入纪念园角色配置。

## 生成提示词模板

每次仅附上对应角色原图，并替换角色、朝向和动作变量。此提示词尚未执行。

```text
Use case: identity-preserve
Asset type: animated character sprite for a pet memorial garden, Canvas2D game.
Input image: the supplied {boy|girl} reference is the character identity and costume reference.
Primary request: create a coherent 12-frame {idle|walk} cycle facing {direction}.
Preserve: the exact hairstyle, faceless luminous face, body proportions, golden-white clothing,
cape, clasp, ribbons and soft golden rim light from the reference. No facial features.
Camera: fixed elevated three-quarter game camera, consistent across all frames.
Composition: 4 columns by 3 rows, 12 equal square cells, chronological row-major order.
Show the complete character in every cell at the same scale and ground anchor.
Motion: {motion_description}. Stationary in world space. Seamless cycle, no duplicate last frame.
Backdrop: genuinely transparent alpha, including between limbs; no checkerboard or white matte.
Constraints: no text, labels, borders, extra characters, scenery or baked ground shadows.
Keep hair, feet, cape and ribbon tips inside each cell. Back views must show the back of the
head and cape, not a flipped front view. No body deformation or costume changes between frames.
```

朝向变量：`screen lower-left, front three-quarter` / `screen lower-right, front three-quarter` /
`screen upper-left, rear three-quarter` / `screen upper-right, rear three-quarter`。

待机动作变量：`Subtle breathing with gentle hair and cape sway, both feet planted`。

行走动作变量：`One complete natural walking cycle with alternating left and right foot contacts,
opposing arm swing, weight transfer and gentle delayed cape motion`。

## 验收与交付

1. 验证 PNG 有真实透明像素；浅色、深色及草坪背景下均无棋盘格、白边或脏边。
2. 检查帧数、排列、边界及脚底基准；全部帧不裁切，不串入邻格。
3. 逐帧核对身份、服装、肢体、四方向与前后遮挡关系。
4. 循环预览检查左右脚交替、支撑脚、披风连续性与首尾衔接；不能仅凭帧不同就判定合格。
5. 合成到纪念园背景，在实际显示大小检查可辨识度和光晕强度。
6. 交付独立帧、运行图集、帧参数、动作 GIF 与场景预览，并记录实际生成方式。

## 历史试制说明

旧 `characters/` 和 `output/imagegen/pet-memorial/` 保留了早期 GPT 方向底图和程序变形动画，用户已否决其视觉效果。技术校验通过不代表动作自然；这些文件、预览与压缩包均不得作为正式交付。`scripts/assets/animate-memorial-characters.py` 仅用于复现历史试制。

Gemini 试制记录见 `gemini-trials/review.json`；Grok 试制记录见 `output/imagegen/pet-memorial-grok/review.json`。当前重新使用用户指定的 `gpt-image-2.6-sunburst`，姿势图只作模型参考，不作为最终人物动作。
