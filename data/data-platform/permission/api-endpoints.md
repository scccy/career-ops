# Auth V1 API 合约文档（实际代码版本）

> 基于当前运行代码，与前端确定的接口。修改时**不可变更**响应字段。

## 统一响应格式

```json
{
  "code": 200,
  "data": <T>,
  "message": "SUCCESS"
}
```

路由前缀：Controller 使用 `/v1/...`，Gateway 拼接 `/auth` 前缀后对外暴露 `/auth/v1/...`。

---

## 0. 平台管理端

### 0.1 平台管理员登入

```
POST /v1/platform/login
```

**Request:**
```json
{"username": "platform_admin", "password": "admin"}
```

**Response `data`:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "placeholder",
  "expiresIn": 7200,
  "userId": 1,
  "displayName": "测试1",
  "roles": ["PLATFORM_ADMIN"]
}
```

### 0.2 平台刷新

```
POST /v1/platform/refresh
```

**Response `data`:** `{"accessToken": "refreshed", "refreshToken": "new-refresh", "expiresIn": 7200}`

### 0.3 平台登出

```
POST /v1/platform/logout
{"refreshToken": "..."}
```

**Response `data`:** `"ok"`

### 0.4 创建企业

```
POST /v1/platform/company/create
Authorization: Bearer <platform_token>
```

**Request:**
```json
{
  "companyName": "测试公司",
  "firstSuperAdminEmail": "admin@acme.com",
  "firstSuperAdminName": "测试管理员"
}
```

**Response `data`:**
```json
{
  "companyId": 2077300471172724000,
  "companyAdminMemberId": 2077300471172725000,
  "oneTimePassword": "abc123def456ghij"
}
```

**后端编排**：创建公司 → 从模板扩散角色+资源点 → 创建企业管理员 → 返回 `companyId` + `oneTimePassword`

### 0.5 企业分页

```
POST /v1/platform/company/page
```

**Request:** `BasePageQuery`（`pageNum`, `pageSize`）

### 0.6 企业详情

```
GET /v1/platform/company/detail?id=<companyId>
```

**Response `data`:** `{"id": <id>, "name": "<name>", "status": <status>}`

### 0.7 禁用/启用企业

```
POST /v1/platform/company/disable  {"companyId": <id>}
POST /v1/platform/company/enable   {"companyId": <id>}
```

---

## 1. 企业成员端

### 1.1 企业成员登入

```
POST /v1/login
```

**Request:**
```json
{"email": "admin@acme.com", "password": "abc123def456ghij"}
```

**Response `data`:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "<jti-uuid>",
  "expiresIn": 7200,
  "companyId": 2077300471172724000,
  "permissions": [
    "FUNCTION:PANEL",
    "FUNCTION:DATA",
    "FUNCTION:KANBAN"
  ]
}
```

> `permissions` 为 `function_permission.code` 数组，前端据此控制菜单/按钮可见性。

### 1.2 刷新 Token

```
POST /v1/refresh
Authorization: Bearer <access_token>
```

**Request:**
```json
{"refreshToken": "<jti>"}
```

