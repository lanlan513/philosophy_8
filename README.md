# 箴言显影机 · Aphorism Darkroom

拖动一枚黄铜滑块选择情绪——不安、清醒、孤独、勇气、平静——
暗房便从本地哲学资料中显影一段箴言：文字先浮现，人物与年代随后抵达，
图像如相纸在显影液中慢慢成像。每次显影可收藏，或导出为一张竖版思想卡片。

## 运行

```bash
node tools/make-images.js   # 首次：生成五张情绪颗粒图像（已生成可跳过）
npm start                   # http://localhost:3000
npm test                    # 冒烟测试（25 项，独立端口，不影响运行中的服务）
```

零外部依赖，Node ≥ 18 即可。

## 结构

```
content/v1/quotes.json   版本化内容库（条目可带 notBefore / notAfter 日期窗）
server/
  index.js               HTTP 服务：API + 静态资源
  content.js             内容加载、情绪校验、按日过滤、随机抽取（支持 exclude）
  store.js               JSON 原子写入；收藏 (clientId,quoteId) 去重、记录按 id 幂等
public/
  index.html / styles.css / app.js
  grain.js               Canvas 胶片颗粒（不可用时降级为纯渐变）
  card.js                竖版思想卡片生成（8s 超时、长文缩字号、图片损坏降级）
  assets/moods/*.png     本地生成的颗粒情绪图
tools/
  make-images.js         纯 Node PNG 编码器，烘焙颗粒
  smoke-test.js          冒烟测试
data/                    运行时生成：favorites.json / records.json
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/develop?emotion=<e>&exclude=<id,id>` | 显影一条；未知情绪 `400 UNKNOWN_EMOTION`，当日无内容 `404 NO_CONTENT_TODAY` |
| POST | `/api/favorites` | 保存收藏；重复 `(clientId, quoteId)` → `409 DUPLICATE` |
| GET | `/api/favorites?clientId=<id>` | 读取收藏 |
| POST | `/api/records` | 保存显影记录；重复 `id` → `409 DUPLICATE` |

内容版本通过 `X-Content-Version` 响应头与响应体 `version` 字段暴露，
切换 `CONTENT_VERSION=v2` 即可启用新版本内容目录。

## 边界处理一览

- **当天无可用内容**：条目日期窗过滤后为空 → 404，前端显示温和的空态文案
- **随机重复**：前端按情绪记录上次条目并传 `exclude`；池仅 1 条时明示用户
- **拖动过快**：拖动停稳 380ms 后才请求；进行中请求用 AbortController 取消
- **图片损坏**：`img.onerror` → 隐藏图片，退回情绪渐变；卡片生成同样降级
- **保存时断网**：收藏写入 localStorage 暂存队列，`online` 事件后自动同步
- **减少动态效果**：`prefers-reduced-motion` 下逐字动画、颗粒动画、过渡全部静止
- **卡片生成超时**：8 秒 `Promise.race` 超时，提示重试；图片加载 5 秒兜底
- **移动端长文本**：`overflow-wrap:anywhere` + 行数截断；卡片端自动缩字号 + 省略号
- **Canvas 不可用**：`grain.js` 检测失败 → `no-canvas` 类，纯文字 + 渐变背景
- **重复写入**：收藏 409、记录幂等 409，前端双击/重试安全
