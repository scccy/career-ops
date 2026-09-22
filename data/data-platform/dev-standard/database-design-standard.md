# 数据平台统一建表规范

> 版本：V3.0
> 日期：2026-07-11
> 状态：评审中（V3.0 基于 design-questions.md 讨论结论修订）

---

## 1. 总则

### 1.1 适用范围

本规范适用于数据平台所有新建 MySQL 业务表的建模与设计。

### 1.2 基础约束

| 项目 | 约束 |
|---|---|
| 数据库 | MySQL 8.0 |
| 字符集 | `utf8mb4`，排序规则 `utf8mb4_0900_ai_ci` |
| 存储引擎 | InnoDB |
| Java 侧 | MyBatis-Plus，实体类统一继承 `BaseEntity<T> extends Model<T>` |

---

## 2. 命名规范

### 2.1 通用规则

- 库名、表名、字段名、索引名一律 `snake_case`，全小写
- 不使用 MySQL 保留字
- 命名自解释，避免无意义缩写

### 2.2 表名

- 单数形式：`channel`，非 `channels`
- 支持分层前缀：`system_`、`data_` 等，如 `system_channel`、`data_product`
- M:N 关联表：`{主表A}_{主表B}`，如 `user_role`
- 1:N 明细表：`{主表}_{业务}_item`，如 `order_item`

### 2.3 字段名

- Java 侧 `camelCase`，MyBatis-Plus 自动映射到 `snake_case`
- 主键统一 `id`
- 每张业务主表必须有 `{业务语义}_id`（本表业务编码）+ `{业务语义}_name`（本表名称）
  - 使用**业务语义**命名，不含表前缀。如 `system_channel` 表用 `channel_id`，不用 `system_channel_id`
- 引用其他表时：`{引用实体}_id` + `{引用实体}_name`
- `{xxx}_name` 是 `{xxx}_id` 的解释字段，方便人类阅读，不参与索引
- **核心：整个库中 `{xxx}_id` 全局同义，看到字段名即知业务含义，无需追溯来源表**

### 2.4 索引与约束命名

| 类型 | 命名规则 | 示例 |
|---|---|---|
| 主键 | 默认 `PRIMARY` | — |
| 唯一索引 | `uk_{字段或简称}` | `uk_channel_id`、`uk_user_channel` |
| 普通索引 | `idx_{字段}` | `idx_company_id` |
| CHECK 约束 | `chk_{语义}` | `chk_status_valid` |

---

## 3. 数据类型约定

### 3.1 通用规则

- DB 层不做 `NOT NULL` 强制约束，由应用层代码保证非空校验，减少需求变动带来的 DDL 影响
- 字符串字段指定合理长度，禁止无脑 `VARCHAR(255)`
- 枚举语义统一使用 `VARCHAR` + 应用层枚举，**不在 DB 层使用 `ENUM` 类型**

### 3.2 常用类型对照

| 业务语义 | 数据库类型 | Java 类型 | 说明 |
|---|---|---|---|
| 主键 `id` | `BIGINT` | `Long` | 雪花算法生成，MyBatis 写入用 |
| 业务编码 `{实体}_id` | `BIGINT` | `Long` | 本表业务唯一标识，全局同义（引用枚举表时为 type_id，引用普通表时为 id） |
| 业务名称 `{实体}_name` | `VARCHAR(128)` | `String` | `{实体}_id` 的解释，方便阅读，不建索引 |
| 金额 | `DECIMAL(18,4)` | `BigDecimal` | 4 位小数，禁止 `FLOAT` / `DOUBLE` |
| 计数 / 数量 | `INT` 或 `BIGINT` | `Integer` / `Long` | 按上限选择 |
| 布尔 | `TINYINT` | `Integer` | 0/1 |
| 状态 / 枚举 | `VARCHAR(16~32)` | 应用层 enum | 值用 `UPPER_SNAKE_CASE` |
| 短文本 | `VARCHAR(32~256)` | `String` | 名称、编码等 |
| 长文本 | `TEXT` | `String` | 仅描述、备注类字段 |
| JSON 结构 | `JSON` | `String` | MySQL 8.0 原生 JSON 类型 |
| 时间戳 | `DATETIME` | `LocalDateTime` | 应用层统一时区约定 |
| 日期 | `DATE` | `LocalDate` | 仅日期场景 |

