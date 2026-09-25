# Agent Note: 为 FI Desktop 配置独立 Harness home

Status: implemented

[English](2026-09-15-fi-desktop-data-home.md) | 中文

## 问题

FI Desktop 与 CLI dsh 可以在同一个默认 `.fi` home 下启动不同进程。仍在运行的 CLI writer 可能持有会话锁，使 Desktop 无法恢复该会话，也无法更改模型或 agent preset。共享整个 home 还会让 Desktop 启动依赖 CLI 持有的设置、凭据和插件 profile 数据。

## 决策

FI Desktop 在访问 profile 或启动 Host 前解析一个 Harness home。没有非空 `DSH_HOME` 时，home 为 `<Electron userData>/harness`；在 macOS 上，FI 应用的正常路径为 `~/Library/Application Support/fi/harness`。Electron 将解析后的绝对 home 用于 profile 操作，并作为 `DSH_HOME` 传给内置 Host 进程。上游 dsh 保留现有 home 路径解析方式；会话、存储、设置、凭据、附件和 preset 的路径都相对于该 home。

非空 `DSH_HOME` 仍可显式选择已有 home。FI 不复制、移动、删除 CLI home 中的数据，也不回退读取这些数据。因此，FI home 首次启动时没有 CLI 的会话历史或配置。开发启动器保留一次性的 `DSH_HOME`，除非显式覆盖。

[Electron 打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)继续负责保留 profile、可执行包、更新身份和包管理器状态。本决策只取代其中默认共享数据根目录的假设。

## 考虑过的替代方案

**只重定向会话。** 其他持久化服务和 Desktop profile 仍使用 CLI home，两个进程也不再使用同一个 Harness home。这需要在上游包中增加 FI 专用路径修改。

**自动导入 CLI 数据。** 现有会话、设置、凭据和插件状态可能不兼容，或仍由另一个 writer 持有。干净的 FI home 避免未经请求的迁移，并完整保留 CLI 数据。

**保留默认共享。** 会话锁能阻止并发 writer，但 CLI 进程持有同一会话时，Desktop 的普通操作会失败。用户需要共享时仍可通过 `DSH_HOME` 显式选择。

## 结果

- 默认情况下，FI 与 CLI 进程不会争用同一会话锁或存储文件。
- Desktop 与 Host 使用同一个解析后的 home；上游相对于 home 的路径保持不变。
- 现有 CLI 历史留在原 home，在干净的 FI home 中不可见。
- 显式共享 `DSH_HOME` 时仍受上游格式版本和锁保护；另一个 writer 活跃时仍可能出现会话归属错误。
- 在使用本源码构建的 FI 启动前，当前运行的应用和所有现有数据保持不变。
