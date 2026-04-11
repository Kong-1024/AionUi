# ACP Layer Rewrite

> Status: Planning
> Date: 2026-04-11

## Overview

AionUi 的 ACP（Agent Client Protocol）实现存在架构层面的问题。通过分析 [acpx](https://github.com/openclaw/acpx)（OpenClaw 官方 ACP 客户端工具）的实现，我们发现其在协议层设计上有大量值得借鉴的地方。本文档描述当前问题、acpx 的参考价值、以及渐进式重构方案。

## Documents

- [01-current-problems.md](./01-current-problems.md) — AionUi ACP 层现状问题分析
- [02-acpx-reference.md](./02-acpx-reference.md) — acpx 实现分析与可复用模块
- [03-refactor-plan.md](./03-refactor-plan.md) — 重构路线与实施方案
