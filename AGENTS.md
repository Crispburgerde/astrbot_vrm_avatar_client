# AGENTS.md

## 项目文档

- **[SPEC.md](./SPEC.md)** 是本项目的技术规格（架构分层、WebSocket 协议、各模块目的/功能/实现、关键设计决策）。在做任何代码改动前先阅读它，并遵循其中的架构约定与设计决策。
- 改动影响协议（消息结构、performance 事件语义）或核心机制（动画四层、Offset 节点叠加）时，同步更新 SPEC.md。

## 技术栈约定

- Vue 3 `<script setup>` + TypeScript；路径别名 `@` = `src/`
- 3D：three.js + @pixiv/three-vrm(-animation)；口型：wLipSync
- 类型检查：`npm run check`（vue-tsc），提交前需通过
