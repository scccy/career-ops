# Report 模块数据模型

**版本**: 022 | **更新**: 2026-07-27

## 概念口径

### 业务概念

| 概念 | 是什么 | 存放位置 | 举例 |
|------|--------|---------|------|
| **项目组（ProjectGroup）** | 公司下的组织层，管理应用组 | auth.`project_group` | "奇点工作室"项目组 |
| **应用组（AppGroup）** | 项目组下的权限边界，管理多个游戏 | auth.`app_group` | "iOS 应用组"、"Android 应用组" |
| **产品（Product）** | 具体的游戏（游戏母体），一个产品有多个子包 | event_center.`product` | "消消乐"游戏 |
| **appid（子包）** | 游戏的一个子包/接入端，数据上报的最小单位 | event_center.`app`（`app_id`） | "消消乐-iOS"、"消消乐-Android" |

**层级关系**：

```
项目组（ProjectGroup, auth）
  └─ 应用组（AppGroup, auth）—— 权限边界
       └─ 产品（Product, event_center）—— 游戏
            └─ appid（子包, event_center.app）—— 数据上报最小单位，1:1 Space
```

- 一个**项目组**包含多个**应用组**
- 一个**应用组**管理多个**产品**（游戏），是登录人员"能看到哪些游戏"的判定依据
- 一个**产品**（游戏）有多个**appid**（子包），如 iOS/Android/小游戏各算一个子包
- 登录人员通过 `MemberAppGroup` 关联应用组，可见该应用组下全部产品及其 appid

### Report 域概念

| 概念 | 是什么 | 举例 |
|------|--------|------|
| **Space（空间）** | 运营创建、与 appid 1:1 绑定的容器，可被分享 | "消消乐-iOS"子包对应的空间 |
| **Dashboard（看板）** | 页面画布，挂在 Space 下或个人区，可被分享；与 Folder 平级，可不挂 Folder | "近7天运营周报"看板 |
| **Report（报表）** | 分析图表（折线/柱状/漏斗/留存等），**可独立存在**，可挂载到多个看板 | "近7天日活趋势"柱状图，挂在 A、B 两个看板上，位置不同 |
| **Folder（文件夹）** | 组织层，个人区或空间内；与 Dashboard 平级，不强制包含 | "日活分析"文件夹 |

**核心关系**：
- `appid 1:1 Space`——一个子包对应一个空间，运营创建时绑定 appid（非产品）
- `Space → (Dashboard | Folder)`——Dashboard 与 Folder 平级，Dashboard 可直挂 Space 或挂 Folder
- `Dashboard N:M Report`——通过 `dashboard_component` 关联表挂载，同一 Report 可挂多个 Dashboard，每个挂载点独立布局
- `Space/Dashboard 1:N asset_grant`——空间和看板均可独立分享

**口径澄清**：
- Report **可独立存在**（无任何 dashboard_component 关联行），保存时看板选填；独立报表对应 PRD"已存报表"
- 一个 Report 可挂载到多个 Dashboard，每个挂载点的布局坐标（position_x/y、width、height、sort_order、display_override_json）独立保存在 dashboard_component 关联行上
- Report 不直接持有 dashboard_id 与布局坐标（V009 合并的逆向）——挂载关系全部由 dashboard_component 承载
- Report.space_id 决定其所属 Space（NULL=个人区独立报表）
- Space 由运营创建，不懒创建；Space 不分享时仅 owner 可见
- Space 绑定的是 **appid（子包）**，不是产品（游戏）。同一产品的多个子包对应多个独立 Space

**目标层级**：

```
auth 域：应用组（AppGroup）→ 产品（Product）→ appid（子包）
                              ↑ 权限边界：userId → MemberAppGroup → AppGroup → appid

report 域：
  Space(1:1 appid, 运营创建) → Dashboard | Folder（平级）
                            ↓
                          Dashboard N:M Report（via dashboard_component，可独立存在）
  Member 个人区（scopeType=PERSONAL）→ Folder → Dashboard(space_id=null)
                                    ↓
                                  独立 Report(space_id=null) 或挂看板
```

归属链路：`appid → Space → (Dashboard | Folder)`，Dashboard 与 Report 为 N:M 挂载关系。下层创建时继承 `appId/spaceId`。

---

## 目标模型总览

```
appid (子包, event_center.app)
  └─ Space (空间, 1:1, 运营创建)
       ├─ Folder (文件夹, 空间内组织)         ← 组织层，可选
       ├─ Dashboard (看板, 可直挂 Space 或挂 Folder)
       │    └─ dashboard_component 关联行 → Report（每个挂载点独立布局）
       └─ Report (独立报表, 可无挂载，对应"已存报表")

Member (个人区, 不进 Space)
  └─ Folder (个人文件夹)
       └─ Dashboard (个人看板, space_id=null)
            └─ dashboard_component 关联行 → Report

  Report 与 Dashboard 为 N:M 关系，通过 dashboard_component 关联表承载挂载与布局
```

