# Agent Note: 英语优先的语言排序

Status: implemented

[English](2026-09-10-english-first-locale-order.md) | 中文

## 问题

fi 以英语作为首要语言：服务的标记声明 `en`，所有词典回退链都以 `FALLBACK_LOCALE`（`en`）终结，文档以英语为正本，CLI、desktop host 与网站仅有英语。但设置的 Language 行仍把 中文 排在首位，因为 `LOCALE_IDS` 中 `zh` 先于 `en`，而 shipped catalog 的顺序经 `snapshot.locales` 直接进入该行的选项列表。唯一没有把英语放在首位的地方，恰恰是用户选择语言的界面。

## 决策

`packages/client/locale/src/locale-settings.ts` 中的 `LOCALE_IDS` 改为 `['en', 'zh']`。shipped catalog、locale 快照与 Language 行的显示顺序都派生自该常量，因此英语排在首位，中文 次之。其余一切不变：浏览器推导的初始语言、`en` 回退终结点、词典注册与完整的 `zh` 翻译都保持原状。中文浏览器或系统仍以中文打开，显式的 Host 偏好也一如既往地生效。

## 备选方案

**删除 `zh` 词典。** `scripts/locale-dictionary-parity.spec.ts` 要求 `zh`/`en` 键集对称，注册强制双语平衡，文档门禁强制 README 配对。移除中文会破坏所有门禁，并让与 upstream 的合并在上百个文件中必然冲突。

**无视浏览器、强制默认英语。** 这会推翻 upstream 已成文的浏览器推导初始语言决策及其 e2e 固定用例，在没有产品理由的情况下改变中文用户的行为。fi 跟随系统语言；英语的首要性体现在排序、回退与文档，而不是覆盖读者自己的浏览器声明。

**按标签排序 Language 行。** 显示顺序属于 shipped catalog 声明（`LOCALE_IDS`），而不是行内排序；排序还会改变外部语言包按自身注册顺序作出的贡献。

## 后果

Language 行英语排首位；`snapshot.locales` 对所有消费者都是 en 优先。不存在对 catalog 的位置索引，因此随常量一起改动的只有固定该顺序的四行测试。与 upstream 的合并只触及一行源码及其注释。
