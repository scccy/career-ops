# V3.1 接口文档

> 日期：2026-07-15
> 分支：015-auth-company-permission-rebuild
> 端点总数：67（auth 52 + event_center 15）
> 鉴权：JWT Bearer Token，gateway 注入 `X-User-*` Header

---

## 通用约定

### 请求规范

- **Content-Type**: `application/json`（除文件上传外）
- **Authorization**: `Bearer <accessToken>`（白名单接口除外）
- **路径前缀**: gateway 自动拼接服务 context-path（`/auth` 或 `/event/center`）
- **命名**: 路径驼峰，body 字段驼峰

### 统一响应体 `ResultData<T>`

```json
{
  "code": 200,
  "msg": "ok",
  "data": <T>
}
```

| code | 含义 |
|------|------|
| 200 | 成功 |
| 400 | 参数校验失败 |
| 401 | JWT 无效/过期/refresh_token 失效 |
| 403 | 权限不足 / Redis Miss |
| 404 | 资源不存在 |
| 409 | 唯一约束冲突 |
| 412 | 删除约束阻止（被引用禁删） |
| 500 | 服务异常 |

### JWT Claims

**公司成员** (`type=COMPANY`):

| claim | 类型 | 说明 |
|-------|------|------|
| memberId | Number | member.id |
| companyId | Number | 所属公司 |
| isAdmin | Boolean | 超管 bypass 标记 |
| tokenVersion | Number | 改密码时 INCR，所有旧 JWT 失效 |
| type | String | 固定 "COMPANY" |
| jti | String | JWT 唯一 ID |
| exp | Number | now + 2h（7200s） |

**平台用户** (`type=PLATFORM`):

| claim | 类型 | 说明 |
|-------|------|------|
| userId | Number | platform_user.id |
| roles | String[] | 平台角色 code 列表 |
| type | String | 固定 "PLATFORM" |
| exp | Number | now + 2h |

### Gateway 白名单

无需 JWT 即可访问：
- `POST /auth/v1/login`
- `POST /auth/v1/refresh`
- `POST /auth/v1/platform/login`
- `POST /auth/v1/platform/refresh`

---

# 一、Auth 服务 — 公司侧

## 1. 登录与会话

### POST `/auth/v1/login` — 公司成员登录

**Request**:
```json
{
  "email": "alice@company.com",
  "password": "plain-password"
}
```

**Response**:
```json
{
  "code": 200,
  "msg": "ok",
  "data": {
    "accessToken": "eyJhbGciOi...",
    "refreshToken": "jti-uuid-string",
    "expiresIn": 7200
  }
}
```

**行为**: BCrypt 校验密码 → INCR token_version → 生成 refresh_token（写 DB + Redis ZSET）→ 多设备超限踢老（3 设备上限）→ 非管理员构建 `saas:permission:{memberId}` Hash

**错误**:
- 401: 账号不存在 / 密码错误 / 账号已禁用 / 公司已停用

---

### POST `/auth/v1/refresh` — 刷新 access token

**Request**:
```json
{ "refreshToken": "jti-uuid-string" }
```

**Response**: 同 login

**行为**: 验签 refresh_token → 查 DB revoked_at IS NULL AND expires_at > now → 校验 token_version → 吊销旧 + 签发新

**错误**: 401: refresh_token 过期/已吊销/token_version 不一致

---

### POST `/auth/v1/logout` — 当前设备登出

**Request**:
```json
{ "refreshToken": "jti-uuid-string" }
```

**Response**: `ResultData<String>` → `"ok"`

**行为**: DB 标记当前 jti revoked_at = now + Redis ZREM，不影响其他设备

---

## 2. 成员管理

### POST `/auth/v1/permission/member/create` — 创建成员

**鉴权**: 仅超管（`isAdmin=true`）

**Request**:
```json
{
  "memberName": "张三",
  "email": "zhangsan@company.com",
  "companyId": 5001,
  "operatorId": 8001,
  "operatorName": "超管",
  "roleIds": [101, 102],
  "appGroupIds": [201, 202]
}
```