---

## Auth 与 Event 域（已有实体，仅引用）

| 实体 | 关键字段 | 存放库 | 说明 |
|------|---------|--------|------|
| ProjectGroup | id, company_id, project_group_name | qpointplay_auth | 项目组，组织层；report 域不再引用 |
| AppGroup | id, project_group_id, app_group_name | qpointplay_auth | 应用组，**权限边界**，管理多个产品 |
| AppGroupApplication | app_group_id, application_id | qpointplay_auth | 应用组 ↔ appid 关联（application_id 跨库引用 event_center.app.app_id） |
| MemberAppGroup | member_id, app_group_id | qpointplay_auth | 成员 ↔ 应用组，**权限判定依据** |
| Product | id, product_name, product_type_id | qpointplay_event_center | 产品（游戏母体），一个产品有多个 appid |
| appid（子包） | app_id, product_id | qpointplay_event_center | 数据上报最小单位，与 Space 1:1 |

权限链路：`userId → MemberAppGroup → AppGroup → appid → Space`。成员所属应用组决定其可见的 appid（子包）集合，即可见的全部 Space key。

---

## Report 域（qpointplay_report）

### Space（空间）——运营创建、与 appid 1:1

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | BIGINT | PK 雪花 | BaseEntity |
| app_id | BIGINT | UK, NOT NULL | 1:1 关联 appid（子包，event_center.app.app_id） |
| app_group_id | BIGINT | NOT NULL | 权限边界（冗余自 appid 所属 AppGroup，便于查询） |
| name | VARCHAR(20) | CHECK 1–20 | 空间名（可独立于子包名重命名） |
| owner_id | BIGINT | NOT NULL | 所有者（支持移交） |
| global_filter_json | JSON | NULL | 空间级全局筛选（PRD"空间页面筛选"） |
| sort_order | INT | ≥0 | 排序 |
| row_version | BIGINT | CAS | 乐观锁（重命名/移交并发） |
| status | VARCHAR | CHECK ∈ {ACTIVE, DISABLED} | 状态 |
| 审计字段 | — | BaseEntity | created_by/time, updated_by/time, del_flag |

- UK `uk_space_app_id(app_id)`——1:1 保证
- 索引 `idx_space_app_group(app_group_id, sort_order)`——按应用组列空间
- 索引 `idx_space_owner(owner_id, updated_time)`——owner 我的空间

### asset_grant（统一分享）——Space + Dashboard 共用

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | BIGINT | PK 雪花 | BaseEntity |
| asset_type | VARCHAR | CHECK ∈ {SPACE, DASHBOARD} | 分享资产类型 |
| asset_id | BIGINT | NOT NULL | SPACE→spaceId；DASHBOARD→dashboardId |
| member_id | BIGINT | NOT NULL | 被分享成员 |
| role | VARCHAR | CHECK ∈ {VIEWER, COLLABORATOR} | 角色 |
| granted_by | BIGINT | NOT NULL | 授权人 |
| 审计字段 | — | BaseEntity | |

- UK `uk_asset_grant(asset_type, asset_id, member_id)`——一成员对一资产仅一条记录
- 索引 `idx_asset_grant_member(member_id, asset_type)`——查"分享给我的"

**可见性规则**：

| 角色 | 看见 | 编辑 |
|------|------|------|
| OWNER（隐含，不走 grant 表） | ✓ | ✓ |
| COLLABORATOR | ✓ | ✓ |
| VIEWER | ✓ | ✗ |

用户可见 Space/Dashboard = `owner_id=userId` OR `asset_grant` 命中。Space 分享不自动分享其下看板，看板独立分享。

### Folder（文件夹）——组织层

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | BIGINT | PK 雪花 | BaseEntity |
| scope_type | VARCHAR | CHECK ∈ {PERSONAL, SPACE} | 归属类型 |
| scope_id | BIGINT | NOT NULL | PERSONAL→userId；SPACE→spaceId |
| name | VARCHAR(20) | CHECK 1–20 | 文件夹名 |
| folder_type | VARCHAR | CHECK ∈ {CUSTOM, UNCLASSIFIED} | 系统文件夹保护 |
| owner_id | BIGINT | NOT NULL | 创建者 |
| sort_order | INT | ≥0 | 排序 |
| 审计字段 | — | BaseEntity | |

