# qpointplay_auth 数据模型审计

> 日期：2026-07-13
> 数据库：`qpointplay_auth`
> 新系统：非 `system_` 前缀的表（22 张）
> 旧系统：`system_` 前缀的表（5 张，不再使用）

---

## 一、新旧系统划分

### 新系统（22 张表，非 system 前缀）

| # | 表名 | 类型 | 行数 | 说明 |
|---|------|------|------|------|
| 1 | `app` | 普通表 | 148 | SDK 应用注册（从旧系统迁移） |
| 2 | `company` | 普通表 | 13 | 公司/租户 |
| 3 | `company_user` | 普通表 | 20 | 公司员工 |
| 4 | `company_user_role` | M:N 关联 | 5 | 用户→公司级角色 |
| 5 | `data_permission_group` | 普通表 | 8 | 数据权限组 |
| 6 | `data_permission_rule` | 普通表 | 5 | 数据权限规则（统一存储） |
| 7 | `function_permission` | 普通表 | 37 | 功能权限点目录 |
| 8 | `permission_audit_log` | 日志表 | 100 | 权限变更审计 |
| 9 | `platform_role` | 普通表 | 3 | 平台角色 |
| 10 | `platform_role_permission` | M:N 关联 | 0 | 平台角色→路由 |
| 11 | `platform_user` | 普通表 | 3 | 平台用户 |
| 12 | `platform_user_role` | M:N 关联 | 1 | 平台用户→角色 |
| 13 | `project` | 普通表 | 1 | 项目 |
| 14 | `project_member` | M:N 关联 | 2 | 项目成员（当前 1 用户 1 角色） |
| 15 | `refresh_token` | 普通表 | 14 | 登录刷新令牌 |
| 16 | `resource_group_permission_item` | 1:N 明细 | 253 | 资源权限组明细 |
| 17 | `resource_permission_group` | 普通表 | 31 | 资源权限组 |
| 18 | `role` | 普通表 | 53 | 角色（COMPANY/PROJECT） |
| 19 | `role_data_group` | M:N 关联 | 0 | 角色→数据权限组 |
| 20 | `role_function_permission` | 普通表 | 88 | 内置角色→功能权限模板（全局） |
| 21 | `role_resource_group` | M:N 关联 | 17 | 角色→资源权限组 |
| 22 | `route_permission` | 普通表 | 101 | 路由权限点目录 |

### 旧系统（5 张表，system_ 前缀，不再使用）

| # | 表名 | 行数 | 说明 |
|---|------|------|------|
| 1 | `system_enum_dict` | 58 | 枚举字典 |
| 2 | `system_permission_group` | 6 | 旧权限组 |
| 3 | `system_permission_rule` | 2291 | 旧权限规则 |
| 4 | `system_platform_user_account` | 31 | 旧平台用户 |
| 5 | `system_user_group_rel` | 46 | 旧用户-组关联 |

---

## 二、实体-表映射

| 实体类 | 表名 | 状态 |
|--------|------|------|
| `CompanyMp` | `company` | 正常 |
| `CompanyUserMp` | `company_user` | 正常 |
| `CompanyUserRoleMp` | `company_user_role` | 正常 |
| `DataPermissionGroupMp` | `data_permission_group` | 正常 |
| `DataPermissionRuleMp` | `data_permission_rule` | 正常 |
| `FunctionPermissionMp` | `function_permission` | 正常 |
| `PermissionAuditLogMp` | `permission_audit_log` | 正常 |
| `PlatformRoleMp` | `platform_role` | 正常 |
| `PlatformRolePermissionMp` | `platform_role_permission` | 正常 |
| `PlatformUserMp` | `platform_user` | 正常 |
| `PlatformUserRoleMp` | `platform_user_role` | 正常 |
| `ProjectMp` | `project` | 正常 |
| `ProjectMemberMp` | `project_member` | 正常 |
| `RefreshTokenMp` | `refresh_token` | 正常 |
| `ResourceGroupPermissionItemMp` | `resource_group_permission_item` | 正常 |
| `ResourcePermissionGroupMp` | `resource_permission_group` | 正常 |
| `RoleMp` | `role` | 正常 |
| `RoleDataGroupMp` | `role_data_group` | 正常 |
| `RoleResourceGroupMp` | `role_resource_group` | 正常 |
| `RoutePermissionMp` | `route_permission` | 正常 |
| `RoleFunctionTemplateMp` | `role_function_permission` | ⚠️ 类名不匹配 |
| `ProjectMemberRoleMp` | `project_member_role` | ❌ 表不存在 |
| `RoleProjectMp` | `role_project` | ❌ 表不存在 |