**Response**:
```json
{
  "code": 200,
  "msg": "ok",
  "data": {
    "id": 10001,
    "memberName": "张三",
    "email": "zhangsan@company.com",
    "isAdmin": 0,
    "status": 1,
    "tokenVersion": 0
  }
}
```

**行为**: 校验 email 全局唯一 → 生成 16 位随机密码 BCrypt 加密 → INSERT member → 写 member_role / member_app_group → 构建 `saas:permission:{memberId}` → 审计 `CREATE/MEMBER`

**注意**: 邮件服务 TODO，响应不返回明文密码（需调 resetPassword 获取一次性密码）

**错误**: 409: email 全局已存在

---

### POST `/auth/v1/permission/member/page` — 成员分页

**Request**:
```json
{
  "pageNum": 1,
  "pageSize": 20,
  "companyId": 5001,
  "memberName": "张",
  "email": null,
  "status": 1
}
```

**Response**: `ResultData<Page<MemberMp>>`

---

### GET `/auth/v1/permission/member/detail?memberId=10001` — 成员详情

**Response**: `ResultData<MemberMp>`

---

### POST `/auth/v1/permission/member/update` — 更新成员

**Request**:
```json
{
  "memberId": 10001,
  "memberName": "张三丰",
  "email": "zhangsanfeng@company.com"
}
```

**Response**: `ResultData<MemberMp>`

**错误**: 409: email 全局已存在

---

### POST `/auth/v1/permission/member/delete` — 删除成员

**鉴权**: 仅超管

**Request**:
```json
{ "memberId": 10001, "companyId": 5001, "operatorId": 8001 }
```

**Response**: `ResultData<String>` → `"ok"`

**行为**: 校验无引用 → 解绑 member_role/member_app_group → 删 member → DEL Redis 权限 key → 审计 `DELETE/MEMBER`

**错误**: 412: 被 role/app_group 引用禁删

---

### POST `/auth/v1/permission/member/disable` — 禁用成员

**Request**:
```json
{ "memberId": 10001, "companyId": 5001, "operatorId": 8001, "operatorName": "超管" }
```

**Response**: `"ok"`

**行为**: member.status=0 → DEL Redis 权限 key + 吊销所有 refresh_token → 审计 `UPDATE/MEMBER`

---

### POST `/auth/v1/permission/member/enable` — 启用成员

**Request**: 同 disable

**Response**: `"ok"`

**行为**: member.status=1 → 按现有绑定重建 Redis 权限 key → 审计

---

### POST `/auth/v1/permission/member/resetPassword` — 重置密码

**Request**:
```json
{ "memberId": 10001, "companyId": 5001, "operatorId": 8001, "operatorName": "超管" }
```

**Response**:
```json
{
  "code": 200,
  "msg": "ok",
  "data": { "oneTimePassword": "Ab3$xY9zPq2rLmN8" }
}
```

**行为**: 生成新 16 位密码 BCrypt 加密 → INCR token_version → DEL Redis 权限 key + 吊销所有 refresh_token → 审计

---

## 3. 角色管理

### POST `/auth/v1/permission/role/create`

**Request**:
```json
{ "roleName": "运营", "companyId": 5001, "operatorId": 8001, "operatorName": "超管" }
```

**Response**: `ResultData<RoleMp>` → `{ id, roleName, companyId, isBuiltin: 0 }`

---

### POST `/auth/v1/permission/role/page`

**Request**:
```json
{ "pageNum": 1, "pageSize": 20, "companyId": 5001 }
```

**Response**: `ResultData<Page<RoleMp>>`

---

### GET `/auth/v1/permission/role/detail?roleId=101`

**Response**: `ResultData<RoleMp>`

---

### POST `/auth/v1/permission/role/update`

**Request**: `{ "roleId": 101, "roleName": "运营管理员" }`

**Response**: `ResultData<RoleMp>`

---

### POST `/auth/v1/permission/role/delete`

**Request**: `{ "roleId": 101, "companyId": 5001 }`

**Response**: `"ok"`

**错误**: 412: 被 member_role 引用禁删；`is_builtin=1` 内置角色禁删

---

### POST `/auth/v1/permission/role/resourceGroup/bind` — 角色绑定资源权限组

