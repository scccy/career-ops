# V3.1 前端暴露端点汇总

> 日期：2026-07-15
> 分支：015-auth-company-permission-rebuild
> 说明：gateway 对每个服务自动拼接 context-path（`/auth`、`/event/center`），路径中不含 `/internal/**` 的端点（内部调用不暴露前端）

---

## 一、Auth 服务（gateway context-path `/auth`）

### 1.1 公司侧登录

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/v1/login` | 公司成员登录（email + password），返回 JWT + refresh token |
| POST | `/auth/v1/refresh` | 刷新 access token |
| POST | `/auth/v1/logout` | 当前设备登出，吊销 refresh token |

### 1.2 公司侧权限管理 — 成员

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/v1/permission/member/create` | 创建成员（超管权限），返回 memberId + 一次性明文密码 |
| POST | `/auth/v1/permission/member/page` | 成员分页查询（支持 memberName / email / status 过滤） |
| GET | `/auth/v1/permission/member/detail?memberId=` | 成员详情 |
| POST | `/auth/v1/permission/member/update` | 更新成员名称/邮箱 |
| POST | `/auth/v1/permission/member/delete` | 删除成员（超管权限，引用约束阻止） |
| POST | `/auth/v1/permission/member/disable` | 禁用成员（软禁用，销毁 Redis 权限 key + 吊销 refresh token） |
| POST | `/auth/v1/permission/member/enable` | 启用成员（重建 Redis 权限 key） |
| POST | `/auth/v1/permission/member/resetPassword` | 重置密码（INCR token_version，销毁所有旧 session），返回一次性明文密码 |

### 1.3 公司侧权限管理 — 角色

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/v1/permission/role/create` | 创建角色 |
| POST | `/auth/v1/permission/role/page` | 角色分页查询 |
| GET | `/auth/v1/permission/role/detail?roleId=` | 角色详情 |
| POST | `/auth/v1/permission/role/update` | 更新角色名称 |
| POST | `/auth/v1/permission/role/delete` | 删除角色（被成员引用或 is_builtin 时阻止） |
| POST | `/auth/v1/permission/role/resourceGroup/bind` | 角色绑定资源权限组 |
| POST | `/auth/v1/permission/role/resourceGroup/unbind` | 角色解绑资源权限组 |

### 1.4 公司侧权限管理 — 应用组

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/v1/permission/appGroup/create` | 创建应用组 |
| POST | `/auth/v1/permission/appGroup/page` | 应用组分页查询 |
| GET | `/auth/v1/permission/appGroup/detail?appGroupId=` | 应用组详情 |
| POST | `/auth/v1/permission/appGroup/update` | 更新应用组名称 |
| POST | `/auth/v1/permission/appGroup/delete` | 删除应用组（被成员引用时阻止） |
| POST | `/auth/v1/permission/appGroup/application/bind` | 应用组绑定应用（跨库引用 event_center.app.app_id） |
| POST | `/auth/v1/permission/appGroup/application/unbind` | 应用组解绑应用 |

### 1.5 公司侧权限管理 — 项目组

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/v1/permission/projectGroup/create` | 创建项目组 |
| POST | `/auth/v1/permission/projectGroup/page` | 项目组分页查询 |
| GET | `/auth/v1/permission/projectGroup/detail?projectGroupId=` | 项目组详情 |
| POST | `/auth/v1/permission/projectGroup/update` | 更新项目组名称 |
| POST | `/auth/v1/permission/projectGroup/delete` | 删除项目组（被应用组引用时阻止） |
| POST | `/auth/v1/permission/projectGroup/application/bind` | 项目组绑定应用（调 event_center 写 project_group_application） |
| POST | `/auth/v1/permission/projectGroup/application/unbind` | 项目组解绑应用 |

### 1.6 平台侧登录

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/v1/platform/login` | 平台用户登录（username + password），返回 JWT + refresh token |
| POST | `/auth/v1/platform/refresh` | 刷新平台 access token |
| POST | `/auth/v1/platform/logout` | 平台登出 |

### 1.7 平台侧 — 公司管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/v1/platform/company/create` | 创建公司 + 同事务 bootstrap 首超管（传 firstSuperAdminEmail），返回 companyId + superAdminMemberId + oneTimePassword |
| POST | `/auth/v1/platform/company/page` | 公司分页查询 |
| GET | `/auth/v1/platform/company/detail?id=` | 公司详情 |
| POST | `/auth/v1/platform/company/disable` | 公司软停用（批量销毁 Redis 权限 key + 吊销 refresh token） |
| POST | `/auth/v1/platform/company/enable` | 公司启用 |

