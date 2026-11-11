# Gemini 人物动作试制记录

状态：未通过动作验收，完整步态尚未完成。

用户指定 Gemini 3.1 Flash Image，平台公开模型列表对应的调用名称为 `nano-banana-2`。请求通过该平台 `/v1/images/edits` 完成；响应没有可独立验证的底层模型标识。

先后验证了整组 8 帧生成、独立关键姿势、外观与骨架合并参考、去除旧四肢后重绘、灰色体块姿势参考、整组姿势重绘。候选图仍存在重复腿部接触姿势、反向摆臂不符合要求、独立帧服装漂移等问题。没有将重复姿势拼成动画或回到被否决的程序拉伸方案。

参考骨架与体块是本地制作的模型输入，最终候选人物由指定平台模型生成。原始返回图片保存在项目 `output/imagegen/pet-memorial-gemini/raw/`；提示词及本轮审查结果保存在本目录。

当前令牌调用 Gemini 原生 `/v1beta/models/nano-banana-2:generateContent` 返回 HTTP 403，消息为：

> This group only permits image generation and editing. Use /v1/images/generations or /v1/images/edits.

如后续改用原生 Gemini 多轮编辑继续验证，需要平台提供允许该接口且支持目标模型的令牌/分组。更换接口不保证动作质量，仍需逐姿势和循环视觉验收。