旧系统实体（映射到 system_ 表，不再使用）：

| 实体类 | 表名 | 说明 |
|--------|------|------|
| `DimPermissionGroupMp` | `system_permission_group` | 旧系统，命名混乱 |
| `DimPermissionRuleMp` | `system_permission_rule` | 旧系统，命名混乱 |
| `DimUserGroupRelMp` | `system_user_group_rel` | 旧系统，命名混乱 |
| `SystemEnumDictMp` | `system_enum_dict` | 旧系统 |
| `SystemPlatformUserAccountMp` | `system_platform_user_account` | 旧系统 |

`AppMp` 在 `common` 模块，不在 auth 的 `domain/mp` 下。

---

## 三、完整建表模型

### 3.1 平台层

#### platform_user（平台用户）

```sql
CREATE TABLE `platform_user` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `username` varchar(64) NOT NULL COMMENT '用户名，UK',
  `password_hash` varchar(256) NOT NULL COMMENT 'BCrypt 哈希',
  `display_name` varchar(64) NOT NULL COMMENT '显示名称',
  `status` varchar(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / DISABLED',
  `token_version` int NOT NULL DEFAULT '0' COMMENT '令牌版本，递增使旧 JWT 失效',
  `last_login_time` datetime DEFAULT NULL COMMENT '最后登录时间',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='平台用户';
```

#### platform_role（平台角色，固定 3 个）

```sql
CREATE TABLE `platform_role` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `code` varchar(64) NOT NULL COMMENT '角色编码，UK',
  `name` varchar(64) NOT NULL COMMENT '角色名称',
  `description` varchar(256) DEFAULT NULL COMMENT '描述',
  `builtin` tinyint NOT NULL DEFAULT '0' COMMENT '1=预置不可删除',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='平台角色';
```

预置数据：`PLATFORM_ADMIN`、`PLATFORM_OPS`、`PLATFORM_SALES`

#### platform_user_role（平台用户→角色）

```sql
CREATE TABLE `platform_user_role` (
  `id` bigint NOT NULL COMMENT '主键',
  `user_id` bigint NOT NULL COMMENT '平台用户 ID',
  `role_id` bigint NOT NULL COMMENT '平台角色 ID',
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_role` (`user_id`,`role_id`),
  KEY `idx_role_id` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='平台用户-角色';
