# 015-event-product-app-split

> 日期：2026-07-15
> 状态：设计中

## 背景

权限模型 V3.1 定义了 product / application 表，但这两张表是事件上报 SDK 的核心实体，属于 event_center 域，不应放在 auth 库。

## 拆分方案

### 库归属

| 表 | 归属库 | 理由 |
|----|--------|------|
| product | `qpointplay_event_center` | 产品是事件上报的核心实体，event_sdk 启动时需加载 |
| application | `qpointplay_event_center` | 应用是事件上报的核心实体，含 app_key / access_token |
| project_group_application | `qpointplay_event_center` | 项目组-应用关联，与应用同库便于 JOIN |
| project_group | `qpointplay_auth` | 项目组是权限管理概念 |
| app_group | `qpointplay_auth` | 应用组是数据权限载体 |
| app_group_application | `qpointplay_auth` | 跨库关联，存 application_id 引用 |
| role | `qpointplay_auth` | 权限概念 |
| member | `qpointplay_auth` | 权限概念 |
| member_role | `qpointplay_auth` | 权限概念 |
| member_app_group | `qpointplay_auth` | 权限概念 |
| role_resource_group | `qpointplay_auth` | 权限概念 |

### 跨库引用

`app_group_application.application_id` 引用 `qpointplay_event_center.application.application_id`，应用层校验完整性，不建物理外键。

### 涉及模块

| 模块 | 变更 |
|------|------|
| event_sdk | 启动时加载 product + application 列表，用于 SDK 初始化校验 |
| event_center | 新增 product、application、project_group_application 表及 CRUD |
| auth | 新增 project_group、app_group、app_group_application、role、member 及关联表 |
| common-model | 新增或迁移 product / application 相关 DTO |

## 待确认

1. event_sdk 目前如何加载应用配置？product 表引入后，SDK 初始化流程是否变更？
2. application 表的 app_key / access_token 是否由 event_center 生成，还是 auth 侧生成？
3. project_group_application 在 event_center 库，auth 侧查询时是否需要 event_center 提供接口？