### 3.3 枚举值命名

- 数据库与代码保持一致的 `UPPER_SNAKE_CASE`
- 跨表相同语义的枚举值必须一致

---

## 4. BaseEntity 与审计字段

### 4.1 基类定义

```java
@Data
@EqualsAndHashCode(callSuper = true)
@Accessors(chain = true)
public abstract class BaseEntity<T extends BaseEntity<T>> extends Model<T> implements Serializable {

    @TableId(value = "id", type = IdType.ASSIGN_ID)
    private Long id;

    @TableField(value = "created_by", fill = FieldFill.INSERT)
    private String createdBy;

    @TableField(value = "created_time", fill = FieldFill.INSERT)
    private LocalDateTime createdTime;

    @TableField(value = "updated_by", fill = FieldFill.INSERT_UPDATE)
    private String updatedBy;

    @TableField(value = "updated_time", fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedTime;

    @TableLogic
    @TableField("del_flag")
    private Integer delFlag = 0;
}
```

### 4.2 审计字段约定

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `id` | BIGINT | — | 雪花主键，应用层生成 |
| `created_by` | VARCHAR(64) | NULL | 创建人标识 |
| `created_time` | DATETIME | CURRENT_TIMESTAMP | 创建时间 |
| `updated_by` | VARCHAR(64) | NULL | 最后更新人 |
| `updated_time` | DATETIME | CURRENT_TIMESTAMP ON UPDATE | 更新时间 |
| `del_flag` | TINYINT | 0 | 逻辑删除，0=未删，1=已删 |

### 4.3 适用边界

| 表类型 | 是否继承 BaseEntity |
|---|---|
| 业务主表、关联表、明细子表 | **必须** |
| 日志表（只追加） | 否，仅保留 `id` + `created_by` + `created_time` |
| 快照 / 汇总表 | 视场景 |

### 4.4 审计字段填充策略

| 层级 | 角色 | 适用场景 |
|---|---|---|
| 应用层（MyBatis-Plus `MetaObjectHandler`） | **主** | 所有经由业务 Service 的 CRUD |
| MySQL 层（`DEFAULT` / `ON UPDATE CURRENT_TIMESTAMP`） | **兜底** | 直接 SQL、DBA 修数据、批处理脚本等非应用层写入路径 |

- 应用层填充失效时，MySQL 层兜底，保证审计字段不为空
- 两边同时配置是有意为之，不是冗余

---

## 5. 核心建模范式：`{实体}_id` + `{实体}_name` 全局同义

### 5.1 原则

每张业务主表必须有 `{业务语义}_id`（本表业务编码，BIGINT）和 `{业务语义}_name`（本表名称）。
引用其他表时，使用 `{引用实体}_id` + `{引用实体}_name`。

**业务语义不含表前缀**。如 `system_channel` 表用 `channel_id`，不用 `system_channel_id`。

**关键：`{xxx}_id` 在整个库中全局同义。** 在 `xxx` 表里是自己的业务编码，在其他表里是引用 `xxx` 的外键——同名同义。

`{xxx}_name` 是 `{xxx}_id` 的解释字段，方便人类阅读，与 `{xxx}_id` 一对一绑定，不单独建索引。

**数据分两类存储：**

| 类型 | 存储方式 | 典型场景 | 示例 |
|---|---|---|---|
| 枚举型 | 统一存 `system_enum` 表 | 前端交互的快速查询枚举 | 渠道、角色、状态、支付方式 |
| 普通表 | 独立业务表 | 流水型、业务功能型 | 公司、项目、用户、订单、权限点 |

**示例：**