```

#### platform_role_permission（平台角色→路由权限点）

```sql
CREATE TABLE `platform_role_permission` (
  `id` bigint NOT NULL COMMENT '主键',
  `role_id` bigint NOT NULL COMMENT '平台角色 ID',
  `permission_id` bigint NOT NULL COMMENT 'route_permission.id（scope=PLATFORM）',
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_permission` (`role_id`,`permission_id`),
  KEY `idx_permission_id` (`permission_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='平台角色-权限点';
```

> ⚠️ 当前 0 行数据。平台登录走 `aggregateRoutesForPlatform()` 聚合全量平台路由，未使用此表。

---

### 3.2 公司层

#### company（公司）

```sql
CREATE TABLE `company` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `name` varchar(128) NOT NULL COMMENT '公司名称',
  `code` varchar(64) NOT NULL COMMENT '公司编码，UK',
  `status` varchar(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / DISABLED',
  `license_expire_time` datetime DEFAULT NULL COMMENT 'License 到期时间',
  `created_by` varchar(64) NOT NULL COMMENT '创建人（平台销售 ID）',
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`),
  KEY `idx_status` (`status`),
  KEY `idx_created_by` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公司';
```

#### company_user（公司员工）

```sql
CREATE TABLE `company_user` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `company_id` bigint NOT NULL COMMENT '所属公司 ID',
  `company_name` varchar(128) NOT NULL COMMENT '冗余公司名称',
  `email` varchar(128) NOT NULL COMMENT '邮箱，全局唯一（跨公司），登录用',
  `username` varchar(64) DEFAULT NULL COMMENT '用户名（显示用）',
  `password_hash` varchar(256) NOT NULL COMMENT 'BCrypt 哈希',
  `display_name` varchar(64) NOT NULL COMMENT '显示名称',
  `is_admin` tinyint NOT NULL DEFAULT '0' COMMENT '1=公司管理员，JWT bypass',
  `status` varchar(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / DISABLED',
  `token_version` int NOT NULL DEFAULT '0' COMMENT '令牌版本',
  `last_login_time` datetime DEFAULT NULL COMMENT '最后登录时间',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_email` (`email`),
  KEY `idx_company_id` (`company_id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公司员工';
```

#### company_user_role（用户→公司级角色）

```sql
CREATE TABLE `company_user_role` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `user_id` bigint NOT NULL COMMENT 'company_user.id',
  `role_id` bigint NOT NULL COMMENT 'role.id',
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_role` (`user_id`,`role_id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_role_id` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公司用户-角色';
```

> 用于非管理员用户绑定公司级角色。管理员（`is_admin=1`）不走此表，JWT bypass。

#### project（项目）

```sql
CREATE TABLE `project` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `company_id` bigint NOT NULL COMMENT '所属公司 ID',
  `company_name` varchar(128) NOT NULL COMMENT '冗余公司名称',
  `name` varchar(128) NOT NULL COMMENT '项目名称',
  `description` varchar(256) DEFAULT NULL COMMENT '描述',
  `status` varchar(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / ARCHIVED',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_company_id` (`company_id`),
  KEY `idx_company_status` (`company_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目';
```

#### project_member（项目成员，当前版本）

```sql
CREATE TABLE `project_member` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `project_id` bigint NOT NULL COMMENT '项目 ID',
  `project_name` varchar(128) NOT NULL COMMENT '冗余项目名称',
  `user_id` bigint NOT NULL COMMENT '员工 ID（company_user.id）',
  `user_name` varchar(64) NOT NULL COMMENT '冗余员工显示名',
  `company_id` bigint NOT NULL COMMENT '冗余公司 ID（用于跨公司校验）',
  `role_id` bigint NOT NULL COMMENT '角色 ID',
  `role_name` varchar(64) NOT NULL COMMENT '冗余角色名称',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_project_user` (`project_id`,`user_id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_company_id` (`company_id`),
  KEY `idx_role_id` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目成员';
```

> ⚠️ `uk_project_user (project_id, user_id)` 限制了一个用户在一个项目中只能有一个角色。需要改为支持多角色，见下方「待改造」章节。

#### project_member_role（项目成员→角色，待建表）

```sql
CREATE TABLE `project_member_role` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `project_member_id` bigint NOT NULL COMMENT 'project_member.id',
  `role_id` bigint NOT NULL COMMENT 'role.id',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_member_role` (`project_member_id`,`role_id`),
  KEY `idx_role_id` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目成员-角色多对多';
```

> 实体类 `ProjectMemberRoleMp` 已存在，但表尚未创建。改造后 `project_member` 去掉 `role_id` 和 `role_name`，角色通过此表关联。

---

### 3.3 角色

#### role（角色，scope=COMPANY/PROJECT）

```sql
CREATE TABLE `role` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `company_id` bigint NOT NULL COMMENT '所属公司 ID',
  `company_name` varchar(128) NOT NULL COMMENT '冗余公司名称',
  `project_id` bigint NOT NULL DEFAULT '0' COMMENT '所属项目 ID（scope=PROJECT 时非 0）',
  `project_name` varchar(128) DEFAULT NULL COMMENT '冗余项目名称',
  `scope` varchar(16) NOT NULL DEFAULT 'COMPANY' COMMENT 'COMPANY / PROJECT',
  `code` varchar(64) NOT NULL COMMENT '角色编码',
  `name` varchar(64) NOT NULL COMMENT '角色名称',
  `description` varchar(256) DEFAULT NULL COMMENT '描述',
  `builtin` tinyint NOT NULL DEFAULT '0' COMMENT '1=基础角色，防删除',
  `scope_company_key` bigint GENERATED ALWAYS AS (
    (case when (`scope` = 'COMPANY') then `company_id` else NULL end)
  ) STORED,
  `scope_project_key` bigint GENERATED ALWAYS AS (
    (case when (`scope` = 'PROJECT') then `project_id` else NULL end)
  ) STORED,
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_scope_company` (`code`,`scope_company_key`),
  UNIQUE KEY `uk_scope_project` (`code`,`scope_project_key`),
  KEY `idx_company_id` (`company_id`),
  KEY `idx_project_id` (`project_id`),
  KEY `idx_scope` (`scope`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色（scope=COMPANY/PROJECT）';
```

Generated Column 保证：
- `scope=COMPANY` 时 `(code, company_id)` 唯一，`scope_project_key` 为 NULL
- `scope=PROJECT` 时 `(code, project_id)` 唯一，`scope_company_key` 为 NULL

内置角色编码：`COMPANY_ADMIN`、`PROJECT_MANAGER`、`OPS`、`ANALYST`、`MEMBER`

#### role_project（角色→项目，scope=COMPANY 时可绑多个项目，待建表）

```sql
CREATE TABLE `role_project` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `role_id` bigint NOT NULL COMMENT 'role.id（scope=COMPANY）',
  `project_id` bigint NOT NULL COMMENT 'project.id',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_project` (`role_id`,`project_id`),
  KEY `idx_project_id` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色-项目关联';
```

> 实体类 `RoleProjectMp` 已存在，但表尚未创建。用于 scope=COMPANY 的角色绑定到多个项目。

---

### 3.4 权限点目录

#### route_permission（路由权限点目录）

```sql
CREATE TABLE `route_permission` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `code` varchar(128) NOT NULL COMMENT '权限点编码，UK（格式 METHOD /path）',
  `name` varchar(128) NOT NULL COMMENT '权限点名称',
  `scope` varchar(16) NOT NULL DEFAULT 'PROJECT' COMMENT 'PLATFORM / COMPANY / PROJECT',
  `module` varchar(32) DEFAULT NULL COMMENT '所属模块',
  `path` varchar(256) NOT NULL COMMENT '路由路径',
  `method` varchar(8) NOT NULL COMMENT 'GET / POST',
  `status` varchar(16) NOT NULL DEFAULT 'DISABLED' COMMENT 'ENABLED / DISABLED',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`),
  KEY `idx_module` (`module`),
  KEY `idx_scope` (`scope`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='路由权限点目录';
```

#### function_permission（功能权限点目录）

```sql
CREATE TABLE `function_permission` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `code` varchar(128) NOT NULL COMMENT '权限点编码（如 FUNCTION:DASHBOARD:CREATE），UK',
  `name` varchar(128) NOT NULL COMMENT '权限点名称',
  `scope` varchar(16) NOT NULL DEFAULT 'PROJECT' COMMENT 'COMPANY / PROJECT',
  `module` varchar(32) DEFAULT NULL COMMENT '所属模块',
  `status` varchar(16) NOT NULL DEFAULT 'ENABLED' COMMENT 'ENABLED / DISABLED',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`),
  KEY `idx_module` (`module`),
  KEY `idx_scope` (`scope`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='功能权限点目录';
```

---

### 3.5 资源权限

#### resource_permission_group（资源权限组）

```sql
CREATE TABLE `resource_permission_group` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `company_id` bigint NOT NULL COMMENT '所属公司 ID',
  `company_name` varchar(128) NOT NULL COMMENT '冗余公司名称',
  `name` varchar(64) NOT NULL COMMENT '权限组名称',
  `description` varchar(256) DEFAULT NULL COMMENT '描述',
  `enabled` tinyint NOT NULL DEFAULT '1' COMMENT '1=启用',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_company_id` (`company_id`),
  KEY `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='资源权限组';
```

#### resource_group_permission_item（资源权限组明细，多态）

```sql
CREATE TABLE `resource_group_permission_item` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `group_id` bigint NOT NULL COMMENT '资源权限组 ID',
  `permission_id` bigint NOT NULL COMMENT '权限点 ID（route_permission 或 function_permission）',
  `permission_code` varchar(128) NOT NULL COMMENT '冗余权限点编码',
  `permission_type` varchar(16) NOT NULL COMMENT 'ROUTE / FUNCTION',
  `permission_scope` varchar(16) NOT NULL COMMENT 'PLATFORM / COMPANY / PROJECT',
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_group_permission` (`group_id`,`permission_id`),
  KEY `idx_permission_id` (`permission_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='资源权限组明细';
```

#### role_resource_group（角色→资源权限组）

```sql
CREATE TABLE `role_resource_group` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `role_id` bigint NOT NULL COMMENT '角色 ID（role.id）',
  `group_id` bigint NOT NULL COMMENT '资源权限组 ID',
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_group` (`role_id`,`group_id`),
  KEY `idx_group_id` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色-资源权限组';
```

---

### 3.6 数据权限

#### data_permission_group（数据权限组）

```sql
CREATE TABLE `data_permission_group` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `company_id` bigint NOT NULL COMMENT '所属公司 ID',
  `company_name` varchar(128) NOT NULL COMMENT '冗余公司名称',
  `name` varchar(64) NOT NULL COMMENT '权限组名称',
  `description` varchar(256) DEFAULT NULL COMMENT '描述',
  `enabled` tinyint NOT NULL DEFAULT '1' COMMENT '1=启用',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_company_id` (`company_id`),
  KEY `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='数据权限组';
```

#### data_permission_rule（数据权限规则，统一存储）

```sql
CREATE TABLE `data_permission_rule` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `owner_type` varchar(16) NOT NULL COMMENT 'GROUP（组规则）/ USER（员工额外规则）',
  `owner_id` bigint NOT NULL COMMENT '组 ID 或 user ID',
  `project_id` bigint NOT NULL DEFAULT '0' COMMENT 'GROUP 时为 0；USER 时为实际项目 ID',
  `resource_type` varchar(32) NOT NULL COMMENT 'MINIGAME / PACKAGE / CHANNEL / APP',
  `resource_value` varchar(128) NOT NULL COMMENT '资源值（数字 ID 或字符串）',
  `created_by` varchar(64) DEFAULT NULL,
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_owner_rule` (`owner_type`,`owner_id`,`project_id`,`resource_type`,`resource_value`),
  KEY `idx_owner` (`owner_type`,`owner_id`),
  KEY `idx_project_id` (`project_id`),
  KEY `idx_resource_type` (`resource_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='数据权限规则（统一存储）';
```

#### role_data_group（角色→数据权限组）

```sql
CREATE TABLE `role_data_group` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `role_id` bigint NOT NULL COMMENT '角色 ID',
  `group_id` bigint NOT NULL COMMENT '数据权限组 ID',
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_group` (`role_id`,`group_id`),
  KEY `idx_group_id` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色-数据权限组';
```

> ⚠️ 当前 0 行数据。角色数据权限可能尚未走此路径。

---

### 3.7 角色-功能权限模板

#### role_function_permission（内置角色→功能权限模板，全局）

```sql
CREATE TABLE `role_function_permission` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `role_code` varchar(64) NOT NULL COMMENT '内置角色编码（COMPANY_ADMIN/PROJECT_MANAGER/OPS/ANALYST/MEMBER）',
  `function_code` varchar(128) NOT NULL COMMENT '功能权限点编码（function_permission.code）',
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_by` varchar(64) DEFAULT NULL,
  `updated_by` varchar(64) DEFAULT NULL,
  `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `del_flag` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_func` (`role_code`,`function_code`),
  KEY `idx_role_code` (`role_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色功能权限模板（全局，创建公司时按此分配）';
```

当前数据分布：

| role_code | 功能权限数 |
|-----------|-----------|
| COMPANY_ADMIN | 34 |
| OPS | 20 |
| PROJECT_MANAGER | 16 |
| ANALYST | 14 |
| MEMBER | 4 |

> ⚠️ 实体类名为 `RoleFunctionTemplateMp`，与表名 `role_function_permission` 不一致，需重命名为 `RoleFunctionPermissionMp`。

---

### 3.8 其他

#### refresh_token（登录刷新令牌）

```sql
CREATE TABLE `refresh_token` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `user_id` bigint NOT NULL COMMENT '所属用户 ID',
  `user_type` varchar(16) NOT NULL COMMENT 'PLATFORM / COMPANY',
  `token_hash` varchar(256) NOT NULL COMMENT 'refresh token 哈希（不存明文），UK',
  `expires_at` datetime NOT NULL COMMENT '过期时间',
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_token_hash` (`token_hash`),
  KEY `idx_user` (`user_id`,`user_type`),
  KEY `idx_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='登录刷新令牌';
```

#### permission_audit_log（权限变更审计日志）

```sql
CREATE TABLE `permission_audit_log` (
  `id` bigint NOT NULL COMMENT '主键（雪花）',
  `company_id` bigint DEFAULT NULL COMMENT '所属公司 ID（平台级操作为 NULL）',
  `project_id` bigint DEFAULT NULL COMMENT '所属项目 ID（非项目级操作为 NULL）',
  `operator_id` bigint NOT NULL COMMENT '操作人 ID',
  `operator_type` varchar(16) NOT NULL COMMENT 'PLATFORM / COMPANY / PROJECT',
  `operator_name` varchar(64) NOT NULL COMMENT '冗余操作人名称',
  `action` varchar(16) NOT NULL COMMENT 'CREATE / UPDATE / DELETE / BIND / UNBIND',
  `target_type` varchar(32) NOT NULL COMMENT 'ROLE / RESOURCE_GROUP / DATA_GROUP / PERMISSION / MEMBER / DATA_RULE',
  `target_id` bigint NOT NULL COMMENT '操作对象 ID',
  `before_value` json DEFAULT NULL COMMENT '变更前值',
  `after_value` json DEFAULT NULL COMMENT '变更后值',
  `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
  PRIMARY KEY (`id`),
  KEY `idx_company_time` (`company_id`,`created_time`),
  KEY `idx_project_time` (`project_id`,`created_time`),
  KEY `idx_operator` (`operator_id`,`created_time`),
  KEY `idx_target` (`target_type`,`target_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='权限变更审计日志（只追加）';
```

> 不继承 BaseEntity（无 created_by/updated_by/updated_time/del_flag），只追加不修改。

---

## 四、ER 关系图

```
平台层:
  platform_user ──< platform_user_role >── platform_role
  platform_role ──< platform_role_permission >── route_permission (scope=PLATFORM)

公司层:
  company ──< company_user
  company ──< project
  company ──< role (scope=COMPANY)
  company ──< resource_permission_group
  company ──< data_permission_group

  company_user ──< company_user_role >── role (scope=COMPANY)
  company_user ──< project_member >── project
  project_member ──< project_member_role >── role (scope=PROJECT)

  role ──< role_project >── project                     (scope=COMPANY 角色绑项目)
  role ──< role_resource_group >── resource_permission_group
  role ──< role_data_group >── data_permission_group

  resource_permission_group ──< resource_group_permission_item
    ─── permission_type=ROUTE ─── route_permission (scope=COMPANY/PROJECT)
    ─── permission_type=FUNCTION ─── function_permission

  data_permission_group ──< data_permission_rule (owner_type=GROUP)
  company_user ──< data_permission_rule (owner_type=USER)

全局模板:
  role_function_permission: role_code → function_code (创建公司时复制)
```

---

## 五、审计发现的问题

### P0 — 必须修复

| # | 问题 | 说明 |
|---|------|------|
| 1 | `project_member.uk_project_user` 阻止多角色 | 唯一约束 `(project_id, user_id)` 限制一个用户一个项目只能有一个角色，需改为 `uk_project_user_role` 或启用 `project_member_role` 表 |
| 2 | `RoleFunctionTemplateMp` 类名不匹配 | 实体类名 `RoleFunctionTemplateMp` 与表名 `role_function_permission` 不一致，需重命名为 `RoleFunctionPermissionMp` |

### P1 — 待建表

| # | 问题 | 说明 |
|---|------|------|
| 3 | `project_member_role` 表不存在 | 实体类 `ProjectMemberRoleMp` 已存在，但表未创建 |
| 4 | `role_project` 表不存在 | 实体类 `RoleProjectMp` 已存在，但表未创建 |

### P2 — 空表待确认

| # | 问题 | 说明 |
|---|------|------|
| 5 | `platform_role_permission` 空表（0 行） | 平台角色到路由的映射表未使用，需确认是否删除或补数据 |
| 6 | `role_data_group` 空表（0 行） | 角色到数据权限组的映射表未使用，需确认数据权限聚合路径 |

### P3 — 旧系统清理

| # | 问题 | 说明 |
|---|------|------|
| 7 | `Dim*` 实体映射到 `system_*` 表 | `DimPermissionGroupMp`→`system_permission_group` 等，命名混乱 |
| 8 | 5 张 `system_*` 表仍存在 | 旧系统不再使用，可在确认无依赖后下线 |

---

## 六、权限聚合链路

### 公司用户登录 → 返回功能权限

```
AuthV1Service.login()
  ├─ isAdmin=1 → allFunctionCodes() (全量 function_permission 中 ENABLED 的 code)
  └─ isAdmin=0 → RedisPermissionV1Service.aggregateForCompany(userId)
       ├─ 查 company_user_role 获取用户绑定的 role_id 列表
       ├─ 查 role 获取 scope=COMPANY 的角色
       ├─ 查 role_resource_group 获取角色绑定的资源权限组
       ├─ 查 resource_group_permission_item (permission_type=FUNCTION)
       └─ 返回 function_permission.code 集合
```

### 平台用户登录 → 返回路由权限

```
PlatformAuthV1Service.login()
  └─ RedisPermissionV1Service.aggregateRoutesForPlatform(userId)
       ├─ 查 platform_user_role 获取用户绑定的 platform_role
       ├─ 全量聚合 platform 路由（当前未走 platform_role_permission）
       └─ 返回 route_permission.code 集合
```

### 创建公司 → 初始化角色和权限

```
CompanyV1Service.create()
  ├─ 创建 5 个内置角色（COMPANY_ADMIN, PROJECT_MANAGER, OPS, ANALYST, MEMBER）
  ├─ 每个角色：查 role_function_permission 获取 function_code 列表
  ├─ 每个角色：创建 resource_permission_group + resource_group_permission_item
  ├─ 每个角色：创建 role_resource_group 关联
  └─ 管理员：写入 company_user_role (user_id → COMPANY_ADMIN 角色)
```