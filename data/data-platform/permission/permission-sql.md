# SaaS 权限模块 DDL

> 版本：V3.0
> 日期：2026-07-11
> 数据库：`qpointplay_auth`
> 表数量：18（基于权限模型 V2.7 + 数据库设计规范 V3.0）

## 表清单

| # | 表名 | 类型 | 说明 |
|---|---|---|---|
| 1 | `platform_user` | 普通表 | 平台用户 |
| 2 | `platform_role` | 普通表（固定预置） | 平台角色（固定 3 个，code 做 UK） |
| 3 | `platform_user_role` | M:N 关联表 | 平台用户-角色 |
| 4 | `platform_role_permission` | M:N 关联表 | 平台角色 → route_permission(scope=PLATFORM) |
| 5 | `company` | 普通表 | 公司 |
| 6 | `company_user` | 普通表 | 公司员工 |
| 7 | `project` | 普通表 | 项目 |
| 8 | `project_member` | M:N 关联表 | 员工-项目-角色绑定 |
| 9 | `role` | 普通表 | 角色（公司级 + 项目级，Generated Column UK） |
| 10 | `route_permission` | 普通表 | 路由权限点目录（scope: PLATFORM/COMPANY/PROJECT） |
| 11 | `function_permission` | 普通表 | 功能权限点目录 |
| 12 | `resource_permission_group` | 普通表 | 资源权限组 |
| 13 | `resource_group_permission_item` | 1:N 明细子表 | 资源权限组 → 权限点（permission_type: ROUTE/FUNCTION） |
| 14 | `role_resource_group` | M:N 关联表 | 角色 → 资源权限组 |
| 15 | `data_permission_group` | 普通表 | 数据权限组 |
| 16 | `data_permission_rule` | 普通表 | 数据权限规则（owner_type: GROUP/USER） |
| 17 | `role_data_group` | M:N 关联表 | 角色 → 数据权限组 |
| 18 | `permission_audit_log` | 日志表 | 权限变更审计日志 |

## 设计决策

### 与权限模型 V2.7 的差异（21 表 → 18 表）

| 变化 | 原设计 | 新设计 | 理由 |
|---|---|---|---|
| 消除 `platform_permission` | 平台侧单独路由权限表 | 合入 `route_permission`，scope=PLATFORM | 本质相同，都是路由权限点，scope 字段自然区分 |
| 合并 `company_role` + `project_role` | 两张表 | 一张 `role` 表 + Generated Column UK | 结构完全相同，规范 6.5 有模板；合并后 project_member / role_resource_group / role_data_group 的角色引用简化为直接 role_id，无需多态 |
| 合并 `resource_group_route_item` + `resource_group_function_item` | 两张明细表 | 一张 `resource_group_permission_item` + permission_type | 结构完全相同，规范 6.4 多态模式；两个目标表都有 permission_id BIGINT UK |

### 不合并的表

| 表 | 理由 |
|---|---|
| `resource_permission_group` vs `data_permission_group` | 结构不同（资源组有 code + item 明细，数据组无），正交维度保持独立 |
| `role_resource_group` vs `role_data_group` | 引用不同目标表，语义正交（能做什么 vs 能看什么） |
| `route_permission` vs `function_permission` | 字段差异大（path/method vs code），来源流程不同（扫描 vs 手动） |

---

## DDL