### 1.8 平台侧 — 权限点目录

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/v1/platform/permissionDirectory/route/page` | 路由权限点分页 |
| GET | `/auth/v1/platform/permissionDirectory/route/detail` | 路由权限点详情 |
| POST | `/auth/v1/platform/permissionDirectory/route/update` | 更新路由权限点 |
| GET | `/auth/v1/platform/permissionDirectory/scopeChange/impact` | scope 变更影响范围查询 |
| POST | `/auth/v1/platform/permissionDirectory/scopeChange/execute` | 执行 scope 变更 |
| POST | `/auth/v1/platform/permissionDirectory/route/batchEnable` | 批量启用路由权限点 |
| POST | `/auth/v1/platform/permissionDirectory/function/page` | 功能权限点分页 |
| GET | `/auth/v1/platform/permissionDirectory/function/detail` | 功能权限点详情 |
| POST | `/auth/v1/platform/permissionDirectory/function/create` | 创建功能权限点 |
| POST | `/auth/v1/platform/permissionDirectory/function/update` | 更新功能权限点 |
| POST | `/auth/v1/platform/permissionDirectory/function/delete` | 删除功能权限点 |

### 1.9 平台侧 — 审计日志

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/v1/platform/auditLog/page` | 审计日志分页查询（支持 targetType / action / 时间范围过滤） |

---

## 二、Event Center 服务（gateway context-path `/event/center`）

### 2.1 应用管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/event/center/app/create` | 创建应用，返回 appId + appKey + accessToken |
| POST | `/event/center/app/disable` | 停用应用 |
| POST | `/event/center/app/enable` | 启用应用 |
| GET | `/event/center/app/list` | 应用列表（支持 companyId / projectId 过滤） |
| GET | `/event/center/app/detail?appId=` | 应用详情 |
| POST | `/event/center/app/update` | 更新应用信息 |
| POST | `/event/center/app/delete` | 删除应用 |

### 2.2 产品管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/event/center/product/create` | 创建产品（游戏母体） |
| POST | `/event/center/product/page` | 产品分页查询 |
| GET | `/event/center/product/detail?productId=` | 产品详情 |
| POST | `/event/center/product/update` | 更新产品信息 |
| POST | `/event/center/product/delete` | 删除产品（有 app 引用时阻止） |

### 2.3 项目组-应用关联

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/event/center/projectGroupApplication/bind` | 项目组绑定应用 |
| POST | `/event/center/projectGroupApplication/unbind` | 项目组解绑应用 |
| GET | `/event/center/projectGroupApplication/listByProjectGroup?projectGroupId=` | 查询项目组下应用列表 |

---

## 三、端点汇总统计

| 服务 | 模块 | 接口数 |
|------|------|--------|
| auth | 公司侧登录 | 3 |
| auth | 成员管理 | 8 |
| auth | 角色管理 | 7 |
| auth | 应用组管理 | 7 |
| auth | 项目组管理 | 7 |
| auth | 平台侧登录 | 3 |
| auth | 公司管理 | 5 |
| auth | 权限点目录 | 11 |
| auth | 审计日志 | 1 |
| event_center | 应用管理 | 7 |
| event_center | 产品管理 | 5 |
| event_center | 项目组-应用关联 | 3 |
| **合计** | | **67** |

---

## 四、鉴权说明

- **公司侧接口**（`/auth/v1/login`、`/auth/v1/permission/**`）：JWT 含 `memberId` / `companyId` / `isAdmin` / `type=COMPANY`。`isAdmin=true` 超管 bypass；非管理员走 Redis `saas:permission:{memberId}` Hash 校验（Miss 即 403）
- **平台侧接口**（`/auth/v1/platform/**`）：JWT 含 `userId` / `roles` / `type=PLATFORM`。`roles` 含 `PLATFORM_ADMIN` 时 bypass
- **event_center 接口**（`/event/center/**`）：走既有鉴权链路
- **gateway 白名单**：`/auth/v1/login`、`/auth/v1/refresh`、`/auth/v1/platform/login`、`/auth/v1/platform/refresh`
- **内部接口**（`/internal/**`）：gateway 返回 404，仅通过 `lb://` 内部调用（`/event/center/internal/app/detail`、`/event/center/internal/app/listByIds`、`/event/center/internal/product/detail` 等）