- UK `uk_folder_scope_type_name(scope_type, scope_id, folder_type, name)`
- 索引 `idx_folder_scope_order(scope_type, scope_id, sort_order)`
- 子文件夹继承父文件夹 scope（不允许跨 scope 嵌套）

### Dashboard（看板）——页面画布

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | BIGINT | PK 雪花 | BaseEntity |
| space_id | BIGINT | NULL（空=个人看板） | 所属空间 |
| folder_id | BIGINT | NULL（空=直挂 Space） | 看板挂载位置；**Dashboard 与 Folder 平级，不强制挂 Folder** |
| name | VARCHAR(20) | CHECK 1–20 | 看板名 |
| owner_id | BIGINT | NOT NULL | 所有者 |
| default_time_json | JSON | — | 默认时间范围 |
| sort_order | INT | ≥0 | 排序 |
| row_version | BIGINT | CAS | 乐观锁 |
| status | VARCHAR | CHECK ∈ {ACTIVE, DISABLED} | 状态 |
| 审计字段 | — | BaseEntity | |

- 索引 `idx_dashboard_location(space_id, folder_id, sort_order)`
- 索引 `idx_dashboard_owner(owner_id, updated_time)`
- 看板不存 `appId`——纯布局容器，不绑定 appid

### Report（报表）——可独立存在的分析图表

柱状图、折线图、漏斗、留存、分布等具体分析图表。**Report 可独立存在**（无任何 dashboard_component 关联行，对应 PRD"已存报表"），也可挂载到多个 Dashboard。每个 Report 包含完整的分析定义（查什么指标、什么维度、什么时间范围）。**Report 不再持有 dashboard_id 与布局坐标**——挂载关系全部由 `dashboard_component` 关联表承载（V009 合并的逆向）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | BIGINT | PK 雪花 | BaseEntity |
| app_group_id | BIGINT | NULL | 应用组 ID（权限边界，空间报表由 space 反推；个人区独立报表由请求传入） |
| report_code | VARCHAR | UK | 唯一编码 |
| name | VARCHAR(50) | — | 报表名 |
| remark | VARCHAR(80) | — | 备注 |
| analysis_type | VARCHAR | — | 分析类型（EVENT/RETENTION/FUNNEL 等） |
| owner_id | BIGINT | NOT NULL | 所有者 |
| space_id | BIGINT | NULL | 所属空间（NULL=个人区独立报表） |
| current_revision_id | BIGINT | DEFAULT 0 | 当前修订 |
| status | VARCHAR | ACTIVE 等 | 状态 |
| row_version | BIGINT | CAS | 乐观锁 |
| 审计字段 | — | BaseEntity | |

- 索引 `idx_report_space(space_id)`
- 索引 `idx_report_app_group(app_group_id, space_id)`
- UK `uk_report_code(report_code)`
- `definition.appId` 是数据源（具体查哪个 appid/子包），`appGroupId` 是权限边界
- 空间内的 Report（space_id 非空）：`definition.appId` 必须 = `space.appId`（**禁止跨空间取数**）
- 个人区独立报表（space_id=null）：`definition.appId` 可为用户有权的任意 appid

### dashboard_component（看板-报表关联）——V009 合并的逆向

承载 Dashboard 与 Report 的 N:M 挂载关系。同一 Report 可挂多个 Dashboard，每个挂载点独立布局。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | BIGINT | PK 雪花 | BaseEntity |
| dashboard_id | BIGINT | NOT NULL | 所属看板 |
| report_id | BIGINT | NOT NULL | 关联报表 |
| position_x | INT | DEFAULT 0 | 画布横坐标（按看板独立） |
| position_y | INT | DEFAULT 0 | 画布纵坐标（按看板独立） |
| width | INT | DEFAULT 0 | 网格宽度（按看板独立） |
| height | INT | DEFAULT 0 | 网格高度（按看板独立） |
| sort_order | INT | DEFAULT 0 | 组件排序（按看板独立） |
| display_override_json | JSON | NULL | 展示覆盖（标题、颜色等，按看板独立） |
| 审计字段 | — | BaseEntity | |

- UK `uk_dashboard_component(dashboard_id, report_id)`——同一 (看板, 报表) 仅一条关联
- 索引 `idx_dc_dashboard(dashboard_id, sort_order)`——看板内组件列表
- 索引 `idx_dc_report(report_id)`——查"报表挂在哪些看板"
- 挂载一致性：创建关联时 `Dashboard.space_id` 必须 = `Report.space_id`（同空间或同为 null）
- 删除 Report → 级联软删所有 dashboard_component 关联行（PRD"删除后引用报表提示依赖失效"）
- 删除 Dashboard → 级联软删其下所有 dashboard_component 关联行

### 不变实体

