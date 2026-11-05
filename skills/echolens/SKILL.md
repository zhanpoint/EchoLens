---
name: echolens
description: 解析抖音或 Bilibili 媒体并转录视频音频。用户提供视频链接并需要媒体信息、字幕或转录文本时使用。
---

# EchoLens

使用 EchoLens 处理抖音或 Bilibili 视频链接。

## 配置

从环境变量读取 `ECHOLENS_BASE_URL` 和 `ECHOLENS_API_TOKEN`。所有请求使用 `Authorization: Bearer <token>`。

## 服务

只需要媒体信息时调用：

```http
POST $ECHOLENS_BASE_URL/api/open/media/resolve
Content-Type: application/json
Authorization: Bearer $ECHOLENS_API_TOKEN

{"inputs":["<video-url>"]}
```

需要字幕或转录文本时调用：

```http
POST $ECHOLENS_BASE_URL/api/open/transcripts/transcribe
Content-Type: application/json
Authorization: Bearer $ECHOLENS_API_TOKEN

{"input":"<video-url>"}
```

解析媒体返回标题、作者、封面和可用的音频、视频地址；转录返回媒体信息和转录文本，按 API 实际返回内容展示。不要输出 API 访问令牌或编造 API 未返回的内容。
