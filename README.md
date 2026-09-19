# 箴言显影机 · The Aphorism Darkroom

拖动一枚黄铜滑块选择情绪——不安、清醒、孤独、勇气、平静——页面便从本地哲学资料中
调出一段短引文、一位哲学家、一张颗粒底片和一句不替用户下结论的回应。每次显影像
暗房里的相纸：文字先浮出，人物与年代随后抵达。结果可以保存为一张竖版思想卡片。

零外部依赖：Node 原生 `http` 后端 + 纯 HTML/CSS/Canvas 前端。

## 运行

```bash
npm start          # 默认 http://localhost:8787，PORT 环境变量可改
npm test           # node:test 接口与边界测试（13 项）
```

## 结构

```
server/index.js    HTTP 服务：REST API + 静态资源
server/content.js  内容库：版本校验、可用窗口过滤、去重抽取
server/store.js    收藏与显影记录：原子写入、幂等去重
content/           版本化内容（aphorisms.v1.json，version 字段随响应下发）
public/            前端（index.html / styles.css / app.js / images/*.svg）
data/              运行时数据（favorites.json / generations.json，自动创建）
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/develop?mood=&exclude=` | 按情绪显影；未知情绪 `400 UNKNOWN_MOOD`；当日无内容返回 `{empty:true}` |
| POST | `/api/favorites` | 保存收藏；重复写入 `409 DUPLICATE`；内容不存在 `404` |
| GET | `/api/favorites?clientId=` | 读取收藏（含服务端生成的内容快照与版本号） |
| POST | `/api/generations` | 记录显影事件；按事件 `id` 幂等去重，安全重试返回 `{deduped:true}` |
| GET | `/api/moods` · `/api/health` | 情绪列表 / 健康检查（均含内容版本） |

## 边界处理一览

- **当天没有可用内容**：条目支持 `availableFrom/To` 窗口；空池返回 `empty` 标记，前端呈现温和空态
- **随机结果重复**：`exclude` 参数在池中多于一条时避开上次结果
- **拖动过快**：前端 380ms 防抖 + 700ms 最小请求间隔 + 在飞请求 AbortController
- **图片资源损坏**：`img.onerror` 退回渐变底 + 提示，不阻断文字显影
- **保存时断网**：检测离线/请求失败转入 localStorage 待同步队列，`online` 事件或下次启动时自动补写；服务端 409 兜底重复
- **减少动态效果**：`prefers-reduced-motion` 下跳过显影动画与颗粒动画，直接呈现
- **Canvas 不可用**：颗粒退回纯 CSS 纹理；卡片退回纯文本下载
- **卡片生成超时**：6 秒 `Promise.race` 超时保护，自动降级文字版
- **移动端长文本**：`overflow-wrap/hyphens` + 卡片绘制时按宽度折行、超行省略
- **重复写入**：收藏按 `(clientId, contentId)` 去重；显影事件按客户端事件 id 幂等
