# JiraStoryCounter

在 Jira 列表中自动统计 `Story Point` 列的总和，并将结果显示到表头中。

## 功能

- 扫描页面中的 `Story Point` 单元格。
- 按表格分别汇总当前列表中的故事点。
- 将汇总结果显示为 `Story Point (总数)`。

## 适用页面

- 匹配规则：`https://*/jira/*`

## 文件

- 脚本文件：`JiraStoryCounter.js`
- 图标资源：`jira-software_logo.png`
- 辅助图片：`story.svg`

## 安装方式

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)。
2. 新建一个用户脚本。
3. 复制 `JiraStoryCounter.js` 的内容并保存。
4. 打开 Jira 列表页面确认表头统计是否显示。

## 说明

- 当前实现通过定时扫描页面内容完成统计。
- 如果 Jira 自定义字段 ID 或页面结构发生变化，脚本可能需要同步调整。