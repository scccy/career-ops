# 数据平台 — 开发规范

> 创建日期：2026-07-11
> 用途：数据平台所有后端开发共享的通用规范，与具体业务功能无关

---

## 规范清单

| 规范 | 文档 | 状态 | 说明 |
|---|---|---|---|
| 数据库设计规范 | [database-design-standard.md](database-design-standard.md) | V2.2 草稿 | 建表、命名、数据类型、索引、软删除等通用约定 |
| API 设计规范 | [api-design-standard.md](api-design-standard.md) | V1.0 草稿 | Controller 路由、HTTP 方法、请求 / 响应结构、错误码、分页等 |
| 服务开发规范 | `service-dev-standard.md` | 待编写 | 分层架构、Service / DAO 职责、事务、异常处理等 |

---

## 进行中的讨论

| 讨论主题 | 文档 | 状态 |
|---|---|---|
| 数据库设计规范 — 待确认清单 | [design-questions.md](design-questions.md) | 逐条讨论中 |

> 每份规范在定稿前，会以「待确认清单」的形式逐条讨论，结论回填到对应规范中。

---

## 规范与业务文档的关系

- **开发规范**：跨业务通用的技术约定（如"所有表必须有 id 主键"、"Controller 返回 ResultData"）
- **业务文档**（如 `permission/`、`event/`）：具体业务功能的设计，必须遵守开发规范，但可以在此基础上扩展（如权限模块的 RBAC 模型）

当业务文档与开发规范冲突时，应优先修订开发规范，而不是在业务文档中悄悄绕过。