```
system_enum 表（统一枚举）：
  id             — 雪花 PK
  enum_id        — 枚举类型 ID（如 100=渠道，200=角色）
  enum_name      — 枚举类型名称（如 "渠道"、"角色"）
  type_id        — 具体枚举项 ID（全局唯一，作为外键引用目标）
  type_name      — 具体枚举项名称（如 "巨量"、"管理员"）

company 表（普通表）：
  id            — 雪花 PK
  company_id    — 公司业务编码（自己的，BIGINT）
  company_name  — 公司名称（自己的）

data_product 表（普通表，引用枚举和普通表）：
  id            — 雪花 PK
  product_id    — 商品业务编码（自己的，BIGINT）
  product_name  — 商品名称（自己的）
  channel_id    — 渠道业务编码（引用 system_enum.type_id，BIGINT）
  channel_name  — 渠道名称（引用 system_enum.type_name）
  company_id    — 公司业务编码（引用 company.company_id，BIGINT）
  company_name  — 公司名称（引用 company.company_name）
```

### 5.2 设计理由

| 目标 | 说明 |
|---|---|
| 自解释 | 整个库里看到 `channel_id` 就知道是渠道，不需要找来源表 |
| 复杂 SQL 友好 | 嵌套查询、数据湖查询中不用一层层追别名 |
| 可读 | 不 JOIN 也能直接展示 `xxx_name`，无需回头查源表 |
| 可追溯 | 数据导出到数仓/BI 时，名称字段自带可读性 |
| 可降级 | 源表改名时，历史数据的 `xxx_name` 作为快照值仍可展示 |

### 5.3 维护约束

- `{xxx}_id` 是不可变的稳定标识，一经写入禁止变更，作为唯一索引的承载字段。
- `{xxx}_name` 是可变字段，作为 `{xxx}_id` 的可读解释，**不进入索引**（因其可能变更，进索引反而误导查询）。
- 引用方的 `xxx_name` 默认作为写入时的快照保留，主表 name 变更时**不级联更新**。
- 若业务上确实需要名称强一致（少见），建模阶段必须显式声明采用"级联更新"策略，并在应用层 Service 保证一致性。
- `xxx_id` 与 `xxx_name` 必须成对写入，禁止只更新其中之一。

### 5.4 `{xxx}_id` 生成规则

`{xxx}_id` 由应用层生成，按引用目标类型分两种情况：

| 引用目标 | `{xxx}_id` 值 | 生成方式 | 说明 |
|---|---|---|---|
| 枚举表 `system_enum` | `type_id` | 枚举表统一分配（雪花或序列号） | 前端交互的快速查询枚举 |
| 普通表 | 目标表的 `{实体}_id` | 目标表生成（雪花或业务算法） | 流水型、业务功能型实体 |

- 引用枚举时：`{实体}_id` 存 `system_enum.type_id`
- 引用普通表时：`{实体}_id` 存目标表的 `{实体}_id` 字段
- 两者类型都是 BIGINT，外键引用方式一致

### 5.5 统一枚举表 `system_enum`

所有前端交互的快速查询枚举统一存储在 `system_enum` 表，不单独建业务表。

**字段结构：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT | 雪花主键 |
| `enum_id` | INT | 枚举类型 ID（如 100=渠道，200=角色，300=状态） |
| `enum_name` | VARCHAR(64) | 枚举类型名称（如 "渠道"、"角色"、"状态"） |
| `type_id` | BIGINT | 具体枚举项 ID（全局唯一，作为外键引用目标） |
| `type_name` | VARCHAR(128) | 具体枚举项名称（如 "巨量"、"管理员"、"启用"） |
| `sort` | INT | 排序号 |
| `status` | TINYINT | 是否启用（0=禁用，1=启用） |
| 审计字段 | — | 继承 BaseEntity |

**设计要点：**

- `enum_id` 用于分类（前端按 enum_id 查询某类枚举）
- `type_id` 是外键引用目标（全局唯一，BIGINT）
- `type_name` 是展示名称（冗余存储，避免 JOIN）
- 不需要 `{实体}_value` 字段，`type_id + type_name` 足够
- 前端统一接口：`GET /api/enums?enumId=100` 获取渠道列表

**适用场景：**

- 渠道、支付方式、数据字典
- 平台角色、状态、类型
- 其他前端下拉选择、字典展示用的枚举

**不适用场景：**

