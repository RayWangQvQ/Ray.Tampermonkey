# Ray.Tampermonkey

一个 Tampermonkey 用户脚本的仓库。每个子目录对应一个单独项目，脚本彼此独立、可单独安装使用。

## 项目列表

| 项目 | 说明 | 文档 |
| --- | --- | --- |
| `BilibiliDoubanRatingHelper` | 在 Bilibili 影视相关页面补充展示豆瓣评分 | [README](./BilibiliDoubanRatingHelper/README.md) |
| `JiraStoryCounter` | 在 Jira 列表中汇总 Story Point 列 | [README](./JiraStoryCounter/README.md) |
| `JiraTableCounter` | 在 Jira 二维表格中汇总数字列并显示到表头 | [README](./JiraTableCounter/README.md) |

## 使用方式

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/) 或 [scriptcat](https://github.com/scriptscat/scriptcat)。
2. 进入对应子项目目录。
3. 阅读该目录下的 `README.md` 了解脚本作用、适用页面和安装方式。
4. 将对应的 `.js` 脚本导入 Tampermonkey 后启用。

## 目录结构

```text
.
├─ BilibiliDoubanRatingHelper/
├─ JiraStoryCounter/
└─ JiraTableCounter/
```

## 说明

- 仓库中的每个脚本默认保持自包含。
- 如脚本行为有调整，应优先查看对应子目录下的文档。
- 若后续新增脚本，建议同步补充子项目 `README`，并在本页增加索引。
