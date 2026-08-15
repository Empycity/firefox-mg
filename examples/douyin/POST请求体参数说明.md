# POST 请求体参数说明

本文记录当前视频上传和发布链路中的全部 POST 请求体。标记为当前默认值的字段，
以本轮浏览器成功请求和本地验证为准。

## 当前默认发布状态

```text
visibility_type = 1  -> 仅自己可见
download        = 1  -> 允许下载
timing          = 0  -> 立即发布（本轮浏览器成功样本值）
media_type      = 4  -> 视频
```

当前不传额外参数时，视频默认是 **仅自己可见、允许下载、立即发布**。

## 1. create_v2：最终发布请求

接口：

```text
POST /web/api/media/aweme/create_v2/
Content-Type: application/json
```

视频请求体形状：

```json
{
  "item": {
    "common": {
      "text": "发布文案",
      "text_extra": "[]",
      "activity": "[]",
      "challenges": "[]",
      "hashtag_source": "",
      "mentions": "[]",
      "visibility_type": 1,
      "download": 1,
      "timing": 0,
      "media_type": 4,
      "video_id": "接口返回的 Vid",
      "creation_id": "程序生成"
    },
    "cover": {
      "poster": "封面 StoreUri",
      "poster_delay": 0
    },
    "anchor": {}
  }
}
```

### `item.common`

| 字段 | 当前默认值/来源 | 是否可配置 | 含义 |
|---|---|---:|---|
| `text` | `""` | 是，`--text` | 发布文案；空字符串表示无文案。 |
| `text_extra` | `"[]"` | 暂未开放 | 文案中特殊实体的扩展信息；它是 JSON 数组字符串，不是直接数组。 |
| `activity` | `"[]"` | 暂未开放 | 活动关联信息；没有活动时为空数组字符串。 |
| `challenges` | `"[]"` | 暂未开放 | 话题/挑战关联信息；普通发布保持空。 |
| `hashtag_source` | `""` | 暂未开放 | 话题来源标记；没有话题时为空。 |
| `mentions` | `"[]"` | 暂未开放 | @用户信息；需要和文案、`text_extra` 同步生成。 |
| `visibility_type` | `1` | 是，`--visibility-type 0/1` | `0` 公开，`1` 仅自己可见。当前默认 `1`。 |
| `download` | `1` | 是，`--download 0/1` | `1` 允许下载，`0` 关闭下载。 |
| `timing` | `0` | 是，`--timing` | `0` 为本轮浏览器成功样本中的立即发布值。 |
| `media_type` | `4` | 自动 | `4` 为视频；图片发布使用 `2`。 |
| `video_id` | VOD Commit/处理结果 | 自动 | 当前视频的 `Vid`，每次上传动态返回。 |
| `creation_id` | 随机 8 位字符 + 13 位毫秒时间戳 | 自动 | 一次发布任务的幂等/链路标识；批量任务每个视频独立生成。 |

### `item.cover`

| 字段 | 当前默认值/来源 | 是否可配置 | 含义 |
|---|---|---:|---|
| `poster` | 自动上传的首帧封面 `StoreUri` | 可通过 `--poster-uri` 指定 | 视频封面素材标识。默认用 ffmpeg 提取第 0 秒画面并上传。 |
| `poster_delay` | `0` | 暂未开放 | 封面取帧延迟；当前为第 0 秒。 |

### `item.anchor`

当前值为 `{}`，表示没有商品、小程序、位置等锚点。锚点字段需要与对应业务接口
返回值组合，普通视频发布不填写。

## 2. CommitUploadInner：提交视频元数据

接口：

```text
POST https://vod.bytedanceapi.com/?Action=CommitUploadInner
```

请求体：

```json
{
  "SessionKey": "ApplyUploadInner 返回值",
  "Functions": [
    {"name": "GetMeta"},
    {"name": "Snapshot", "input": {"SnapshotTime": 0}}
  ]
}
```

| 字段 | 来源/取值 | 含义 |
|---|---|---|
| `SessionKey` | Apply 动态返回 | 将本次 Commit 与对应上传任务绑定。 |
| `Functions[].name=GetMeta` | 固定 | 要求服务端返回视频尺寸、时长、格式和编码等元数据。 |
| `Functions[].name=Snapshot` | 固定 | 要求服务端生成视频快照。 |
| `SnapshotTime` | `0` | 在视频第 0 秒生成快照。当前程序最终仍上传本地提取的封面。 |

这些字段属于上传协议，不是发布偏好。

## 3. 视频二进制上传 POST

### 小于等于 5 MiB

请求体是原始 MP4 字节：

```text
POST /upload/v1/{StoreUri}
Body = video binary
```

文件大小、CRC32、授权头、账号绑定和上传地址均自动计算或取自 Apply 响应。

### 大于 5 MiB 的分片流程

当前实现使用单分片传输：

1. `phase=init`：空请求体，返回 `uploadid`；
2. `phase=transfer`：请求体为完整视频字节；
3. `phase=finish`：请求体为 `1:{crc32}`，表示第 1 分片及其校验值。

## 4. CommitImageUpload：提交封面

接口请求体：

```json
{"SessionKey": "ApplyImageUpload 返回值"}
```

`SessionKey` 自动取自封面 Apply 响应。封面二进制上传的 POST body 是 JPEG 原始
字节。

## 命令行发布选项

```text
--text TEXT               文案，默认空
--visibility-type 0|1     0 公开；1 仅自己可见，默认 1
--download 0|1            0 禁止下载；1 允许下载，默认 1
--timing 0                0 立即发布（当前稳定值）
--poster-uri URI          可选，自行指定已提交的封面 StoreUri
```

若要增加“好友可见”“定时发布”、话题、@用户或锚点，先分别抓取一次对应 UI 选择
产生的成功请求，确认枚举值和伴随字段，再加入具名参数。