ReportRevision（不可变快照）、ReportPublishedVersion（发布版本）、QueryAudit、ExportJob、AsyncQueryTask——结构与索引不变，均通过 `report.id` 引用，不直接关联 space/projectGroup。

---

## 归属与权限规则

| 规则 | 说明 |
|------|------|
| Space 创建 | 运营通过 report 服务创建，选 appid（校验未被其他空间绑定），不懒创建 |
| 继承时序 | Space（创建时绑 appid）→ Folder/Dashboard（创建/移动时继承 spaceId）→ Report（创建时直接写 spaceId） |
| Dashboard-Folder 关系 | Space 下 Dashboard 与 Folder **平级**，Dashboard 可直挂 Space（folder_id=null）或挂 Folder，无强制所属 |
| Report 独立性 | Report 可独立存在（无 dashboard_component 关联行），保存时看板选填；独立报表对应 PRD"已存报表" |
| 多看板挂载 | 一个 Report 可挂多个 Dashboard，每个挂载点的布局坐标独立保存在 dashboard_component 关联行上 |
| 数据权限边界 | **Report 的数据权限由 auth 应用组（AppGroup）直接控制**：`userId → MemberAppGroup → AppGroup → appid`。report 服务每次查询前向 auth 取 `reportPermissionSnapshot`，校验用户对 appid 的可见性 |
| 空间可见性 | Space/Dashboard：owner 或 asset_grant 命中才可见；不分享则仅 owner |
| 空间内数据 | 空间内 Report（space_id 非空）：`definition.appId` 必须 = `space.appId`（**禁止跨空间取数**） |
| 挂载一致性 | 创建 dashboard_component 关联时，`Dashboard.space_id` 必须 = `Report.space_id`（同空间或同为 null） |
| 个人区降级 | space_id 为空时（个人区独立报表/个人看板），权限降级为 appid 级别校验（请求传入的 appGroupId 须在用户权限快照内） |

---

## 级联与清理

| 触发 | 级联效果 |
|------|---------|
| Space 删除（不可恢复） | 其下 Folder（SPACE scope）软删；**Dashboard 移动到 owner 的【未分组】系统文件夹**（`space_id=null`、`folder_id=owner` 的 `UNCLASSIFIED` 文件夹，对应 PRD"我的看板/未分组"），Dashboard 的 dashboard_component 关联行随 Dashboard 跟随（dashboard_id 不变）；**独立 Report（无关联）space_id 置 null 归还 owner 个人区** |
| auth 删 appid | 触发 report 侧按 spaceId 清空引用（`POST /report/internal/spaces/{spaceId}/clearReferences`） |
| auth 删 AppGroup | 触发 report 侧按 appGroupId 清空 Report 引用 |
| Dashboard 删除 | 其下所有 dashboard_component 关联行软删；asset_grant(DASHBOARD) 清理（Report 本身不删） |
| Report 删除 | 其所有 dashboard_component 关联行软删（PRD"删除后引用报表提示依赖失效"） |

> Space 删除语义以 PRD 为准：看板不软删、不丢弃，而是归还到各 owner 的个人【未分组】文件夹；独立报表归还个人区；空间文件夹随空间软删。该操作不可恢复。

---

## 迁移历史

| 版本 | 内容 |
|------|------|
| V001–V005 | 019 初始建表（query_audit, report_assets, dashboard_assets, export_job, async_query_task） |
| V006 | 移除 Space 层 + CollaborationGrant；dashboard.space_id→project_group_id；report 新增 dashboard_id/project_group_id；folder CHECK 改 PERSONAL/PROJECT |
| V007 | 移除 folder.app_id——文件夹是项目组下组织层级，不绑定应用 |
| V008 | 移除 dashboard.app_id——看板纯布局容器；report.app_id→app_group_id——权限边界是应用组 |
| V009 | 合并 dashboard_component 到 report——报表直接含布局坐标，删除 dashboard_component 表 |
| V010 | 重新引入 Space（绑定 appid 1:1，运营创建）+ asset_grant 统一分享表；移除 ProjectGroup 引用 |
| V011 | dashboard/report 加 space_id 列 + 新索引；folder scope_type CHECK 改 {PERSONAL, SPACE}；重建系统文件夹触发器 |
| V012 | 数据迁移：project_group_id → space_id；删旧 project_group_id 列与旧索引 |
| V013 | **逆向 V009**：从 report 拆出 dashboard_component 关联表（布局坐标 position_x/y、width、height、sort_order、display_override_json 从 report 迁移到关联行，按 report.dashboard_id → dashboard_id 建立 junction）；删 report.dashboard_id 与布局字段；dashboard_id=null 的 Report 保留为独立报表（无 junction 行） |