**Request**:
```json
{
  "roleId": 101,
  "companyId": 5001,
  "operatorId": 8001,
  "operatorName": "超管",
  "resourcePermissionGroupIds": [1, 2]
}
```

**Response**: `"ok"`

**行为**: 写 role_resource_group → 触发该 role 下所有 member 的 `saas:permission:{memberId}.routes` 重建 → 审计 `BIND/ROLE`

---

### POST `/auth/v1/permission/role/resourceGroup/unbind`

**Request**: 同 bind

**Response**: `"ok"`

---

## 4. 应用组管理

### POST `/auth/v1/permission/appGroup/create`

**Request**:
```json
{
  "appGroupName": "应用组A",
  "projectGroupId": 301,
  "projectGroupName": "运营一组",
  "companyId": 5001,
  "operatorId": 8001,
  "operatorName": "超管"
}
```

**Response**: `ResultData<AppGroupMp>`

---

### POST `/auth/v1/permission/appGroup/page`

**Request**:
```json
{
  "pageNum": 1, "pageSize": 20,
  "companyId": 5001, "projectGroupId": 301
}
```

**Response**: `ResultData<Page<AppGroupMp>>`

---

### GET `/auth/v1/permission/appGroup/detail?appGroupId=201`

**Response**: `ResultData<AppGroupMp>`

---

### POST `/auth/v1/permission/appGroup/update`

**Request**: `{ "appGroupId": 201, "appGroupName": "新名称" }`

**Response**: `ResultData<AppGroupMp>`

---

### POST `/auth/v1/permission/appGroup/delete`

**Request**: `{ "appGroupId": 201, "companyId": 5001 }`

**Response**: `"ok"`

**错误**: 412: 被 member_app_group 引用禁删

---

### POST `/auth/v1/permission/appGroup/application/bind` — 应用组绑定应用

**Request**:
```json
{
  "appGroupId": 201,
  "companyId": 5001,
  "operatorId": 8001,
  "operatorName": "超管",
  "applicationIds": ["acme-wow-001", "acme-wow-002"]
}
```

**Response**: `"ok"`

**行为**: Feign 校验 appId 存在 → 写 app_group_application（跨库引用 event_center.app.app_id）→ 触发该 app_group 下所有 member 的 `saas:permission:{memberId}.appIds` 重建 → 审计 `BIND/APP_GROUP`

---

### POST `/auth/v1/permission/appGroup/application/unbind`

**Request**: 同 bind

**Response**: `"ok"`

---

## 5. 项目组管理

### POST `/auth/v1/permission/projectGroup/create`

**Request**:
```json
{ "projectGroupName": "运营一组", "companyId": 5001, "operatorId": 8001, "operatorName": "超管" }
```

**Response**: `ResultData<ProjectGroupMp>`

---

### POST `/auth/v1/permission/projectGroup/page`

**Request**:
```json
{ "pageNum": 1, "pageSize": 20, "companyId": 5001, "projectGroupName": "运营" }
```

**Response**: `ResultData<Page<ProjectGroupMp>>`

---

### GET `/auth/v1/permission/projectGroup/detail?projectGroupId=301`

**Response**: `ResultData<ProjectGroupMp>`

---

### POST `/auth/v1/permission/projectGroup/update`

**Request**: `{ "projectGroupId": 301, "projectGroupName": "新名称", "companyId": 5001 }`

**Response**: `ResultData<ProjectGroupMp>`

---

### POST `/auth/v1/permission/projectGroup/delete`

**Request**: `{ "projectGroupId": 301, "companyId": 5001 }`

**Response**: `"ok"`

**错误**: 412: 被 app_group 引用禁删

---

### POST `/auth/v1/permission/projectGroup/application/bind` — 项目组绑定应用

**Request**:
```json
{ "projectGroupId": 301, "companyId": 5001, "applicationIds": ["app-001", "app-002"] }
```

**Response**: `ResultData<List<String>>`

**行为**: 调 event_center Feign 写 project_group_application（event_center 库）

---

### POST `/auth/v1/permission/projectGroup/application/unbind`

**Request**: 同 bind

**Response**: `"ok"`

---

# 二、Auth 服务 — 平台侧

## 6. 平台登录

### POST `/auth/v1/platform/login`

