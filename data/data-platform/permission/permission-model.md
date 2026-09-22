# SaaS 权限模型设计

> 版本：V3.1
> 日期：2026-07-14
> 状态：设计中
> 统一库 `qpointplay_auth`，平台/公司侧逻辑分层，auth 模块统一管理
> 权限数据存 Redis，现查；管理员 JWT claims bypass
> token_version 缓存至 Redis
> 所有实体继承 BaseEntity（雪花主键 + 审计字段），详见 permission-sql.md
> 所有外键引用冗余存储名称（xxx_id + xxx_name），避免 JOIN，详见 permission-sql.md
> V3.1 公司侧模型重构：替换为 PRD 定义的 游戏/应用管理 模型

---

## 核心设计哲学

### 1. 分层管控模型

| 层级 | 角色 | 职责 |
|------|------|------|
| **平台运营** | 定义"权限宇宙" | 维护 `route_permission` + `function_permission`，管理公司 |
| **公司管理员** | 造"权限积木" | 管理产品/应用/应用组/角色/成员，构建公司内部的权限结构 |

### 2. 多租户边界

- **Company** = 售卖/计费/自治单元（`company_id` 物理隔离）
- 公司间完全隔离

### 3. 角色是枢纽

角色绑定两个正交维度：

- **资源权限组**（ROUTE + FUNCTION）— 控制"能做什么"
- **应用组**（AppGroup）— 控制"能看哪些游戏/渠道的数据"

### 4. 安全默认

| 原则 | 实现 |
|------|------|
| Admin bypass 不可伪造 | 通过 JWT claims 判断 |
| 新路由默认禁用 | 扫描注册后 `status=0` |
| Redis 是唯一真相源 | Miss 即拒绝 |
| 拒绝优先于放行 | 任何一层校验失败即 403 |

### 5. 两个正交维度

- 页面权限：角色 → 资源权限组 → route_permission，控制菜单/页面可见性
- 数据权限：成员 → 应用组 → 应用，控制数据查询范围

---

## 一、整体架构

```
平台层 (Platform)
  │
  ├─ 平台用户：管理员 / 运营 / 销售
  │
  └─ 权限点目录：route_permission + function_permission
       │
       └─ 公司 (Company)  ← 多租户隔离单元
            │
            ├─ 产品 (Product) ── 应用 (Application)
            │
            ├─ 项目组 (ProjectGroup) ── 应用组 (AppGroup)
            │
            ├─ 角色 (Role) ── 资源权限组 ── route_permission
            │
            └─ 成员 (Member)
                 ├─ member_app_group → 数据权限
                 └─ member_role → 页面权限
```

---

## 二、平台侧权限模型

### 2.1 平台角色

| 角色 | code | 说明 |
|------|------|------|
| 平台管理员 | `PLATFORM_ADMIN` | 全局数据可见 + 管理所有公司、平台用户、权限点目录，JWT bypass |
| 平台运营 | `PLATFORM_OPS` | 管理公司（创建/停用/配置）、管理权限点目录，**不看业务数据** |
| 平台销售 | `PLATFORM_SALES` | 仅创建公司 + 指定公司管理员 |

### 2.2 平台 RBAC 关系

- `platform_user` → `platform_user_role` (M:N) → `platform_role` → `platform_role_permission` (M:N) → `route_permission`(scope=PLATFORM)

### 2.3 平台运营权限

- 创建/停用/启用公司
- 配置公司基本信息、License、到期时间
- 管理权限点目录（route_permission + function_permission）
- **不能**查看公司内的业务数据

---

## 三、公司侧权限模型（V3.1 重构）

### 3.1 实体关系