```sql
-- ============================================================
-- 1. platform_user — 平台用户
-- ============================================================
CREATE TABLE `platform_user` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `user_id`         BIGINT        COMMENT '用户业务编码',
  `username`        VARCHAR(64)   COMMENT '登录账号',
  `password_hash`   VARCHAR(256)  COMMENT '密码哈希',
  `user_name`       VARCHAR(128)  COMMENT '用户显示名称',
  `status`          VARCHAR(16)   COMMENT '状态：ACTIVE / DISABLED（Java enum 维护合法值）',
  `token_version`   INT DEFAULT 1 COMMENT 'JWT 版本号，递增使旧 token 失效',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_id` (`user_id`),
  UNIQUE KEY `uk_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='平台用户';

-- ============================================================
-- 2. platform_role — 平台角色（固定预置，code 做 UK）
--    预置：PLATFORM_ADMIN / PLATFORM_OPS / PLATFORM_SALES
--    注：固定预置角色，code 是稳定标识，不加 role_id
-- ============================================================
CREATE TABLE `platform_role` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `code`            VARCHAR(32)   COMMENT '角色编码（JWT 引用标识）',
  `role_name`       VARCHAR(128)  COMMENT '角色名称',
  `description`     VARCHAR(256)  COMMENT '角色描述',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='平台角色（固定预置）';

-- ============================================================
-- 3. platform_user_role — 平台用户-角色（M:N 关联表，物理 DELETE）
-- ============================================================
CREATE TABLE `platform_user_role` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `user_id`         BIGINT        COMMENT '平台用户业务编码 → platform_user.user_id',
  `user_name`       VARCHAR(128)  COMMENT '冗余用户名',
  `role_code`       VARCHAR(32)   COMMENT '平台角色编码 → platform_role.code',
  `role_name`       VARCHAR(128)  COMMENT '冗余角色名',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除（关联表不使用，继承 BaseEntity）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_role` (`user_id`, `role_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='平台用户-角色';

-- ============================================================
-- 4. platform_role_permission — 平台角色-路由权限（M:N 关联表，物理 DELETE）
--    引用 route_permission(scope=PLATFORM)
-- ============================================================
CREATE TABLE `platform_role_permission` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `role_code`       VARCHAR(32)   COMMENT '平台角色编码 → platform_role.code',
  `role_name`       VARCHAR(128)  COMMENT '冗余角色名',
  `permission_id`   BIGINT        COMMENT '路由权限编码 → route_permission.permission_id (scope=PLATFORM)',
  `permission_name` VARCHAR(128)  COMMENT '冗余权限名',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除（关联表不使用）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_perm` (`role_code`, `permission_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='平台角色-路由权限';

-- ============================================================
-- 5. company — 公司
-- ============================================================
CREATE TABLE `company` (
  `id`                    BIGINT        COMMENT '框架主键（雪花）',
  `company_id`            BIGINT        COMMENT '公司业务编码',
  `company_code`          VARCHAR(64)   COMMENT '对外显示码（人类可读）',
  `company_name`          VARCHAR(128)  COMMENT '公司名称',
  `status`                VARCHAR(16)   COMMENT '状态：ACTIVE / SUSPENDED（Java enum 维护合法值）',
  `license_expire_date`   DATE          COMMENT 'License 到期日期',
  `created_by`            VARCHAR(64)   COMMENT '创建人',
  `created_time`          DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`            VARCHAR(64)   COMMENT '更新人',
  `updated_time`          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`              TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_company_id` (`company_id`),
  UNIQUE KEY `uk_company_code` (`company_code`),
  KEY `idx_company_name` (`company_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公司';

-- ============================================================
-- 6. company_user — 公司员工
-- ============================================================
CREATE TABLE `company_user` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `user_id`         BIGINT        COMMENT '用户业务编码',
  `company_id`      BIGINT        COMMENT '所属公司 → company.company_id',
  `company_name`    VARCHAR(128)  COMMENT '冗余公司名',
  `email`           VARCHAR(128)  COMMENT '登录邮箱（全局唯一）',
  `password_hash`   VARCHAR(256)  COMMENT '密码哈希',
  `user_name`       VARCHAR(128)  COMMENT '用户显示名称',
  `is_admin`        TINYINT       COMMENT '是否公司管理员 0=否 1=是（JWT bypass）',
  `status`          VARCHAR(16)   COMMENT '状态：ACTIVE / DISABLED（Java enum 维护合法值）',
  `token_version`   INT DEFAULT 1 COMMENT 'JWT 版本号',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_id` (`user_id`),
  UNIQUE KEY `uk_email` (`email`),
  KEY `idx_company_id` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公司员工';

-- ============================================================
-- 7. project — 项目
-- ============================================================
CREATE TABLE `project` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `project_id`      BIGINT        COMMENT '项目业务编码',
  `company_id`      BIGINT        COMMENT '所属公司 → company.company_id',
  `company_name`    VARCHAR(128)  COMMENT '冗余公司名',
  `project_name`    VARCHAR(128)  COMMENT '项目名称',
  `status`          VARCHAR(16)   COMMENT '状态：ACTIVE / ARCHIVED（Java enum 维护合法值）',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_project_id` (`project_id`),
  KEY `idx_company_id` (`company_id`),
  KEY `idx_project_name` (`project_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目';

-- ============================================================
-- 8. project_member — 项目成员（M:N 关联表，带角色属性）
--    角色引用已简化：company_role + project_role 合并为 role 表
-- ============================================================
CREATE TABLE `project_member` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `project_id`      BIGINT        COMMENT '项目 → project.project_id',
  `project_name`    VARCHAR(128)  COMMENT '冗余项目名',
  `user_id`         BIGINT        COMMENT '员工 → company_user.user_id',
  `user_name`       VARCHAR(128)  COMMENT '冗余员工名',
  `company_id`      BIGINT        COMMENT '所属公司（跨公司隔离校验）',
  `role_id`         BIGINT        COMMENT '角色 → role.role_id',
  `role_name`       VARCHAR(128)  COMMENT '冗余角色名',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除（关联表不使用）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_project` (`project_id`, `user_id`),
  KEY `idx_company_id` (`company_id`),
  KEY `idx_role_id` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目成员';

-- ============================================================
-- 9. role — 角色（公司级 + 项目级合并）
--    scope=COMPANY 时 project_id 为 NULL
--    scope=PROJECT 时 project_id 为实际值
--    基础角色 builtin=1 防删除（PROJECT_MANAGER/OPS/ANALYST/MEMBER）
-- ============================================================
CREATE TABLE `role` (
  `id`                  BIGINT        COMMENT '框架主键（雪花）',
  `role_id`             BIGINT        COMMENT '角色业务编码',
  `company_id`          BIGINT        COMMENT '所属公司 → company.company_id',
  `company_name`        VARCHAR(128)  COMMENT '冗余公司名',
  `project_id`          BIGINT        COMMENT '项目（scope=COMPANY 时为 NULL）',
  `project_id_virtual`  BIGINT AS (IFNULL(`project_id`, 0)) STORED COMMENT '条件 UK 虚拟列',
  `role_name`           VARCHAR(128)  COMMENT '角色名称',
  `code`                VARCHAR(64)   COMMENT '角色编码（基础角色：PROJECT_MANAGER/OPS/ANALYST/MEMBER）',
  `scope`               VARCHAR(16)   COMMENT '作用域：COMPANY / PROJECT（显式冗余）',
  `builtin`             TINYINT       COMMENT '是否内置 0=否 1=是（防删除）',
  `description`         VARCHAR(256)  COMMENT '角色描述',
  `created_by`          VARCHAR(64)   COMMENT '创建人',
  `created_time`        DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`          VARCHAR(64)   COMMENT '更新人',
  `updated_time`        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`            TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_id` (`role_id`),
  UNIQUE KEY `uk_role_code` (`company_id`, `project_id_virtual`, `code`),
  KEY `idx_company_id` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色';

-- ============================================================
-- 10. route_permission — 路由权限点目录（全局）
--     scope=PLATFORM：平台管理后台路由（自动扫描注册）
--     scope=COMPANY：公司级路由
--     scope=PROJECT：项目级路由
-- ============================================================
CREATE TABLE `route_permission` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `permission_id`   BIGINT        COMMENT '权限业务编码',
  `path`            VARCHAR(256)  COMMENT '路由路径',
  `method`          VARCHAR(16)   COMMENT 'HTTP 方法：POST / GET（Java enum 维护合法值）',
  `permission_name` VARCHAR(128)  COMMENT '权限名称',
  `module`          VARCHAR(64)   COMMENT '所属模块',
  `scope`           VARCHAR(16)   COMMENT '作用域：PLATFORM / COMPANY / PROJECT（内部鉴别器，Java enum 维护）',
  `status`          VARCHAR(16)   COMMENT '状态：ENABLED / DISABLED（Java enum 维护合法值）',
  `description`     VARCHAR(256)  COMMENT '权限描述',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_permission_id` (`permission_id`),
  UNIQUE KEY `uk_path_method` (`path`, `method`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='路由权限点目录';

-- ============================================================
-- 11. function_permission — 功能权限点目录（全局，手动创建）
-- ============================================================
CREATE TABLE `function_permission` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `permission_id`   BIGINT        COMMENT '权限业务编码',
  `code`            VARCHAR(128)  COMMENT '功能权限码（如 FUNCTION:DASHBOARD:CREATE）',
  `permission_name` VARCHAR(128)  COMMENT '权限名称',
  `scope`           VARCHAR(16)   COMMENT '作用域：COMPANY / PROJECT（内部鉴别器，Java enum 维护）',
  `status`          VARCHAR(16)   COMMENT '状态：ENABLED / DISABLED（Java enum 维护合法值）',
  `description`     VARCHAR(256)  COMMENT '权限描述',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_permission_id` (`permission_id`),
  UNIQUE KEY `uk_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='功能权限点目录';

-- ============================================================
-- 12. resource_permission_group — 资源权限组（公司级）
-- ============================================================
CREATE TABLE `resource_permission_group` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `group_id`        BIGINT        COMMENT '权限组业务编码',
  `company_id`      BIGINT        COMMENT '所属公司 → company.company_id',
  `company_name`    VARCHAR(128)  COMMENT '冗余公司名',
  `group_name`      VARCHAR(128)  COMMENT '权限组名称',
  `code`            VARCHAR(64)   COMMENT '权限组编码',
  `description`     VARCHAR(256)  COMMENT '权限组描述',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_group_id` (`group_id`),
  UNIQUE KEY `uk_company_code` (`company_id`, `code`),
  KEY `idx_company_id` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='资源权限组';

-- ============================================================
-- 13. resource_group_permission_item — 资源权限组明细（1:N）
--     permission_type=ROUTE 时引用 route_permission.permission_id
--     permission_type=FUNCTION 时引用 function_permission.permission_id
-- ============================================================
CREATE TABLE `resource_group_permission_item` (
  `id`                BIGINT        COMMENT '框架主键（雪花）',
  `group_id`          BIGINT        COMMENT '资源权限组 → resource_permission_group.group_id',
  `group_name`        VARCHAR(128)  COMMENT '冗余权限组名',
  `permission_type`   VARCHAR(16)   COMMENT '权限类型：ROUTE / FUNCTION',
  `permission_id`     BIGINT        COMMENT '权限编码（route_permission 或 function_permission）',
  `permission_name`   VARCHAR(128)  COMMENT '冗余权限名',
  `created_by`        VARCHAR(64)   COMMENT '创建人',
  `created_time`      DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`        VARCHAR(64)   COMMENT '更新人',
  `updated_time`      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`          TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_group_perm` (`group_id`, `permission_type`, `permission_id`),
  KEY `idx_group_id` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='资源权限组明细';

-- ============================================================
-- 14. role_resource_group — 角色-资源权限组（M:N 关联表，物理 DELETE）
-- ============================================================
CREATE TABLE `role_resource_group` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `role_id`         BIGINT        COMMENT '角色 → role.role_id',
  `role_name`       VARCHAR(128)  COMMENT '冗余角色名',
  `group_id`        BIGINT        COMMENT '资源权限组 → resource_permission_group.group_id',
  `group_name`      VARCHAR(128)  COMMENT '冗余权限组名',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除（关联表不使用）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_group` (`role_id`, `group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色-资源权限组';

-- ============================================================
-- 15. data_permission_group — 数据权限组（公司级）
-- ============================================================
CREATE TABLE `data_permission_group` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `group_id`        BIGINT        COMMENT '权限组业务编码',
  `company_id`      BIGINT        COMMENT '所属公司 → company.company_id',
  `company_name`    VARCHAR(128)  COMMENT '冗余公司名',
  `group_name`      VARCHAR(128)  COMMENT '权限组名称',
  `description`     VARCHAR(256)  COMMENT '权限组描述',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_group_id` (`group_id`),
  KEY `idx_company_id` (`company_id`),
  KEY `idx_group_name` (`group_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='数据权限组';

-- ============================================================
-- 16. data_permission_rule — 数据权限规则
--     owner_type=GROUP：数据权限组规则，owner_id → data_permission_group.group_id，project_id=0
--     owner_type=USER：员工额外规则，owner_id → company_user.user_id，project_id=实际项目
-- ============================================================
CREATE TABLE `data_permission_rule` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `rule_id`         BIGINT        COMMENT '规则业务编码',
  `owner_type`      VARCHAR(16)   COMMENT '所有者类型：GROUP / USER',
  `owner_id`        BIGINT        COMMENT '所有者编码（GROUP→data_permission_group.group_id / USER→company_user.user_id）',
  `owner_name`      VARCHAR(128)  COMMENT '冗余所有者名',
  `project_id`      BIGINT        COMMENT '项目（GROUP 时为 0，USER 时为实际项目）',
  `resource_type`   VARCHAR(32)   COMMENT '资源类型：MINIGAME / PACKAGE / CHANNEL / APP（Java enum 维护合法值）',
  `resource_value`  VARCHAR(128)  COMMENT '资源值',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_rule_id` (`rule_id`),
  UNIQUE KEY `uk_owner_resource` (`owner_type`, `owner_id`, `project_id`, `resource_type`, `resource_value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='数据权限规则';

-- ============================================================
-- 17. role_data_group — 角色-数据权限组（M:N 关联表，物理 DELETE）
-- ============================================================
CREATE TABLE `role_data_group` (
  `id`              BIGINT        COMMENT '框架主键（雪花）',
  `role_id`         BIGINT        COMMENT '角色 → role.role_id',
  `role_name`       VARCHAR(128)  COMMENT '冗余角色名',
  `group_id`        BIGINT        COMMENT '数据权限组 → data_permission_group.group_id',
  `group_name`      VARCHAR(128)  COMMENT '冗余权限组名',
  `created_by`      VARCHAR(64)   COMMENT '创建人',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by`      VARCHAR(64)   COMMENT '更新人',
  `updated_time`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag`        TINYINT DEFAULT 0 COMMENT '逻辑删除（关联表不使用）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_group` (`role_id`, `group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色-数据权限组';

-- ============================================================
-- 18. permission_audit_log — 权限变更审计日志（只追加，不继承 BaseEntity）
-- ============================================================
CREATE TABLE `permission_audit_log` (
  `id`              BIGINT        COMMENT '雪花主键',
  `company_id`      BIGINT        COMMENT '所属公司（平台级操作为 NULL）',
  `project_id`      BIGINT        COMMENT '所属项目（非项目级操作为 NULL）',
  `operator_id`     BIGINT        COMMENT '操作人编码',
  `operator_type`   VARCHAR(16)   COMMENT '操作人类型：PLATFORM / COMPANY / PROJECT',
  `operator_name`   VARCHAR(128)  COMMENT '操作人名称',
  `action`          VARCHAR(16)   COMMENT '操作类型：CREATE / UPDATE / DELETE / BIND / UNBIND',
  `target_type`     VARCHAR(32)   COMMENT '操作对象类型：ROLE / RESOURCE_GROUP / DATA_GROUP / PERMISSION / MEMBER / DATA_RULE',
  `target_id`       BIGINT        COMMENT '操作对象编码',
  `before_value`    JSON          COMMENT '变更前值',
  `after_value`     JSON          COMMENT '变更后值',
  `created_by`      VARCHAR(64)   COMMENT '操作人标识',
  `created_time`    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
  PRIMARY KEY (`id`),
  KEY `idx_company_id` (`company_id`),
  KEY `idx_project_id` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='权限变更审计日志';
```

---

## 规范覆盖不到的设计决策

以下是本次设计中做出但规范未明确覆盖的决策，建议补充到规范中：

| 决策 | 处理方式 | 建议补充到规范 |
|---|---|---|
| 固定预置表（platform_role）不需要 `{实体}_id` BIGINT UK | `code` VARCHAR 做 UK | 规范 5.1 补充：固定预置实体允许 code UK 代替 `{实体}_id` UK |
| 内部固定枚举字段不走 `system_enum` | status / scope / owner_type / permission_type / method / resource_type 等均为裸 VARCHAR + Java enum 维护合法值 | 规范 5.5 补充：值集小且不变化的内部固定枚举（如状态、HTTP 方法、类型鉴别器）直接用 VARCHAR，不需要走 system_enum；system_enum 仅用于用户可管理、前端下拉、值会动态增减的枚举（如渠道、支付方式） |
| 多态引用字段命名 | `permission_type` + `permission_id`（两个目标表都有 permission_id，字段名一致） | 规范 6.4 补充：当多态目标表使用相同的 `{实体}_id` 字段名时，`{引用语义}_id` 可直接复用 |
| 关联表的外键引用字段命名 | `role_code`（引用 platform_role.code）而非 `role_id` | 规范 2.3 补充：引用非 `{实体}_id` 字段时，字段名应匹配引用目标字段 |

---

## RBAC 关系链（新 18 表）

```
平台侧：
  platform_user → platform_user_role → platform_role
                                   → platform_role_permission → route_permission(scope=PLATFORM)

公司侧：
  company_user → project_member → role
                               → role_resource_group → resource_permission_group
                                                          → resource_group_permission_item → route_permission / function_permission
                               → role_data_group → data_permission_group
                                                       → data_permission_rule(owner_type=GROUP)

  员工额外数据权限：data_permission_rule(owner_type=USER)
```