- 有额外业务属性的实体（如公司、项目、用户）→ 用普通表
- 业务功能型实体（如权限点，有 path、method 等属性）→ 用普通表
- 每个租户/公司独立的枚举（如公司角色）→ 用普通表

### 5.6 `enum_id` 分段分配机制

`enum_id` 采用**分段分配**，避免冲突、便于管理：

| enum_id 段 | 分配用途 | 示例 |
|---|---|---|
| 100–199 | 业务来源类（渠道、平台等） | 100=渠道 |
| 200–299 | 状态类 | 200=启用/禁用 |
| 300–399 | 类型类 | 300=资源类型 |
| 400–499 | 业务维度类 | 400=数据维度类型 |
| 500–599 | 操作类 | 500=审计动作 |
| ... | 按需扩展 | — |

**规则：**

- 新增枚举类型必须先申请 `enum_id` 段，登记在规范附录的"已注册枚举类型清单"中
- 同段内 `enum_id` 唯一，跨段不冲突
- `type_id` 在同一 `enum_id` 内唯一（由 UK `(enum_id, type_id)` 或全局 UK `(type_id)` 保证）

### 5.7 `{实体}_code` 可选对外显示码

当业务需要一个**人类可读的对外编码**（如合同号、ERP 编号、对外公司代码）时，使用 `{实体}_code VARCHAR` 作为**独立字段**，与 `{实体}_id BIGINT` 是不同概念：

| 字段 | 类型 | 用途 | 生成方式 |
|---|---|---|---|
| `{实体}_id` | BIGINT | 业务主键，业务层 / FK 引用都用它 | 雪花 / 序列号（默认雪花） |
| `{实体}_code` | VARCHAR | 对外显示码，人类可读，跨系统对接用 | 业务规则（如 "C001"、"ORD-2026-001"） |

**示例：`company` 表**

```
id              BIGINT        框架主键
company_id      BIGINT        业务主键（雪花，UK）
company_code    VARCHAR(64)   对外显示码（可选，UK），如 "C001"
company_name    VARCHAR(128)  公司名称
```

**规则：**

- `{实体}_code` 是**可选字段**，仅在业务确实需要对外可读编码时才加
- `{实体}_code` 与 `{实体}_id` 独立，都是 UK
- FK 引用统一走 `{实体}_id`，不用 `{实体}_code`
- 命名使用 `{实体}_code`，不要和 `{实体}_id` 混淆

---

## 6. 主键 / 外键 / 唯一键

### 6.1 主键

- 所有表使用 `id BIGINT` 单主键，由应用层雪花算法生成
- 禁止使用自增主键、联合主键、UUID、业务主键

### 6.2 外键

- 不建立物理外键约束，由应用层维护引用完整性
- 外键字段格式 `{引用实体}_id`（BIGINT），配套 `{引用实体}_name`（VARCHAR）
- 引用目标分两类：
  - **引用枚举表**：`{引用实体}_id` 存 `system_enum.type_id`
  - **引用普通表**：`{引用实体}_id` 存目标表的 `{实体}_id`
- 两者类型都是 BIGINT，外键引用方式一致
- `{引用实体}_name` 冗余存储目标名称，避免 JOIN，由应用层级联更新

### 6.3 唯一键

- 主表：业务编码唯一，如 `uk_channel_id(channel_id)`
- 关联表：外键组合唯一，如 `uk_user_channel(user_id, channel_id)`
- 多态外键场景：`xxx_type_id` 必须纳入唯一键组合

### 6.4 多态外键

**优先通过设计避免多态**（合并表、分列等）。确实需要时，使用简化 3 字段模式：

| 字段 | 类型 | 说明 |
|---|---|---|
| `{引用语义}_type` | VARCHAR(16) | 引用来源类型，裸字符串（如 `'GROUP'` / `'USER'`），合法值由应用层 Java 枚举维护 |
| `{引用语义}_id` | BIGINT | 引用来源业务编码（引用目标的 `{实体}_id` 或 `system_enum.type_id`） |
| `{引用语义}_name` | VARCHAR(128) | 引用来源名称（冗余） |

**示例：`data_permission_rule` 表**

