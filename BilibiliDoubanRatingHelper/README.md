# BilibiliDoubanRatingHelper

为 Bilibili 影视相关页面补充展示豆瓣评分，支持详情页、列表页封面角标、侧边列表以及搜索结果中的高置信度官方影视条目。

![MovieList](https://github.com/RayWangQvQ/Ray.Tampermonkey/BilibiliDoubanRatingHelper/MovieList.png)

## 功能

- 在 Bilibili 番剧 / 电影详情页展示豆瓣评分。
- 在影视列表页卡片上补充评分角标。
- 在侧边推荐区域展示评分信息。
- 在搜索结果中，仅对高置信度官方影视结果补充评分。

## 支持页面

- `https://www.bilibili.com/movie*`
- `https://www.bilibili.com/bangumi/play/*`
- `https://search.bilibili.com/bangumi*`
- `https://search.bilibili.com/pgc*`

## 搜索页规则

搜索页仅为高置信度的官方影视 / 番剧结果请求豆瓣评分，例如：

- 链接指向 `/bangumi/play/ss...` 或 `/bangumi/play/ep...`
- 页面中带有 `电影`、`番剧`、`国创` 等官方媒体信号
- 或存在 `立即观看`、`全片`、`全xx话`、`xx人评分` 等元信息

以下普通用户投稿视频不会触发豆瓣评分查询：

- `/video/BV...` 类视频
- 影评、解说、剪辑、混剪、搬运合集等普通稿件

## 文件

- 脚本文件：`bilibili-douban-rating-helper.js`

## 安装方式

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/) 或 [scriptcat](https://github.com/scriptscat/scriptcat)。。
2. 新建一个用户脚本。
3. 复制 `bilibili-douban-rating-helper.js` 的内容并保存。
4. 打开支持的 Bilibili 页面进行验证。

## 说明

- 脚本会访问豆瓣相关页面以获取评分数据。
- 已包含缓存、节流与错误缓存策略，用于减少重复请求。
- 若 Bilibili 或豆瓣页面结构变化，脚本可能需要调整。