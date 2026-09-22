# Report 模块

> 状态：模型重构中（V022）
> 版本：V022
> 日期：2026-07-27

## 文档列表

| 文档 | 说明 |
|---|---|
| [数据模型](数据模型.md) | Report 域实体定义：Space/asset_grant/Folder/Dashboard/Report，含字段约束、索引、归属权限规则、级联清理、迁移历史 |
| [E2E 全链路操作手册](E2E-全链路操作手册.md) | 本地 docker 环境下 Space → Folder → Dashboard → Report 的完整 curl 链路，含校验用例和端点清单 |
| [E2E 分析全链路操作手册](E2E-分析全链路操作手册.md) | 分析模块（事件/留存/漏斗/分布/属性/用户细查）的 curl 链路，含校验用例和端点清单 |

---

## 模块概览

```text
report 域（qpointplay_report）
  ├─ Space（空间）       — 运营创建，与 appid 1:1 绑定，可分享
  │    ├─ Folder（文件夹） — 空间内组织层（与 Dashboard 平级，不强制包含）
  │    ├─ Dashboard（看板） — 页面画布，可直挂 Space 或挂 Folder，可分享
  │    │    └─ dashboard_component 关联行 → Report（每个挂载点独立布局）
  │    └─ Report（独立报表） — 可无挂载独立存在，对应"已存报表"
  │
  └─ Member 个人区（不进 Space）
       └─ Folder（个人文件夹）
            └─ Dashboard（个人看板，space_id=null）
                 └─ dashboard_component 关联行 → Report

  Report 与 Dashboard 为 N:M 关系，通过 dashboard_component 关联表承载挂载与布局
  asset_grant（统一分享）— Space 与 Dashboard 共用，角色 VIEWER/COLLABORATOR
```

---

## 核心口径

### 业务概念

| 概念 | 是什么 | 存放位置 |
|------|--------|---------|
| 项目组（ProjectGroup） | 公司下组织层，管理应用组 | auth.`project_group` |
| 应用组（AppGroup） | 权限边界，管理多个游戏 | auth.`app_group` |
| 产品（Product） | 具体的游戏母体，一个产品有多个子包 | event_center.`product` |
| appid（子包） | 数据上报最小单位，与 Space 1:1 | event_center.`app`（`app_id`） |

层级：`项目组 → 应用组 → 产品 → appid`。登录人员通过 `MemberAppGroup` 关联应用组，可见该组下全部产品及其 appid。

### Report 域概念

- **Space**：运营创建、与 appid 1:1 绑定的容器，可被分享。不分享则仅 owner 可见。
- **Dashboard**：页面画布，挂在 Space 下或个人区，可被分享。Space 分享不自动分享其下看板。与 Folder 平级，可不挂 Folder。
- **Report**：分析图表（折线/柱状/漏斗/留存等），**可独立存在**（无挂载，对应"已存报表"），可挂载到多个看板，每个挂载点独立布局。
- **Folder**：组织层，`scopeType=PERSONAL`（个人）或 `SPACE`（空间内）；与 Dashboard 平级，不强制包含。
- **dashboard_component**：看板-报表关联表，承载 N:M 挂载与布局坐标（V009 合并的逆向）。

## 权限链路

```
userId → MemberAppGroup → AppGroup → appid → Space
```

成员所属应用组决定其可见的 appid 集合，即可见的全部 Space key。**Report 的数据权限由 auth 应用组直接控制**：report 服务每次查询前向 auth 取 `reportPermissionSnapshot`，校验用户对 appid 的可见性。Space/Dashboard 的可见性 = `owner_id=userId` OR `asset_grant` 命中。

## 关键约束

| 约束 | 说明 |
|------|------|
| appid 1:1 Space | 一个子包只能绑定一个空间（`uk_space_app_id`） |
| Report 可独立 + 多看板挂载 | Report 不持 dashboard_id；可独立存在（无关联行），可挂多个看板，每个挂载点布局独立（`dashboard_component` 关联表） |
| Dashboard-Folder 平级 | Space 下 Dashboard 与 Folder 平级，Dashboard 可直挂 Space（folder_id=null）或不挂 Folder，无强制所属 |
| 挂载一致性 | 创建 dashboard_component 关联时，`Dashboard.space_id` 必须 = `Report.space_id`（同空间或同为 null） |
| 禁止跨空间 | 空间内 Report 的 `definition.appId` 必须 = `space.appId` |
| 个人区降级 | `space_id=null` 的个人区独立报表，`definition.appId` 可为用户有权的任意 appid |

## 迁移版本

| 版本 | 内容 |
|------|------|
| V001–V009 | 019–021 初始建表与历次对齐（详见数据模型.md 迁移历史） |
| V010 | 重新引入 Space（绑定 appid 1:1）+ asset_grant 统一分享表 |
| V011 | dashboard/report 加 space_id；folder scope_type CHECK 改 {PERSONAL, SPACE} |
| V012 | 数据迁移 project_group_id → space_id；删旧 project_group_id 列与旧索引 |
| V013 | 逆向 V009：从 report 拆出 dashboard_component 关联表，布局坐标从 report 迁移到关联行，删 report.dashboard_id 与布局字段 |

## 关联文档

- PRD：[AI社交数据平台PRD](../AI社交数据平台PRD.md)（看板 / 项目空间 / 文件夹章节）
- 权限链路：[auth-permission-path](../../auth-permission-path.md)
- 基础设施配置：[infrastructure-config](../../infrastructure-config.md)