**Request**:
```json
{ "username": "admin", "password": "admin123" }
```

**Response**:
```json
{
  "code": 200,
  "msg": "ok",
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "jti-uuid",
    "expiresIn": 7200
  }
}
```

---

### POST `/auth/v1/platform/refresh`

**Request**: `{ "refreshToken": "jti-uuid" }`

**Response**: 同 login

---

### POST `/auth/v1/platform/logout`

**Request**: `{ "refreshToken": "jti-uuid" }`

**Response**: `"ok"`

---

## 7. 公司管理

### POST `/auth/v1/platform/company/create` — 创建公司 + bootstrap 首超管

**鉴权**: PLATFORM_OPS / PLATFORM_SALES / PLATFORM_ADMIN

**Request**:
```json
{
  "companyName": "ACME 游戏",
  "firstSuperAdminEmail": "admin@acme.com",
  "firstSuperAdminName": "超管"
}
```

**Response**:
```json
{
  "code": 200,
  "msg": "ok",
  "data": {
    "companyId": 5001,
    "superAdminMemberId": 8001,
    "oneTimePassword": "Ab3$xY9zPq2rLmN8"
  }
}
```

**行为**: 同事务 INSERT company + member(isAdmin=1) → 审计两条（COMPANY/CREATE + MEMBER/CREATE）→ 返回一次性明文密码

**错误**: 409: firstSuperAdminEmail 全局已存在

---

### POST `/auth/v1/platform/company/page`

**Request**: `{ "pageNum": 1, "pageSize": 20 }`

**Response**: `ResultData<Page<CompanyMp>>`

---

### GET `/auth/v1/platform/company/detail?id=5001`

**Response**:
```json
{ "id": 5001, "name": "ACME 游戏", "status": "1" }
```

---

### POST `/auth/v1/platform/company/disable` — 公司软停用

**Request**: `{ "companyId": 5001 }`

**Response**: `"ok"`

**行为**: company.status=0 → 批量 DEL 该公司所有 Redis 权限 key + refresh ZSET → 批量吊销 refresh_token → 审计

---

### POST `/auth/v1/platform/company/enable` — 公司启用

**Request**: `{ "companyId": 5001 }`

**Response**: `"ok"`

**行为**: company.status=1 → 不主动重建 Redis（懒构建，成员下次登录时构建）

---

## 8. 权限点目录

### POST `/auth/v1/platform/permissionDirectory/route/page`

**Request**: `{ "pageNum": 1, "pageSize": 20 }`

**Response**: `ResultData<Page<RoutePermissionMp>>`

---

### GET `/auth/v1/platform/permissionDirectory/route/detail?routeId=1`

**Response**: `ResultData<RoutePermissionMp>`

---

### POST `/auth/v1/platform/permissionDirectory/route/update`

**Request**: RoutePermissionMp 字段

**Response**: `ResultData<RoutePermissionMp>`

---

### GET `/auth/v1/platform/permissionDirectory/scopeChange/impact?routeId=1`

**Response**: 影响范围列表

---

### POST `/auth/v1/platform/permissionDirectory/scopeChange/execute`

**Request**: `{ "routeId": 1, "fromScope": "COMPANY", "toScope": "PROJECT" }`

**Response**: 执行结果

---

### POST `/auth/v1/platform/permissionDirectory/route/batchEnable`

**Request**: `{ "routeIds": [1, 2, 3] }`

**Response**: `"ok"`

---

### POST `/auth/v1/platform/permissionDirectory/function/page`

**Request**: `{ "pageNum": 1, "pageSize": 20 }`

**Response**: `ResultData<Page<FunctionPermissionMp>>`

---

### GET `/auth/v1/platform/permissionDirectory/function/detail?functionId=1`

**Response**: `ResultData<FunctionPermissionMp>`

---

### POST `/auth/v1/platform/permissionDirectory/function/create`

**Request**: FunctionPermissionMp 字段

**Response**: `ResultData<FunctionPermissionMp>`

---

### POST `/auth/v1/platform/permissionDirectory/function/update`

**Request**: FunctionPermissionMp 字段

**Response**: `ResultData<FunctionPermissionMp>`

---

### POST `/auth/v1/platform/permissionDirectory/function/delete`