**Response `data`:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "<new_jti>",
  "expiresIn": 7200
}
```

### 1.3 登出

```
POST /v1/logout
Authorization: Bearer <access_token>
```

**Request:**
```json
{"refreshToken": "<jti>"}
```

**Response `data`:** `"ok"`

### 1.4 获取当前用户权限

```
GET /v1/permission/mine
Authorization: Bearer <access_token>
```

**Response `data`:**
```json
["FUNCTION:PANEL", "FUNCTION:DATA", "FUNCTION:KANBAN"]
```

---

## 2. 成员管理

### 2.1 创建成员

```
POST /v1/permission/member/create
```

**Request:**
```json
{
  "memberName": "张三",
  "email": "zhangsan@acme.com",
  "companyId": 2077300471172724000,
  "operatorId": 1,
  "operatorName": "admin",
  "roleIds": [2077300471172724000],
  "appGroupIds": null
}
```

**Response `data`:**
```json
{
  "memberId": 2077300471172726000,
  "email": "zhangsan@acme.com",
  "oneTimePassword": "abc123def456ghij"
}
```

### 2.2 成员分页

```
POST /v1/permission/member/page
```

**Request:**
```json
{
  "pageNum": 1,
  "pageSize": 20,
  "companyId": 2077300471172724000,
  "memberName": null,
  "email": null,
  "status": null
}
```

### 2.3 成员详情

```
GET /v1/permission/member/detail?memberId=<id>
```

**Response `data`:** `MemberMp` 实体

### 2.4 更新成员

```
POST /v1/permission/member/update
```

**Request:**
```json
{"memberId": <id>, "memberName": "新名称", "email": "new@acme.com"}
```

### 2.5 删除成员

```
POST /v1/permission/member/delete
```

**Request:**
```json
{"memberId": <id>, "companyId": <id>, "operatorId": <id>}
```

### 2.6 禁用/启用成员

```
POST /v1/permission/member/disable
POST /v1/permission/member/enable
```

**Request:**
```json
{"memberId": <id>, "companyId": <id>, "operatorId": <id>, "operatorName": "xxx"}
```

### 2.7 重置密码

```
POST /v1/permission/member/resetPassword
```

**Request:**
```json
{"memberId": <id>, "companyId": <id>, "operatorId": <id>, "operatorName": "xxx"}
```

**Response `data`:**
```json
{"oneTimePassword": "abc123def456ghij"}
```

---

## 3. 角色管理

### 3.1 创建角色

```
POST /v1/permission/role/create
```

**Request:**
```json
{
  "roleName": "数据分析师",
  "companyId": 2077300471172724000,
  "operatorId": 1,
  "operatorName": "admin"
}
```

### 3.2 角色分页

```
POST /v1/permission/role/page
```

**Request:**
```json
{"pageNum": 1, "pageSize": 20, "companyId": 2077300471172724000}
```

### 3.3 角色详情

```
GET /v1/permission/role/detail?roleId=<id>
```

**Response `data`:** `RoleMp` 实体

### 3.4 更新角色

```
POST /v1/permission/role/update
```

**Request:**
```json
{"roleId": <id>, "roleName": "新名称"}
```

### 3.5 删除角色

```
POST /v1/permission/role/delete
```

**Request:**
```json
{"roleId": <id>, "companyId": <id>}
```

### 3.6 绑定资源权限组

```
POST /v1/permission/role/resourceGroup/bind
```

**Request:**
```json
{
  "roleId": 2077300471172724000,
  "companyId": 2077300471172724000,
  "operatorId": 1,
  "operatorName": "admin",
  "resourcePermissionGroupIds": [2077300471172723000, 2077300471172723001]
}
```

### 3.7 解绑资源权限组

```
POST /v1/permission/role/resourceGroup/unbind
```

**Request:**
```json
{
  "roleId": 2077300471172724000,
  "resourcePermissionGroupIds": [2077300471172723000]
}
```

---

## 端点汇总

| # | Path | Method | 说明 |
|---|------|--------|------|
| 1 | `/v1/platform/login` | POST | 平台登入 |
| 2 | `/v1/platform/refresh` | POST | 平台刷新 |
| 3 | `/v1/platform/logout` | POST | 平台登出 |
| 4 | `/v1/platform/company/create` | POST | 创建企业 |
| 5 | `/v1/platform/company/page` | POST | 企业分页 |
| 6 | `/v1/platform/company/detail` | GET | 企业详情 |
| 7 | `/v1/platform/company/disable` | POST | 禁用企业 |
| 8 | `/v1/platform/company/enable` | POST | 启用企业 |
| 9 | `/v1/login` | POST | 企业成员登入 |
| 10 | `/v1/refresh` | POST | 刷新 Token |
| 11 | `/v1/logout` | POST | 登出 |
| 12 | `/v1/permission/mine` | GET | 当前用户权限 |
| 13 | `/v1/permission/member/create` | POST | 创建成员 |
| 14 | `/v1/permission/member/page` | POST | 成员分页 |
| 15 | `/v1/permission/member/detail` | GET | 成员详情 |
| 16 | `/v1/permission/member/update` | POST | 更新成员 |
| 17 | `/v1/permission/member/delete` | POST | 删除成员 |
| 18 | `/v1/permission/member/disable` | POST | 禁用成员 |
| 19 | `/v1/permission/member/enable` | POST | 启用成员 |
| 20 | `/v1/permission/member/resetPassword` | POST | 重置密码 |
| 21 | `/v1/permission/role/create` | POST | 创建角色 |
| 22 | `/v1/permission/role/page` | POST | 角色分页 |
| 23 | `/v1/permission/role/detail` | GET | 角色详情 |
| 24 | `/v1/permission/role/update` | POST | 更新角色 |
| 25 | `/v1/permission/role/delete` | POST | 删除角色 |
| 26 | `/v1/permission/role/resourceGroup/bind` | POST | 绑定资源权限组 |
| 27 | `/v1/permission/role/resourceGroup/unbind` | POST | 解绑资源权限组 |

**已实现**: 27 个端点

---

## 关键约束

1. **`company_id` 必传**：SaaS 多租户，`member`、`role`、`member_role`、`resource_permission_group`、`role_resource_group` 均带 `company_id`
2. **`permissions` 字段**：登入返回的 `permissions` 数组为 `function_permission.code` 列表，前端据此控制 UI
3. **路径前缀**：Controller 写 `/v1/...`，Gateway context-path `/auth` 自动拼接为 `/auth/v1/...`
4. **响应包装**：统一 `ResultData<T>` 即 `{code, message, data}`