```
                    ┌─────────────────────────────────┐
                    │         route_permission         │  平台级，权限点目录
                    └──────────────┬──────────────────┘
                                   │ 1:N
                    ┌──────────────┴──────────────────┐
                    │  resource_group_permission_item  │  权限组明细
                    └──────────────┬──────────────────┘
                                   │ N:1
                    ┌──────────────┴──────────────────┐
                    │   resource_permission_group      │  资源权限组
                    └──────────────┬──────────────────┘
                                   │
                          M:N      │
     ┌─────────────────────────────┼──────────────────┐
     │                role_resource_group              │
     │  ┌──────────┐               │                  │
     │  │  角色     │───────────────┘                  │
     │  │  Role    │                                  │
     │  └────┬─────┘                                  │
     │       │                                        │
     │       │ M:N                                    │
     │       │            ┌──────────────────────┐    │
     │       │            │ project_group_application │
     │       │            └──────────┬───────────┘    │
     │       │                       │                │
     │       │              M:N      │       M:N      │
     │  ┌────┴────────┐  ┌──────────┴─────┐ ┌────────┴──────┐
     │  │ member_role │  │   项目组        │ │    应用        │
     │  └────┬────────┘  │ ProjectGroup   │ │ Application   │
     │       │            └────────┬───────┘ └───────┬───────┘
     │       │                     │                  │
     │       │                   1:N                  │ 1:N
     │       │                     │                  │
     │       │            ┌────────┴───────┐  ┌──────┴───────┐
     │       │            │    应用组       │  │    产品       │
     │       │            │   AppGroup    │  │   Product    │
     │       │            └────────┬───────┘  └──────────────┘
     │       │                     │
     │       │            M:N      │
     │       │  ┌──────────────────┴──────┐
     │       │  │    app_group_application  │
     │       │  └──────────────────┬──────┘
     │       │                     │
     │       │            M:N      │
     │  ┌────┴─────────────────────┴──────┐
     │  │         member_app_group        │
     │  └────────────────┬────────────────┘
     │                   │
     │  ┌────────────────┴────────────────┐
     │  │            成员                  │
     │  │           Member                │
     │  └─────────────────────────────────┘
     └──────────────────────────────────────────┘
```

**两条独立链路，在成员身上取交集：**

| 链路 | 路径 | 控制 |
|------|------|------|
| 页面权限 | 成员 → member_role → 角色 → role_resource_group → 资源权限组 → 明细 → route_permission | 能看哪些页面 |
| 数据权限 | 成员 → member_app_group → 应用组 → app_group_application → 应用 → 产品 | 能看哪些游戏数据 |

### 3.2 产品（Product）

游戏母体。一个产品 ID 对应一个游戏。

| 属性 | 类型 | 说明 |
|------|------|------|
| product_id | BIGINT | 业务主键 |
| product_name | VARCHAR(128) | 游戏名称，≤30字 |
| product_type_id | BIGINT | 引用 system_enum（游戏/短剧/其他） |
| product_type_name | VARCHAR(128) | 冗余 |

**删除约束：** 产品下有应用时禁止删除。

### 3.3 应用（Application）

一个游戏在不同渠道上的子包。同一游戏在抖音和微信各是一个应用。

| 属性 | 类型 | 说明 |
|------|------|------|
| application_id | BIGINT | 业务主键 |
| application_name | VARCHAR(128) | 子包名称，≤30字 |
| product_id | BIGINT | 所属产品 |
| product_name | VARCHAR(128) | 冗余 |
| platform_id | BIGINT | 引用 system_enum（iOS/Android/微信小游戏/抖音小游戏等） |
| platform_name | VARCHAR(128) | 冗余 |
| package_name | VARCHAR(128) | 包名 |
| appid | VARCHAR(64) | APPID |
| mini_game_origin_id | VARCHAR(64) | 小游戏原始ID |
| app_key | VARCHAR(256) | 系统生成 |
| access_token | VARCHAR(256) | 系统生成 |
| remark | VARCHAR(256) | 备注 |

### 3.4 项目组（ProjectGroup）

应用组的 namespace。应用组创建时只能从项目组已绑定的应用中选。

| 属性 | 类型 | 说明 |
|------|------|------|
| project_group_id | BIGINT | 业务主键 |
| project_group_name | VARCHAR(128) | 项目组名称，≤30字 |

**删除约束：** 有关联应用组时禁止删除。

### 3.5 应用组（AppGroup）