**Request**: `{ "functionId": 1 }`

**Response**: `"ok"`

---

## 9. 审计日志

### POST `/auth/v1/platform/auditLog/page`

**Request**:
```json
{
  "pageNum": 1,
  "pageSize": 20,
  "targetType": "MEMBER",
  "action": "CREATE",
  "startTime": 1720000000000,
  "endTime": 1721000000000
}
```

**Response**: `ResultData<Page<PermissionAuditLogMp>>`

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Long | 雪花 ID |
| companyId | Long | 所属公司 |
| operatorId | Long | 操作人 ID |
| operatorType | String | PLATFORM / COMPANY / SYSTEM |
| operatorName | String | 操作人名称 |
| action | String | CREATE / UPDATE / DELETE / BIND / UNBIND / LOGIN |
| targetType | String | COMPANY / MEMBER / ROLE / APP_GROUP / PROJECT_GROUP / APPLICATION / PRODUCT |
| targetId | Long | 操作对象 ID |
| beforeValue | String(JSON) | 变更前值 |
| afterValue | String(JSON) | 变更后值 |
| createdTime | DateTime | 记录时间 |

---

# 三、Event Center 服务

## 10. 应用管理

### POST `/event/center/app/create` — 创建应用

**Request**:
```json
{
  "appName": "王者荣耀-微信",
  "packageName": "com.tencent.wxgame",
  "companyId": 5001,
  "projectId": 301
}
```

**Response**:
```json
{
  "code": 200,
  "msg": "ok",
  "data": {
    "appId": "acme-wow-001",
    "appName": "王者荣耀-微信",
    "packageName": "com.tencent.wxgame",
    "accessToken": "AT_yyy...",
    "companyId": 5001,
    "projectId": 301
  }
}
```

**行为**: 生成 16 位 appId + 64 位 accessToken → INSERT app → 写 Redis `access_token:{token}` + `event:app:config:{appId}` Hash（永久 TTL）

---

### POST `/event/center/app/disable`

**Request**: `?appId=acme-wow-001`（RequestParam）

**Response**: `"ok"`

**行为**: app.status=0 → DEL Redis 两个 key

---

### POST `/event/center/app/enable`

**Request**: `?appId=acme-wow-001`

**Response**: `"ok"`

**行为**: app.status=1 → 重写 Redis Hash

---

### GET `/event/center/app/list?companyId=5001&projectId=301`

**Response**: `ResultData<List<AppListResponse>>`

---

### GET `/event/center/app/detail?appId=acme-wow-001`

**Response**: `ResultData<AppMp>`

---

### POST `/event/center/app/update`

**Request**:
```json
{
  "appId": "acme-wow-001",
  "appName": "新名称",
  "packageName": "com.new.pkg",
  "companyId": 5001,
  "projectId": 301
}
```

**Response**: `ResultData<AppMp>`

**行为**: 更新 DB → 刷新 Redis `event:app:config:{appId}` Hash

---

### POST `/event/center/app/delete`

**Request**: `?appId=acme-wow-001`

**Response**: `"ok"`

**行为**: DEL Redis → 删 DB

---

## 11. 产品管理

### POST `/event/center/product/create`

**Request**:
```json
{
  "productName": "王者荣耀",
  "productTypeId": 1001,
  "productTypeName": "游戏",
  "companyId": 5001
}
```

**Response**: `ResultData<ProductMp>` → `{ id, productName, productTypeId, productTypeName, companyId, status: 1 }`

---

### POST `/event/center/product/page`

**Request**: `{ "pageNum": 1, "pageSize": 20 }`

**Response**: `ResultData<Page<ProductMp>>`

---

### GET `/event/center/product/detail?productId=9001`

**Response**: `ResultData<ProductMp>`

---

### POST `/event/center/product/update`

**Request**:
```json
{
  "productId": 9001,
  "productName": "新名称",
  "productTypeId": 1001,
  "productTypeName": "游戏"
}
```

**Response**: `ResultData<ProductMp>`

---

### POST `/event/center/product/delete`

**Request**: `{ "productId": 9001 }`

**Response**: `"ok"`

**错误**: 412: 产品下有 app 引用禁删

---

