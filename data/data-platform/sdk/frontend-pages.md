# SDK 数据管理前端页面设计

**日期**: 2026-07-13
**范围**: Event Center 模块元数据管理与 SDK 数据运营

---

## 菜单结构

```
数据管理
├── 应用管理
├── 元事件
├── 事件属性组
├── 用户属性
├── Staging 管理
├── 数据表
└── 事件流

产品管理（Permission 模块，本文档不涉及）
```

---

## 角色可见性

| 菜单项 | 平台超级管理员 | 平台运营 | 公司管理员 | 项目管理员 |
|--------|:------------:|:--------:|:--------:|:--------:|
| 应用管理 | ✗ | ✗ | ✓ | ✓ |
| 元事件 | ✓ | ✓ | ✓ | ✓ |
| 事件属性组 | ✓ | ✓ | ✓ | ✓ |
| 用户属性 | ✓ | ✓ | ✓ | ✓ |
| 黑名单 | ✓ | ✓ | ✓ | ✓ |
| Staging 管理 | ✓ | ✓ | ✓ | ✓ |
| 数据表 | ✓ | ✓ | ✗ | ✗ |
| 事件流 | ✓ | ✓ | ✗ | ✗ |

---

## 核心数据模型

### 应用（App）

`app` 表是元数据管理的顶层实体，所有元事件、属性、黑名单、Staging 均归属于一个 appId。创建应用时自动生成 appKey 和 accessToken，SDK 使用 accessToken 鉴权上报数据。

应用创建流程：
1. 生成 appId（16 位 UUID）、appKey（64 位随机字符串）、accessToken（64 位随机字符串）
2. 写入 `app` 表，status=1
3. accessToken 写入 Redis（SDK 鉴权查询用）
4. 播种预置元数据：从 `preset_catalog` 读取预置模板，批量写入 `event_metadata`、`event_property_metadata`、`user_property_metadata`

### 正式表与预存表（Staging）关系

```
┌─────────────────────────────┐      ┌──────────────────────────────────┐
│  SDK 上报事件                │ ──→  │  自动 tap 到 staging（status=0）  │
│  (EventProcessServiceImpl)  │      │  - event_metadata_staging         │
└─────────────────────────────┘      │  - event_property_metadata_staging│
                                     │  - user_property_metadata_staging │
                                     └──────────────┬───────────────────┘
                                                    │
                                     运营人员在 Staging 管理页面审核
                                                    │
                                     ┌──────────────┴───────────────────┐
                                     │  批准 → 写入正式表 + 标记 promoted │
                                     │  拒绝 → 标记 rejected             │
                                     │  批量发布 → 全部 pending → 正式表  │
                                     └──────────────┬───────────────────┘
                                                    │
                                     ┌──────────────┴───────────────────┐
                                     │  正式表（SDK 实时读取校验）         │
                                     │  - event_metadata                 │
                                     │  - event_property_metadata        │
                                     │  - user_property_metadata         │
                                     └──────────────────────────────────┘
```

| 表 | 正式表 | 预存表（Staging） | 触发方式 |
|---|---|---|---|
| 元事件 | `event_metadata` | `event_metadata_staging` | SDK 上报未注册事件时自动 tap |
| 事件属性 | `event_property_metadata` | `event_property_metadata_staging` | SDK 上报未注册属性时自动 tap |
| 用户属性 | `user_property_metadata` | `user_property_metadata_staging` | SDK 上报未注册用户属性时自动 tap |

Staging 状态流转：
- `status=0`：待审核（pending），SDK 自动 tap 产生
- `status=1`：已发布（promoted），经 promote 后标记
- `status=2`：已拒绝（rejected），运营手动拒绝

### 预置目录（Preset Catalog）

`preset_catalog` 表存储系统预置的事件和属性模板，按 category 分类：
- `category=event`：预置元事件模板
- `category=property`：预置事件属性模板
- `category=user_property`：预置用户属性模板

创建应用时可一键播种（seed），将预置模板批量写入正式表。也可在元数据管理页面手动应用单个预置项。

---

## 1. 应用管理

**使用者**: 公司管理员 / 项目管理员

**说明**: 此功能从 auth 服务迁移到 event-center。`app` 表属于 `qpointplay_event_center` 库，由 event-center 统一管理。

**功能**:
- 应用分页列表，支持按名称/状态搜索
- 创建应用：填写应用名称、包名，自动生成 appId、appKey、accessToken，同步写入 Redis 并播种预置元数据
- 查看应用详情（含 appKey、accessToken）
- 启用/停用应用（停用后 SDK 上报将被拒绝）
- 编辑应用基本信息（名称、包名）