数据权限的载体。决定成员能看哪些游戏-渠道的数据。

| 属性 | 类型 | 说明 |
|------|------|------|
| app_group_id | BIGINT | 业务主键 |
| app_group_name | VARCHAR(128) | 应用组名称，≤30字 |
| project_group_id | BIGINT | 所属项目组 |
| project_group_name | VARCHAR(128) | 冗余 |

**删除约束：** 被成员引用时禁止删除。

### 3.6 角色（Role）

页面/功能权限的载体。控制能看哪些页面。

| 属性 | 类型 | 说明 |
|------|------|------|
| role_id | BIGINT | 业务主键 |
| role_name | VARCHAR(128) | 角色名称，≤30字 |

**页面权限绑定链路：** `role → role_resource_group → resource_permission_group → resource_group_permission_item → route_permission`

**删除约束：** 被成员引用时禁止删除。

### 3.7 成员（Member）

登录用户，直接绑定应用组和角色。

| 属性 | 类型 | 说明 |
|------|------|------|
| member_id | BIGINT | 业务主键 |
| member_name | VARCHAR(128) | 成员名称，≤30字 |
| email | VARCHAR(128) | 邮箱账号，唯一 |
| password | VARCHAR(256) | 加密密码 |

**新建流程：** 创建成功后系统向成员邮箱发送平台登录地址、账号和随机密码。

**操作：**
- 删除：仅超级管理员可执行，删除后成员无法登录
- 重置密码：随机生成并通过邮件发送

### 3.8 关联表

| 关联表 | 关系 | 说明 |
|--------|------|------|
| project_group_application | M:N | 项目组 ↔ 应用 |
| app_group_application | M:N | 应用组 ↔ 应用 |
| member_app_group | M:N | 成员 ↔ 应用组（数据权限） |
| member_role | M:N | 成员 ↔ 角色 |
| role_resource_group | M:N | 角色 ↔ 资源权限组（页面权限） |

### 3.9 复用现有表

| 现有表 | 用途 |
|--------|------|
| route_permission | 路由权限点目录（平台级，所有公司共享） |
| resource_permission_group | 资源权限组，打包 ROUTE + FUNCTION 权限点 |
| resource_group_permission_item | 权限组明细，引用 route_permission / function_permission |

### 3.10 典型配置

| 组织 | 应用组 | 角色 | 效果 |
|------|--------|------|------|
| 运营一组 | 应用组A（产品1,2,3） | 运营 | 同一套页面，只能看产品1,2,3的数据 |
| 运营二组 | 应用组B（产品4,5,6） | 运营 | 同一套页面，只能看产品4,5,6的数据 |

### 3.11 权限判定

```
请求 → 身份认证（JWT 获取 member_id + company_id）
  │
  ├─ 页面权限：member_id → member_role → role → role_resource_group
  │            → resource_permission_group → resource_group_permission_item
  │            → route_permission → 匹配当前 path
  │
  └─ 数据权限：member_id → member_app_group → app_group → app_group_application
               → application → SQL 追加 application_id 过滤
```

### 3.12 超级管理员

- 内置角色，不可删除
- 不参与页面权限校验，直接拥有全量权限
- 不参与数据权限过滤，可查全量数据
- 唯一拥有「删除成员」权限

---

## 四、登录与权限存储

### 4.1 登录入口

两个独立登录入口：

| 入口 | 路径 | 说明 |
|------|------|------|
| 平台登录 | `POST /platform/login` | 平台用户，username + password |
| 公司登录 | `POST /auth/login` | 公司成员，email + password |

### 4.2 JWT

**公司成员 JWT 载荷：**
- `memberId` — member.id
- `companyId` — 所属公司
- `isAdmin` — 是否超级管理员，权限层直接 bypass
- `type` — COMPANY

**平台用户 JWT 载荷：**
- `userId` — platform_user.id
- `roles` — 平台角色 code 列表
- `type` — PLATFORM

### 4.3 管理员 Bypass

- 公司成员 `isAdmin=true` — 公司内全量数据
- 平台用户 `roles` 含 `PLATFORM_ADMIN` — 全局数据