## 12. 项目组-应用关联

### POST `/event/center/projectGroupApplication/bind`

**Request**:
```json
{
  "projectGroupId": 301,
  "companyId": 5001,
  "applicationIds": ["acme-wow-001", "acme-wow-002"]
}
```

**Response**: `ResultData<List<ProjectGroupApplicationMp>>`

---

### POST `/event/center/projectGroupApplication/unbind`

**Request**: `{ "projectGroupId": 301, "applicationIds": ["acme-wow-001"] }`

**Response**: `"ok"`

---

### GET `/event/center/projectGroupApplication/listByProjectGroup?projectGroupId=301`

**Response**: `ResultData<List<ProjectGroupApplicationMp>>`

---

# 四、数据模型

## 核心实体字段

### MemberMp

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Long | 雪花主键 |
| companyId | Long | 所属公司 |
| memberName | String | 成员名称 |
| email | String | 全局唯一邮箱 |
| password | String | BCrypt 加密 |
| isAdmin | Integer | 0=普通, 1=超管(bypass) |
| status | Integer | 0=禁用, 1=启用 |
| tokenVersion | Long | 改密码时 INCR |

### RoleMp

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Long | 雪花主键 |
| companyId | Long | 所属公司 |
| roleName | String | 角色名称 |
| isBuiltin | Integer | 0=普通, 1=内置不可删 |

### AppGroupMp

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Long | 雪花主键 |
| companyId | Long | 所属公司 |
| projectGroupId | Long | 所属项目组 |
| projectGroupName | String | 项目组名（冗余） |
| appGroupName | String | 应用组名 |

### ProjectGroupMp

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Long | 雪花主键 |
| companyId | Long | 所属公司 |
| projectGroupName | String | 项目组名 |

### AppGroupApplicationMp

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Long | 雪花主键 |
| companyId | Long | 所属公司 |
| appGroupId | Long | 应用组 ID |
| applicationId | String | 跨库引用 event_center.app.app_id |

### AppMp

| 字段 | 类型 | 说明 |
|------|------|------|
| appId | String | 应用 ID（业务主键） |
| appName | String | 应用名称 |
| packageName | String | 包名 |
| accessToken | String | SDK 上报 token |
| appKey | String | 系统生成（V3.1） |
| productId | Long | 所属产品（V3.1） |
| platformId | Long | 平台 ID（V3.1） |
| status | Integer | 0=停用, 1=启用 |
| companyId | Long | 所属公司 |
| scope | String | CSV 作用域 |

### ProductMp

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Long | 雪花主键 |
| companyId | Long | 所属公司 |
| productName | String | 游戏名称 |
| productTypeId | Long | 引用 system_enum |
| productTypeName | String | 类型名（冗余） |
| status | Integer | 0=停用, 1=启用 |

---

# 五、权限变更触发 Redis 刷新约定

| 操作 | 影响成员范围 | Redis 刷新动作 |
|------|------------|--------------|
| role.resourceGroup.bind/unbind | 该 role 下所有 member | 重建 `saas:permission:{memberId}.routes` |
| member.role.bind/unbind | 该 member | 重建 `.routes` |
| appGroup.application.bind/unbind | 该 appGroup 下所有 member | 重建 `.appIds` |
| member.appGroup.bind/unbind | 该 member | 重建 `.appIds` |
| member.disable | 该 member | DEL `saas:permission:{memberId}` |
| member.delete | 该 member | DEL `saas:permission:{memberId}` |
| member.resetPassword | 该 member | DEL + INCR `saas:token:version` |
| company.disable | 该公司所有 member | 批量 DEL 权限 key + ZSET |
| route_permission.status=0 | 所有引用该 route 的 member | 批量重建 routes |

---

# 六、TODO（未实现）

| 项 | 说明 | 替代方案 |
|----|------|---------|
| 邮件服务 | 成员创建/重置密码邮件直发 | 接口返回一次性明文密码，管理员手动转交 |
| ES 日志迁移 | 审计日志永久落 MySQL | 当前按时间分区管理，后续切 ES |
| event-sdk 完整改造 | 直读 Redis + fail-open | 已实现 AppConfigCacheService + 60s 刷新 + 磁盘快照 |
