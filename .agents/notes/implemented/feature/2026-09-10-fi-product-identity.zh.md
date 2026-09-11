# Agent Note: fi 产品身份

Status: implemented

[English](2026-09-10-fi-product-identity.md) | 中文

## 问题

官方构建曾暴露多种互不一致的产品身份：桌面打包与恢复窗口使用 DeepSeek Harness 名称，浏览器外观与安装元数据使用 DSH 品牌，浏览器 UI 则渲染鱼形图稿。只替换一个位置会让已安装应用、新会话呈现与更新产物继续不一致。

## 决策

官方产品名称为 `fi`。官方客户端构建环境提供这一浏览器标题，`dsh-client-ui-brand-official` 用自带 fi 字样的图稿填充侧栏和会话首屏 slot，Web manifest、favicon 与无框架启动页使用同一图稿。侧栏在图稿下方显示完整构建元数据，并抑制重复的相邻 fi 文本。首次运行通知也使用 fi 名称。

桌面打包使用 `fi` 作为产品、可执行文件、应用 bundle 与产物文件名。其 PNG 与 ICNS 文件源自 `apps/desktop/build/fi-logo-source.png`，浏览器则使用 `apps/web/public/fi-logo.png` 中适合其尺寸的副本。`apps/desktop/build/fi-logo-dark-background.png` 是用于深色界面的透明品牌版本；它保留青色与紫色强调色，并把源图稿中的深色填充替换为白色。

在 macOS 上，主 BrowserWindow 使用 Electron 的 `hiddenInset` 标题栏样式，并把原生红黄绿按钮放在 20px 可拖动应用行内。AppFrame 让侧边栏填充延伸到这些按钮下方，并让主区背景覆盖该行其余部分。启动文档在应用渲染进程加载前提供相同的可拖动高度；辅助窗口保留标准原生外观。

桌面应用 ID 是源码拥有的 `com.fi.app`，发布环境无法替换它。生产包写入 electron-builder 的 GitHub provider，并由源码明确固定仓库 `OJamals/fi`。已发布的 GitHub release 是官方更新来源；preview 安装跟随已发布的 preview prerelease，稳定安装跟随已发布的稳定 release，草稿则不可见。测试包保留独立的通用 HTTPS 更新流与 COS 上传路径。fi 预发布版本依次使用公开标签 `fi Preview 01`、`fi Preview 02` 等，并对应 package 版本 `0.1.0-preview.1`、`0.1.0-preview.2` 等。首个公开 fi 预发布版本使用 release 标题 `fi Preview 01` 与 electron-builder 的 `preview` 更新频道。它仅发布已签名并公证的 macOS arm64 产物，更新元数据也只引用该架构。

其他兼容性与来源标识保持不变。`dsh` 命令、`$DSH_HOME`、其余 `DSH_*` 环境变量、`@deepseek-ai/dsh-*` 包名、SDK wire 身份，以及对底层 DeepSeek Harness 实现的引用均保留现有值。包仓库元数据指向 fi 仓库，许可证与根文档保留上游来源说明。

## 考虑过的替代方案

**重命名所有 DSH 与 DeepSeek Harness 标识。** 这种做法会破坏包解析、profile、存储路径、自动化与 wire 使用方，却不能改善面向用户的产品身份。应用 ID 不同：它标识已安装的 fi 应用，因此归 fi 所有。

**只替换桌面打包。** 这种做法会让浏览器标题、安装元数据、侧栏、会话首屏与引导通知继续在名为 fi 的应用中呈现旧品牌。

## 后果

用户会在启动页、已安装应用外观和官方浏览器 UI 中看到统一的 fi 身份。macOS 原生控件属于应用界面，而不是单独的标题栏。品牌变更必须更新签入的源图稿，并一起重新生成桌面与 Web 衍生文件。安装与更新元数据使用 `com.fi.app`；首批公开产物使用 package 版本 `0.1.0-preview.1` 与公开版本 `fi Preview 01`。内部工具和外部集成继续使用稳定的 DSH 标识。