### 4.4 Redis 权限存储

**公司成员 — 权限缓存：**

- Key: `saas:permission:{memberId}`
- Value: `routes`（页面权限列表）+ `appIds`（可访问的应用 ID 列表）
- 构建来源：member_role → role_resource_group → resource_permission_group → resource_group_permission_item → route_permission（routes）；member_app_group → app_group_application（appIds）
- TTL: 永久（auth 主动维护）

**平台非管理员用户：**

- Key: `saas:platform:permission:{userId}`
- Value: `routes`（平台路由列表）

**刷新时机：** 角色绑定变更、应用组绑定变更、权限点变更、成员禁用/公司停用。

---

## 五、审计日志

所有权限变更操作记录到 `permission_audit_log` 表（只追加，不继承 BaseEntity）：

| 字段 | 说明 |
|------|------|
| `company_id` | 所属公司 |
| `operator_id` | 操作人 ID |
| `operator_type` | PLATFORM / COMPANY |
| `action` | CREATE / UPDATE / DELETE / BIND / UNBIND |
| `target_type` | ROLE / RESOURCE_GROUP / APP_GROUP / MEMBER / PRODUCT / APPLICATION |
| `target_id` | 操作对象 ID |
| `before_value` | 变更前值（JSON） |
| `after_value` | 变更后值（JSON） |

---

## 六、权限执行流程

**第一层：拦截器（认证 + bypass）**

1. JWT 验签，解析 claims
2. `isAdmin=true` 或 `roles` 含 `PLATFORM_ADMIN` → 直接放行

**第二层：Service 层**

3. **路由权限校验**：查 Redis，匹配请求路径
4. **数据权限过滤**：从 Redis 取 appIds → 注入 SQL 条件

---

## 七、表汇总

所有表统一放在 **`qpointplay_auth` 库**。V3.1 公司侧模型重构，删除旧表（company_user / project / project_member / role(V3.0) / data_permission_group / data_permission_rule / role_data_group），新增 PRD 模型表。

| 层级 | 表名 | 类型 | 版本 | 说明 |
|------|------|------|------|------|
| 平台 | `platform_user` | 普通表 | V3.0 | 平台用户 |
| 平台 | `platform_role` | 普通表 | V3.0 | 平台角色（固定 3 个） |
| 平台 | `platform_user_role` | M:N | V3.0 | 平台用户-角色 |
| 平台 | `platform_role_permission` | M:N | V3.0 | 平台角色 → route_permission |
| 平台 | `company` | 普通表 | V3.0 | 公司 |
| 平台 | `route_permission` | 普通表 | V3.0 | 路由权限点目录 |
| 平台 | `function_permission` | 普通表 | V3.0 | 功能权限点目录 |
| 平台 | `permission_audit_log` | 日志表 | V3.0 | 审计日志 |
| 公司 | `product` | 普通表 | **V3.1** | 产品（游戏母体） |
| 公司 | `application` | 普通表 | **V3.1** | 应用（渠道子包） |
| 公司 | `project_group` | 普通表 | **V3.1** | 项目组 |
| 公司 | `app_group` | 普通表 | **V3.1** | 应用组（数据权限载体） |
| 公司 | `role` | 普通表 | **V3.1** | 角色（页面权限载体） |
| 公司 | `member` | 普通表 | **V3.1** | 成员（登录用户） |
| 公司 | `project_group_application` | M:N | **V3.1** | 项目组 ↔ 应用 |
| 公司 | `app_group_application` | M:N | **V3.1** | 应用组 ↔ 应用 |
| 公司 | `member_app_group` | M:N | **V3.1** | 成员 ↔ 应用组 |
| 公司 | `member_role` | M:N | **V3.1** | 成员 ↔ 角色 |
| 公司 | `resource_permission_group` | 普通表 | V3.0 | 资源权限组 |
| 公司 | `resource_group_permission_item` | 明细 | V3.0 | 权限组明细 |
| 公司 | `role_resource_group` | M:N | V3.0 | 角色 ↔ 资源权限组 |