```
owner_type    VARCHAR(16)   -- 'GROUP' / 'USER'，Java enum 维护合法值
owner_id      BIGINT         -- GROUP 时引用 data_permission_group.group_id；USER 时引用 company_user.user_id
owner_name    VARCHAR(128)   -- 冗余名称
```

**规则：**

- `{引用语义}_type` **不强制入 `system_enum`**，合法值由应用层 Java 枚举集中维护
- 命名使用 `{引用语义}_type`（如 `owner_type`、`resource_type`），不要只用 `type`（避免与关键字冲突）
- 唯一键必须包含 `{引用语义}_type`

### 6.5 条件唯一键（MySQL 8.0 Generated Column）

MySQL 不支持 SQL 标准的 `UNIQUE WHERE` 条件唯一索引。当业务需要"某字段为 NULL 时不参与 UK / 为某值时参与 UK"时，使用 **Generated Column + UK** 模式：

**示例：`role` 表（公司级 + 项目级角色合并）**

需求：
- `scope=COMPANY` 时，`(company_id, code)` 唯一（项目级角色不占位）
- `scope=PROJECT` 时，`(company_id, project_id, code)` 唯一

实现：

```sql
CREATE TABLE `role` (
  `id`                  BIGINT,
  `role_id`             BIGINT,
  `company_id`          BIGINT,
  `project_id`          BIGINT        -- scope=COMPANY 时为 NULL
  `project_id_virtual`  BIGINT AS (IFNULL(`project_id`, 0)) STORED,
  `code`                VARCHAR(64),
  `scope`               VARCHAR(16),  -- COMPANY / PROJECT（显式冗余，便于查询）
  ...
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_id` (`role_id`),
  UNIQUE KEY `uk_scope_code` (`company_id`, `project_id_virtual`, `code`)
)
```

**规则：**

- 虚拟列命名：`{原字段}_virtual`
- 虚拟列必须 `STORED`（不能 `VIRTUAL`，否则无法进 UK）
- 默认值选取要保证不同"逻辑作用域"不会撞车（如 NULL → 0）
- 显式冗余一个 `scope` 字段便于查询与可读性

---

## 7. 索引规范

### 7.1 强制要求

- 每个 `{xxx}_id` 字段必须有索引
- 业务唯一字段必须有唯一索引

### 7.1.1 `{xxx}_name` 字段的索引策略

`{xxx}_name` 与 `{xxx}_id` 一对一，两种索引分别判断：

| 索引类型 | 是否加 | 理由 |
|---|---|---|
| **唯一索引（UK）** | ❌ 不加 | 唯一性已由 `{xxx}_id` 的 UK 承载 |
| **查询索引（普通索引）** | ✅ 按场景决定 | 列表页按名称搜索 / 排序是高频操作，无索引会全表扫描 |

**判断清单：**

- **默认加**：表的主列表页支持按名称搜索 / 排序（如 `company_name`、`role_name`、`xxx_group_name`）
- **不加**：字段仅用于详情展示，业务上不会按名称筛选 / 排序
- **形式**：普通索引 `idx_{实体}_name ({实体}_name)`，不是 UK

---

### 7.2 联合索引原则

- 遵循最左前缀原则，区分度高的列放左边
- 等值查询列在前，范围查询列在后
- 单索引列数不超过 5

### 7.3 禁止项

- 禁止在低基数列上建单列索引，除非与其他列组合
- 禁止对大文本字段建索引，必要时使用前缀索引
- 单表索引数量建议不超过 6 个

---

## 8. 软删除约定

### 8.1 行为定义

- `del_flag = 1` 表示已逻辑删除
- MyBatis-Plus 的 `@TableLogic` 在所有查询中自动追加 `del_flag = 0`
- **已软删除的数据逻辑上不出现在业务前端**

### 8.2 恢复流程

已软删除的数据不参与普通 CRUD，必须走专门恢复流程：

1. 管理员通过专用恢复接口触发
2. 恢复前校验业务唯一键是否冲突
3. `del_flag` 改回 0 后，数据重新进入普通 CRUD 可见范围

### 8.3 唯一键与软删除

- 唯一索引**不含** `del_flag`
- 已软删除的记录不会以相同业务键再次创建（业务 id 永久占用）

### 8.4 级联软删除

- 主表软删时，**应用层 Service 必须级联处理所有引用该主表的从表记录**
- 级联逻辑属于业务逻辑，由 Service 层编排，**禁止使用 MySQL 触发器或外键级联**
- 已软删除的数据仅在专用"垃圾箱 / 管理后台"入口可见，不参与普通 CRUD
- 恢复流程：由管理员通过专用恢复接口触发，恢复时必须同步恢复所有级联软删的从表记录

### 8.5 关联表使用物理删除

**M:N 关联表**（如 `role_resource_group`、`user_role` 等）不使用软删除，**直接物理 DELETE**：

- 关联表的本质是"表达映射关系"，不是业务实体，无"垃圾箱恢复"需求
- 关联表的 UK 不含 `del_flag`（规范 8.3），软删后同一对 (A_id, B_id) 无法重新插入
- 业务上的"解绑"= 物理 DELETE，"绑定"= INSERT，符合直觉

**规则：**

- 关联表（规范 9.1 的"关联表（M:N）"分类）**继承 BaseEntity 但永不使用 del_flag**
- 主表软删时，**应用层 Service 物理 DELETE 所有关联该主表的关联表记录**（不走级联软删）
- 恢复主表时，绑定关系**不自动恢复**（需业务方重新绑定）

**1:N 明细子表**（如 `order_item`）的软删除策略视业务而定：
- 子项跟随主表生命周期 → 跟随主表软删
- 子项有独立查询需求 → 独立软删

---

## 9. 表分类与 DDL 模板

### 9.1 表分类

| 类型 | 继承 BaseEntity | 典型用途 |
|---|---|---|
| 统一枚举表 | 是 | 前端交互的快速查询枚举（渠道、角色、状态等） |
| 普通表（业务实体） | 是 | 公司、项目、用户、订单、权限点等 |
| 关联表（M:N） | 是 | 用户-角色、用户-渠道等 |
| 明细子表（1:N） | 是 | 订单明细等 |
| 日志表（只追加） | 否 | 操作日志、审计日志 |

### 9.2 普通表模板

```sql
CREATE TABLE `{表名}` (
  `id` BIGINT COMMENT '框架主键（MyBatis-Plus 雪花插件自动填充）',
  `{实体}_id` BIGINT COMMENT '业务主键（默认雪花，应用层生成，可作为 FK 引用目标）',
  `{实体}_name` VARCHAR(128) COMMENT '业务名称',
  -- `{实体}_code` VARCHAR(64) COMMENT '对外显示码（可选，仅当业务需要人类可读对外编码时加）',
  -- 其他业务字段（引用其他实体使用 {引用实体}_id BIGINT + {引用实体}_name VARCHAR）--
  `created_by` VARCHAR(64) COMMENT '创建人',
  `created_time` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by` VARCHAR(64) COMMENT '更新人',
  `updated_time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag` TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_{实体}_id` (`{实体}_id`)
  -- UNIQUE KEY `uk_{实体}_code` (`{实体}_code`)  -- 仅当有 {实体}_code 字段时
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='{表中文名}';
```

### 9.3 条件唯一键模板（Generated Column）

当需要"某字段为 NULL 时不参与 UK"时使用：

```sql
CREATE TABLE `{表名}` (
  `id` BIGINT COMMENT '框架主键',
  `{实体}_id` BIGINT COMMENT '业务主键',
  `owner_id` BIGINT COMMENT '所有者 ID',
  `scope_id` BIGINT COMMENT '作用域 ID（某些 scope 下为 NULL）',
  `scope_id_virtual` BIGINT AS (IFNULL(`scope_id`, 0)) STORED COMMENT '条件 UK 虚拟列',
  `code` VARCHAR(64) COMMENT '编码',
  `scope` VARCHAR(16) COMMENT '作用域（显式冗余，便于查询）',
  ...审计字段...
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_{实体}_id` (`{实体}_id`),
  UNIQUE KEY `uk_scope_code` (`owner_id`, `scope_id_virtual`, `code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='{表中文名}';
```

### 9.4 日志表模板

```sql
CREATE TABLE `{表名}_log` (
  `id` BIGINT COMMENT '雪花主键',
  -- 业务字段 --
  `created_by` VARCHAR(64) COMMENT '操作人',
  `created_time` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='{表中文名}';
```

### 9.5 统一枚举表模板

```sql
CREATE TABLE `system_enum` (
  `id` BIGINT COMMENT '框架主键',
  `enum_id` INT COMMENT '枚举类型 ID（按段分配：100-199 业务来源 / 200-299 状态 / 300-399 类型 ...）',
  `enum_name` VARCHAR(64) COMMENT '枚举类型名称（如 "渠道"、"角色"）',
  `type_id` BIGINT COMMENT '具体枚举项 ID（全局唯一，外键引用目标，默认雪花，可按需改为分段序列号）',
  `type_name` VARCHAR(128) COMMENT '具体枚举项名称（如 "巨量"、"管理员"）',
  `sort` INT DEFAULT 0 COMMENT '排序号',
  `status` TINYINT DEFAULT 1 COMMENT '是否启用 0=禁用 1=启用',
  `created_by` VARCHAR(64) COMMENT '创建人',
  `created_time` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_by` VARCHAR(64) COMMENT '更新人',
  `updated_time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `del_flag` TINYINT DEFAULT 0 COMMENT '逻辑删除 0=未删 1=已删',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_type_id` (`type_id`),
  KEY `idx_enum_id` (`enum_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='统一枚举表';
```

---

## 10. Upsert 约定

### 10.1 分片提交

调用 `upsertBatch` 必须按 `BATCH_SIZE = 500` 分片：

```java
for (int i = 0; i < entities.size(); i += BATCH_SIZE) {
    mapper.upsertBatch(entities.subList(i, Math.min(i + BATCH_SIZE, entities.size())));
}
```

### 10.2 写入策略（按场景区分）

| 场景 | 写入方式 | 命中已软删记录时的处理 |
|---|---|---|
| 单条 CRUD（用户操作触发） | Service 层判断状态后 INSERT 或 UPDATE | 拒绝写入，由业务层决定报错或提示 |
| 批量同步 / ETL | Service 层先从缓存 / DB 加载"已删业务 id 集合"，过滤后再 `upsertBatch` 分片提交 | 已删记录在进入 upsert 之前即被过滤，不会进入 MySQL |

- 业务逻辑（是否写入、是否过滤）在 Service 层控制，MySQL 只负责存储
- 已删业务 id 集合推荐由 Redis 缓存维护，避免批量同步场景下每次查库

### 10.3 文本块

多行 SQL 使用 Java Text Blocks，避免字符串拼接：

```java
String sql = """
    INSERT INTO channel (id, channel_id, channel_name)
    VALUES (#{id}, #{channelId}, #{channelName})
    ON DUPLICATE KEY UPDATE
        channel_name = VALUES(channel_name)
    """;
```

---

## 11. 应用层一致性责任

以下约束数据库层不做强制（无物理外键、无 CHECK 约束），**统一由应用层 Service 负责校验**：

| 约束 | 责任归属 | 校验时机 |
|---|---|---|
| `{xxx}_id` 与 `{xxx}_name` 必须成对写入 / 更新 | Service 层 | 写入前 |
| 多态外键的 `xxx_type_id` 必须是已注册的合法类型 | Service 层 | 写入前 |
| 引用其他表的 `xxx_id` 必须在被引用表中存在 | Service 层 | 写入前 |
| 软删除操作必须走统一 Service 方法（含级联软删） | Service 层 | 操作入口 |
| 恢复操作必须同步恢复所有级联软删的从表记录 | Service 层 | 操作入口 |

- 禁止 DAO 层直接 `update del_flag = 1`，必须走统一软删 Service 方法
- 一致性校验失败时，Service 层抛出业务异常，不依赖数据库层报错

---

## 12. DDL 变更流程

1. 提交 DDL 变更申请，包含变更原因、影响范围、回滚方案
2. 评审通过后方可执行
3. 大表 DDL 使用在线 DDL 工具（如 `gh-ost` / `pt-osc`）
4. 变更记录归档