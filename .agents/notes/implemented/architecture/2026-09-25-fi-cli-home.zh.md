# Agent Note: fi CLI 与 Web 的默认 home

Status: implemented

[English](2026-09-25-fi-cli-home.md) | 中文

## 问题

fi 的 CLI 与 Web profile 默认从 `~/.dsh` 加载 DeepSeek Harness 用户数据，即共享的上游 harness home。fi Desktop 已经解析出自己的独立 home（参见[为 FI Desktop 配置独立 Harness home](2026-09-15-fi-desktop-data-home.zh.md)），但 fi 的非 Desktop 界面仍从 harness 自身的根目录加载，这会把 fi 的状态与同一台机器上任何其他 DeepSeek Harness 安装混在一起，也让 fi 的身份识别（参见[fi 产品身份](../feature/2026-09-10-fi-product-identity.zh.md)）在文件系统这一层留有缺口。

## 决策

fi 的默认 harness home 是 `~/.fi`，这一改动只在 `@deepseek-ai/dsh-home-paths` 的 `DSH_HOME_DIR_NAME` 处设置一次——它是唯一的解析器，每一条以 home 为基准的路径（会话、设置、凭据、profile、skill、附件缓存、匿名遥测 id）都由它派生。此前在这个解析器之外手动推导默认值的每一处调用方（例如历史 Sessions 迁移脚本）现在都改为调用这个共享解析器，而不是自己拼接 `.dsh`。非空 `DSH_HOME` 仍以最高优先级覆盖默认值，这与[单一解析器决策](2026-07-24-single-harness-home-resolver.zh.md)保持一致；本次改动没有引入新的环境变量，`DSH_HOME`、以 `$DSH_HOME` 为基准的路径，以及其他每一个 `DSH_*` 标识符都保留原名，与产品身份决策已经划定的兼容边界一致。

fi Desktop 独立的 `<Electron userData>/harness` home 不受影响：Desktop 在落到共享解析器之前，总会先提供自己解析好的 home 作为显式覆盖值，因此永远不会走到改动后的默认值。

CLI 自己的 `web` profile 模板现在会在两个上游 bundle 之后加入 fi 的 `@fi/authorization-bundle`，顺序与 Desktop 已经使用的 bundle 顺序一致，因此 `dsh --profile web` 启动时默认会加载 fi 的登录与模型授权界面，而不再只加载上游的 web app。把安装方拥有的 bundle 元组升级为当前出厂模板的 profile 规范化机制新增了一个 `web` 条目，记录此前的两 bundle 元组，因此一个已初始化、且其 bundle 仍与旧上游元组完全一致的 `web` profile，会在下次加载时升级为新的三 bundle 模板；已经偏离该精确元组的 profile 则保持不变。`apps/cli` 直接依赖 `@fi/authorization-bundle`（使用 workspace 协议），这样该 bundle 就能从 CLI 自身的安装锚点解析，与 bundle 解析本就先看安装锚点、再看 profile 目录的顺序一致。

现有 `~/.dsh` 数据不会自动复制或迁移到 `~/.fi`：想在新默认值下继续使用旧 CLI 历史的人，需要显式设置 `DSH_HOME=~/.dsh`。

## 考虑过的替代方案

**共享 Desktop 的独立 home。** Desktop 的 home 以 Electron 的 userData 为基准，对没有 Electron 运行时的 CLI 进程没有意义；复用它就需要为 CLI 侧发明一个替代路径，却拿不到 Desktop 那个隔离保证本身——而 Desktop 拥有这个 home 边界是出于另一个原因（两个长期运行的 UI 进程之间的会话锁争用），并非 CLI/Web 的产品身份问题。

**让 Desktop 也用 `~/.fi`，退役它自己的 Electron-userData home。** Desktop 使用独立 home 正是为了避免并发的 Desktop 与 CLI writer 争用会话锁。让 Desktop 回退到 CLI 现在默认使用的同一个根目录，只是换了个名字的共享目录，会重新引入那种争用。

**保留 `~/.dsh`，只在面向用户的显示字符串中改名。** 不改动 `DSH_HOME_DIR_NAME` 的表面改名，会让 fi 自己的 CLI 与 Web 会话、设置和凭据仍然物理存放在一个以上游项目命名的目录下，使 fi 已经在其他每一个用户可见界面上承诺的产品身份，在文件系统这一层仍不完整。

## 结果

- 未设置 `DSH_HOME` 时，全新的 fi CLI 或 Web 安装会创建并读取 `~/.fi`，而不是 `~/.dsh`；每一条以 home 为基准的路径（会话、设置、凭据、profile、插件、附件缓存、匿名遥测 id）都随之迁移。
- 现有 `~/.dsh` 安装保持不变，默认不可见；设置 `DSH_HOME=~/.dsh` 即可完整访问那些数据，无需任何格式转换或迁移步骤。
- fi Desktop 的 home 不受影响：因为它总会提供自己的显式覆盖值，永远不会读取改动后的默认值。
- `dsh --profile web` 启动现在要求能从 CLI 自身的安装中解析出 `@fi/authorization-bundle`；一个在本次改动前初始化、且从未偏离上游两 bundle 元组的 `web` profile，会在下次加载时升级为三 bundle 模板。
- 之前在 `@deepseek-ai/dsh-home-paths` 之外手动推导旧默认值的每一处都已被找到，现在都改为调用共享解析器，因此以后再改默认值时，每个调用方只有一处需要修改，而不必重新审查整棵代码树。
