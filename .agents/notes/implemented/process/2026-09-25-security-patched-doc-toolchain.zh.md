# Agent Note: 文档工具链的安全补丁版本

Status: implemented

[English](2026-09-25-security-patched-doc-toolchain.md) | 中文

## 问题

文档工具链解析到的 Mermaid、DOMPurify 和 Browserslist 版本存在已公开的安全公告。全局 override 会影响文档构建之外的无关应用，也可能隐藏兼容性失败。

## 决策

根目录和网站使用 Mermaid 11.16.1，这是解决 [Mermaid 漏洞](https://github.com/advisories/GHSA-c4c3-pg64-4m4v) 和 [Mermaid 架构漏洞](https://github.com/advisories/GHSA-3rrr-jr9j-h3q3) 的首个补丁版本。workspace override 将所有传递性 DOMPurify 和 Browserslist 实例强制到 3.4.13 和 4.28.7，对应 [DOMPurify 漏洞](https://github.com/advisories/GHSA-55q2-fjhq-7xh7) 和 [Browserslist 漏洞](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) 所标注的首个补丁版本。网站自身的 Vite 依赖从 `^5.4.14` 范围调整为精确的 `6.4.3`，配套的 `vitepress@1.6.4>vite` workspace override 仅将 VitePress 声明的 Vite 5 peer 收窄到该版本；VitePress 1.6.4 尚未扩大其 peer 范围。Vite 6 迁移仅针对网站的静态构建和开发服务器进行了审阅；其他包不受此 Vite override 影响。lockfile 由 pnpm 刷新，不手工编辑。

## 备选方案

- **使用全局 Vite override。** 否决：会改变网站以外的应用和测试 bundler。
- **迁移到 VitePress 2 prerelease。** 否决：稳定的 VitePress 1 线已经足够完成此次补丁，不值得进行文档框架迁移。
- **运行全量 audit fix。** 否决：可能引入未审查的 major 版本，并绕过受影响依赖路径的审阅。

## 后果

网站现在需要针对 Vite 6 的构建和开发服务器 smoke coverage。VitePress 扩大稳定 peer 范围前保留这个窄 override；后续依赖刷新必须重新检查上述 advisory 和网站 smoke 路径。
