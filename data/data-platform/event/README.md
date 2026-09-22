# event 服务拆分方案

> 版本：V1.0
> 日期：2026-07-10
> 状态：讨论中

## 一、拆分目标

将现有 `qpointplay-service-event` 拆分为两个独立服务：

| 服务 | 模块名 | 职责 |
|---|---|---|
| event-sdk | `qpointplay-service-event-sdk` | SDK 数据上报接收、token 校验、事件写入 |
| event-center | `qpointplay-service-event-center` | 元数据管理、运营人员操作入口 |

---

## 二、模块归属

### 2.1 event-sdk（上报通道）

| 模块 | 现有路径 | 说明 |
|---|---|---|
| SDK 控制器 | `controller/sdk/` | ConfigController、EventController、UserController |
| Token 校验 | `service/auth/` | app_access_token 校验 |
| 事件处理 | `service/event/` | EventProcessService、Kafka/Mysql Sink |
| 用户标识 | `service/identity/` | IdentityService |
| 设备管理 | `service/device/` | UserDeviceService |
| IP 提取 | `service/enrichment/` | IpExtractor |
| 事件校验 | `service/validation/` | EventCatalogValidator |
| 数据对象 | `dto/request/`、`dto/response/` | EventCollectRequest、ConfigResponse 等 |
| 内部接口 | `controller/internal/InternalAllowlistController` | 白名单管理 |

### 2.2 event-center（元数据管理）

| 模块 | 现有路径 | 说明 |
|---|---|---|
| 元事件管理 | `service/metadata/EventMetadataService` | 元事件 CRUD、同步 |
| 事件属性管理 | `service/metadata/EventPropertyMetadataService` | 属性别名、备注、枚举值 |
| 用户属性管理 | `service/metadata/UserPropertyMetadataService` | 用户属性管理 |
| 埋点黑名单 | `service/metadata/EventBlocklistService` | 禁用无效埋点 |
| 预置目录 | `service/metadata/MetadataSeedService` | 预置事件/属性模板 |
| 元数据发布 | `service/metadata/MetadataPromoteService` | staging → 正式表 |
| Staging 管理 | `service/metadata/staging/` | 元数据草稿态 |
| 内部接口 | `controller/internal/InternalMetadataController` | 元数据内部查询 |
| 运营管理接口 | 新增 Controller | 运营人员管理元数据的对外接口 |

### 2.3 共享模块（两边都需要）

| 模块 | 说明 |
|---|---|
| `domain/mp/` 中的基础实体 | EventMp、UserMp、UserDeviceMp、FirstEvent、AppConfig 等 |
| `dao/` 中的基础 Mapper | 对应基础实体的 Mapper 和 MpService |
| `enums/` | EventType、ProfileOperation |

---

## 三、变更清单

### 3.1 目录重命名

| 现有 | 变更为 |
|---|---|
| `qpointplay-service/qpointplay-service-event` | `qpointplay-service/qpointplay-service-event-sdk` |

### 3.2 新建服务

| 服务 | 目录 |
|---|---|
| event-center | `qpointplay-service/qpointplay-service-event-center` |

### 3.3 包名变更

| 现有 | 变更为 |
|---|---|
| `com.qpointplay.qpointplaydata`（event 模块内） | `com.qpointplay.qpointplaydata`（保持不变，仅拆分到两个服务目录） |

### 3.4 启动类变更

| 现有 | 变更为 |
|---|---|
| `QpointplayEventApplication` | `QpointplayEventSdkApplication` |
| 新增 | `QpointplayEventCenterApplication` |

### 3.5 服务名称变更

| 现有 | 变更为 |
|---|---|
| `qpointplay-event` | `qpointplay-event-sdk` |
| 新增 | `qpointplay-event-center` |

### 3.6 配置文件

| 现有 | 变更为 |
|---|---|
| `event/src/main/resources/` | 拆分为 `event-sdk/` 和 `event-center/` 各自独立配置 |

### 3.7 pom.xml

| 现有 | 变更为 |
|---|---|
| `event/pom.xml` artifactId: `qpointplay-service-event` | `event-sdk/pom.xml` artifactId: `qpointplay-service-event-sdk` |
| 新增 | `event-center/pom.xml` artifactId: `qpointplay-service-event-center` |

---

## 四、共享模块处理

共享的 domain、dao、enums 抽取到 `qpointplay-common` 或新建 `qpointplay-common-event` 模块，避免两个服务各自维护一份。

| 方案 | 说明 |
|---|---|
| 方案 A | 抽到 `qpointplay-common/common-event`，两个服务都依赖 |
| 方案 B | 保留在 event-sdk，event-center 通过 Feign 调用 |

建议方案 A，共享 domain 实体和 Mapper，避免 Feign 调用的延迟和维护成本。

---

## 五、数据库

两个服务共用同一个 event 数据库，不拆分数据库。event-sdk 写入，event-center 读写。

---

## 六、待讨论事项

1. 共享模块是否抽到 common-event，还是直接放 common 里？
2. event-center 的运营管理接口是否需要新的 Controller 路径前缀，如 `/event/center/**`？
3. 现有 event 服务的 Nacos 注册、网关路由是否需要同步变更？