**API 端点**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/event/center/app/page` | 应用分页列表 |
| GET | `/event/center/app/detail` | 应用详情 |
| POST | `/event/center/app/create` | 创建应用（自动生成密钥 + 播种预置元数据） |
| POST | `/event/center/app/update` | 更新应用基本信息 |
| POST | `/event/center/app/disable` | 停用应用 |
| POST | `/event/center/app/enable` | 启用应用 |

**迁移说明**：

| 组件 | 迁移前（auth 服务） | 迁移后（event-center） |
|---|---|---|
| Controller | `auth: AppController` (`/api/admin/app/*`) | `event-center: AppController` (`/event/center/app/*`) |
| Service | `auth: AppService/AppServiceImpl` | `event-center: AppService/AppServiceImpl` |
| MpService | `auth: AppMpService/AppMpServiceImpl` | 移至 `common-model`（共享给 auth 和 event-center） |
| DTO | `auth: dto/request/CreateAppRequest` 等 | 移至 `common-model` |
| Redis 写入 | `AppServiceImpl.createApp()` | 保留在 event-center 的 createApp 中 |
| Feign 播种 | `auth → event-sdk: seedAllowlist` | 删除，event-center 直接调用 `MetadataSeedService.seedForApp()` |

**Feign 对外暴露**：

App 管理迁移到 event-center 后，auth 服务需要在项目组管理中绑定 appId，因此 event-center 需通过 Feign 暴露内部查询接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/event/center/internal/app/list` | 全量应用列表（供 auth 项目绑定下拉选择） |
| GET | `/event/center/internal/app/check` | 校验 appId 是否存在且启用 |

auth 服务新增 `AppFeignClient`（`@FeignClient(name = "qpointplay-service-event-center", path = "/event/center")`），调用以上内部端点。

---

## 2. 元事件

**使用者**: 平台运营 / 公司管理员 / 项目管理员

**功能**:
- 元事件分页列表，支持按事件名称搜索
- 手动创建元事件（名称、显示名、描述）
- 编辑元事件（显示名、描述）
- 删除元事件（删除时从 event_metadata 移除，不影响已入库的 event 数据）
- 从预置目录应用单个事件模板

**API 端点**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/event/center/metadata/event/page` | 元事件分页列表 |
| GET | `/event/center/metadata/event/detail` | 元事件详情 |
| POST | `/event/center/metadata/event/create` | 创建元事件 |
| POST | `/event/center/metadata/event/update` | 更新元事件 |
| POST | `/event/center/metadata/event/delete` | 删除元事件 |

---

## 3. 事件属性组

**使用者**: 平台运营 / 公司管理员 / 项目管理员

**功能**:
- 事件属性分页列表，支持按事件名称/属性名称搜索
- 按事件名称分组展示（属性组视角），公共属性（`event_name=*`）单独分组标记
- 手动创建事件属性（appId、事件名、属性名、类型、是否必传、枚举值、描述）
- 编辑事件属性（类型、是否必传、枚举值、描述）
- 删除事件属性

**API 端点**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/event/center/metadata/eventProperty/page` | 事件属性分页列表 |
| GET | `/event/center/metadata/eventProperty/detail` | 事件属性详情 |
| POST | `/event/center/metadata/eventProperty/create` | 创建事件属性（已有） |
| POST | `/event/center/metadata/eventProperty/update` | 更新事件属性（已有） |
| POST | `/event/center/metadata/eventProperty/delete` | 删除事件属性（已有） |

---

## 4. 用户属性

**使用者**: 平台运营 / 公司管理员 / 项目管理员

**功能**:
- 用户属性分页列表，支持按属性名称搜索
- 手动创建用户属性（appId、属性名、类型、描述）
- 编辑用户属性（类型、描述）
- 删除用户属性

**API 端点**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/event/center/metadata/userProperty/page` | 用户属性分页列表 |
| GET | `/event/center/metadata/userProperty/detail` | 用户属性详情 |
| POST | `/event/center/metadata/userProperty/create` | 创建用户属性（已有） |
| POST | `/event/center/metadata/userProperty/update` | 更新用户属性（已有） |
| POST | `/event/center/metadata/userProperty/delete` | 删除用户属性（已有） |

---

## 5. 黑名单

**使用者**: 平台运营 / 公司管理员 / 项目管理员

**功能**:
- 黑名单分页列表，支持按事件名称搜索
- 添加黑名单（appId、事件名、拦截原因）
- 移除黑名单
- 黑名单事件在 SDK 上报时被 Phase A 拦截，不入库

**API 端点**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/event/center/metadata/blocklist/page` | 黑名单分页列表 |
| POST | `/event/center/metadata/blocklist/create` | 添加黑名单 |
| POST | `/event/center/metadata/blocklist/delete` | 移除黑名单 |
| GET | `/event/center/metadata/blocklist/check` | 检查是否在黑名单（已有） |

---

## 6. Staging 管理

**使用者**: 平台运营 / 公司管理员 / 项目管理员

**说明**: 聚合 SDK 自动 tap 的全部待审核元数据，按类型分 Tab 展示。运营在此统一审核：逐条批准/拒绝，或一键全量发布。

**页面布局**:
- 顶部：发布状态概览卡片（三类 pending 数量 + 全部发布按钮）
- 主体：Tab 切换（元事件 / 事件属性 / 用户属性），每个 Tab 内为待审核分页列表

**发布状态概览**:
- 元事件待审核数 / 事件属性待审核数 / 用户属性待审核数
- 一键「全部发布」按钮：将三类 staging 全部 pending 记录写入正式表

**元事件 Tab（`event_metadata_staging`，status=0）**:
- 分页列表：事件名称、首次发现时间、操作
- 单条批准：写入 `event_metadata`，标记 status=1
- 单条拒绝：标记 status=2
- 支持按事件名称搜索

**事件属性 Tab（`event_property_metadata_staging`，status=0）**:
- 分页列表：事件名称、属性名称、推断类型（可修改）、首次发现时间、操作
- 单条批准前可修改属性类型
- 单条批准：写入 `event_property_metadata`，标记 status=1
- 单条拒绝：标记 status=2
- 支持按事件名称/属性名称搜索

**用户属性 Tab（`user_property_metadata_staging`，status=0）**:
- 分页列表：属性名称、推断类型（可修改）、首次发现时间、操作
- 单条批准前可修改属性类型
- 单条批准：写入 `user_property_metadata`，标记 status=1
- 单条拒绝：标记 status=2
- 支持按属性名称搜索

**API 端点**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/event/center/metadata/staging/status` | 发布状态概览（三类 pending 数量） |
| POST | `/event/center/metadata/staging/promoteAll` | 一键全部发布（三类全部 pending → 正式表） |
| GET | `/event/center/metadata/staging/eventPage` | 元事件 Staging 分页列表 |
| POST | `/event/center/metadata/staging/event/approve` | 批准单个 staging 事件 |
| POST | `/event/center/metadata/staging/event/reject` | 拒绝单个 staging 事件 |
| GET | `/event/center/metadata/staging/eventPropertyPage` | 事件属性 Staging 分页列表 |
| POST | `/event/center/metadata/staging/eventProperty/approve` | 批准单个 staging 属性（含修改后的类型） |
| POST | `/event/center/metadata/staging/eventProperty/reject` | 拒绝单个 staging 属性 |
| GET | `/event/center/metadata/staging/userPropertyPage` | 用户属性 Staging 分页列表 |
| POST | `/event/center/metadata/staging/userProperty/approve` | 批准单个 staging 用户属性（含修改后的类型） |
| POST | `/event/center/metadata/staging/userProperty/reject` | 拒绝单个 staging 用户属性 |

---

## 7. 预置目录

**使用者**: 平台运营

**功能**:
- 预置目录分页列表，按 category 筛选（event / property / user_property）
- 查看预置项详情（含 metadata JSON 预览）
- 应用预置项到指定 appId（已有）

**API 端点**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/event/center/metadata/seed/page` | 预置目录分页列表 |
| GET | `/event/center/metadata/seed/detail` | 预置项详情 |
| POST | `/event/center/metadata/seed/apply` | 应用预置项（已有） |

---

## 8. 数据表

**使用者**: 平台运营

**功能**:
- 展示当前应用下的数据表清单（event、user、user_device、first_event 等）
- 查看表结构（字段名、类型、注释）
- 查看表数据量（近似行数）
- 预览表数据（前 N 条）
- 不提供数据编辑/删除能力（只读）

**API 端点**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/event/center/data/table/list` | 数据表清单 |
| GET | `/event/center/data/table/schema` | 表结构详情 |
| GET | `/event/center/data/table/preview` | 表数据预览（只读） |

---

## 9. 事件流

**使用者**: 平台运营

**功能**:
- 实时事件流监控面板，展示近期事件处理概况
- 事件接收量趋势（按时间粒度：小时/天）
- 事件类型分布（track / profile / first_track）
- 校验拦截统计（黑名单拦截、白名单拦截、Catalog 校验失败）
- Kafka 双写对账状态（已调度 / 待调度 / 失败数）

**说明**：此页面为监控面板，数据来源于 event 表和 event_kafka_dispatched 表的聚合查询，不涉及新的写入 API。

**API 端点**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/event/center/stream/overview` | 事件流概览（总量、趋势、分布） |
| GET | `/event/center/stream/errors` | 校验拦截详情分页 |
| GET | `/event/center/stream/kafkaStatus` | Kafka 双写对账状态 |

---

## 现有接口对照与改造清单

### 已有接口（保留）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/metadata/event/list` | 元事件名称列表 |
| GET | `/metadata/event/check` | 检查事件是否注册 |
| GET | `/metadata/eventProperty/list` | 事件属性列表 |
| POST | `/metadata/eventProperty/create` | 创建事件属性 |
| POST | `/metadata/eventProperty/update` | 更新事件属性 |
| POST | `/metadata/eventProperty/delete` | 删除事件属性 |
| GET | `/metadata/userProperty/list` | 用户属性列表 |
| POST | `/metadata/userProperty/create` | 创建用户属性 |
| POST | `/metadata/userProperty/update` | 更新用户属性 |
| POST | `/metadata/userProperty/delete` | 删除用户属性 |
| GET | `/metadata/blocklist/check` | 检查黑名单 |
| POST | `/metadata/promote/execute` | 批量发布 Staging → 正式（保留作为 promoteAll 的实现） |
| GET | `/metadata/promote/status` | 发布状态（保留作为 staging/status 的实现） |
| GET | `/metadata/seed/list` | 预置目录列表 |
| POST | `/metadata/seed/apply` | 应用预置项 |

### 需要新增的接口

**应用管理**（从 auth 迁移 + 新增 Controller：`AppController`）：
- `GET /app/page` — 应用分页列表
- `GET /app/detail` — 应用详情
- `POST /app/create` — 创建应用（自动生成密钥 + 播种预置元数据）
- `POST /app/update` — 更新应用基本信息
- `POST /app/disable` — 停用应用
- `POST /app/enable` — 启用应用

**应用管理 Feign**（新增 Controller：`InternalAppController`，供 auth 服务调用）：
- `GET /internal/app/list` — 全量应用列表
- `GET /internal/app/check` — 校验 appId 是否存在且启用

**元事件**：
- `GET /metadata/event/page` — 分页列表（含显示名、描述）
- `GET /metadata/event/detail` — 详情
- `POST /metadata/event/create` — 创建
- `POST /metadata/event/update` — 更新
- `POST /metadata/event/delete` — 删除

**事件属性**：
- `GET /metadata/eventProperty/page` — 分页列表
- `GET /metadata/eventProperty/detail` — 详情

**用户属性**：
- `GET /metadata/userProperty/page` — 分页列表
- `GET /metadata/userProperty/detail` — 详情

**黑名单**：
- `GET /metadata/blocklist/page` — 分页列表
- `POST /metadata/blocklist/create` — 添加
- `POST /metadata/blocklist/delete` — 删除

**Staging 管理**（新增 Controller：`MetadataStagingController`）：
- `GET /metadata/staging/status` — 发布状态概览
- `POST /metadata/staging/promoteAll` — 一键全部发布
- `GET /metadata/staging/eventPage` — 元事件 staging 分页
- `POST /metadata/staging/event/approve` — 批准单个 staging 事件
- `POST /metadata/staging/event/reject` — 拒绝单个 staging 事件
- `GET /metadata/staging/eventPropertyPage` — 事件属性 staging 分页
- `POST /metadata/staging/eventProperty/approve` — 批准单个 staging 属性
- `POST /metadata/staging/eventProperty/reject` — 拒绝单个 staging 属性
- `GET /metadata/staging/userPropertyPage` — 用户属性 staging 分页
- `POST /metadata/staging/userProperty/approve` — 批准单个 staging 用户属性
- `POST /metadata/staging/userProperty/reject` — 拒绝单个 staging 用户属性

**预置目录**（新增 Controller：`MetadataSeedController`，扩展现有）：
- `GET /metadata/seed/page` — 分页列表
- `GET /metadata/seed/detail` — 详情

**数据表**（新增 Controller：`DataTableController`）：
- `GET /data/table/list` — 表清单
- `GET /data/table/schema` — 表结构
- `GET /data/table/preview` — 数据预览

**事件流**（新增 Controller：`EventStreamController`）：
- `GET /stream/overview` — 概览
- `GET /stream/errors` — 校验拦截详情
- `GET /stream/kafkaStatus` — Kafka 对账状态

### Staging 单条操作 vs 批量发布

| 接口 | 行为 |
|---|---|
| `POST /metadata/staging/event/approve` | 将指定 staging 记录写入 `event_metadata`，标记 status=1 |
| `POST /metadata/staging/event/reject` | 标记 staging 记录 status=2 |
| `POST /metadata/staging/promoteAll` | 全量发布：三类 staging 全部 status=0 记录 → 对应正式表，标记 status=1 |

运营可根据实际情况选择：直接全量发布，或逐条审核后再发布。