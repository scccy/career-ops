# 数据平台 API 设计规范

> 版本：V1.0
> 日期：2026-07-11
> 状态：草稿

---

## 1. 总则

### 1.1 适用范围

本规范适用于数据平台所有 HTTP API 接口设计，涵盖 URL 路径、HTTP 方法、参数校验、响应结构、错误码、分页等通用约定。

### 1.2 基础约束

| 项目 | 约束 |
|---|---|
| 协议 | HTTPS（生产环境） |
| 请求体格式 | `application/json` |
| 响应体格式 | `application/json` |
| 字符编码 | UTF-8 |
| Java 侧 | Spring Boot 3 + `@RestController` |

---

## 2. URL 路径设计

### 2.1 对外路径 vs Controller 路径

服务名前缀由 gateway 路由层统一处理（`stripPrefix=1`），Controller 的 `@RequestMapping` 不包含服务名。

```
对外路径（前端调用）：  {HTTP方法} /{服务名}/{业务层}/{具体业务...}/{动词}
                                          ↑ gateway 剥离
Controller 路径（后端）： {HTTP方法} /{业务层}/{具体业务...}/{动词}
```

例如 `/bi/permission/permissionGroup/page` → gateway 剥离 `/bi/` → 下游收到 `/permission/permissionGroup/page`。

**本文档后续路径示例均指对外路径**，Controller 路径去掉第一段服务名即可。

### 2.2 分层结构（对外路径）

| 层级 | 说明 | 取值 |
|---|---|---|
| 第 1 层 | 服务名，gateway 路由前缀 | `bi` / `auth` / `event` / `sync` |
| 第 2 层 | 大业务模块 | `user` / `permission` / `backfill` / `report` / `app` / `minigame` 等 |
| 第 3+ 层 | 具体业务，按复杂度自然展开 | 驼峰命名 |
| 末层 | 操作动词 | 见 2.4 |

### 2.3 命名规则

- **驼峰命名**：每段 `camelCase`，禁止 kebab-case
  - `permissionGroup` ✅
  - `permission-group` ❌
- **层数**：简单业务 3 层，复杂业务 4-5 层，不强制对齐

### 2.4 动词约定

| 动词 | 方法 | 说明 |
|---|---|---|
| `detail` | GET | 按 ID 查询单条详情 |
| `list` | GET | 无参或简单条件全量列表 |
| `page` | POST | 分页 + 多条件筛选 |
| `create` | POST | 新增 |
| `update` | POST | 更新 |
| `delete` | POST | 删除 |
| `enable` / `disable` | POST | 启用 / 停用 |

### 2.5 路径示例

| 接口 | 对外路径 | Controller 路径 |
|---|---|---|
| 权限组详情 | `GET /auth/permission/permissionGroup/detail` | `/permission/permissionGroup/detail` |
| 权限组列表 | `GET /auth/permission/permissionGroup/list` | `/permission/permissionGroup/list` |
| 权限组分页 | `POST /auth/permission/permissionGroup/page` | `/permission/permissionGroup/page` |
| 创建权限组 | `POST /auth/permission/permissionGroup/create` | `/permission/permissionGroup/create` |
| 小游戏报表分页 | `POST /bi/report/minigame/income/page` | `/report/minigame/income/page` |
| 巨量引擎回填 | `POST /bi/backfill/oceanengine/customReport` | `/backfill/oceanengine/customReport` |

### 2.6 特殊路径

以下路径不遵循分层结构，属于独立入口：

| 路径 | 方法 | 说明 |
|---|---|---|
| `/login` | POST | 登录，gateway 白名单放行 |
| `/logout` | POST | 登出 |
| `/changePassword` | POST | 修改密码 |

---

## 3. HTTP 方法

### 3.1 方法选择

| 场景 | 方法 | 判断标准 |
|---|---|---|
| 简单查询 | GET | 按 ID 查详情、无参全量列表、1-2 个简单参数筛选 |
| 复杂查询 | POST | 分页查询、多条件组合筛选、含数组/嵌套对象/日期范围等复杂参数 |
| 写操作 | POST | 新增 / 更新 / 删除 / 启用 / 停用 / 导出 / 触发任务 等 |

### 3.2 简单查询（GET）

参数通过 URL Query String 传递，使用 `@RequestParam` 接收：

```java
// ✅ 正确 — 按 ID 查详情
@GetMapping("/detail")
public ResultData<VO> detail(@RequestParam Long id) { ... }

// ✅ 正确 — 无参全量列表
@GetMapping("/list")
public ResultData<List<VO>> list() { ... }

// ✅ 正确 — 简单筛选
@GetMapping("/list")
public ResultData<List<VO>> list(
    @RequestParam(required = false) String name,
    @RequestParam(required = false) Long companyId) { ... }
```

### 3.3 复杂查询（POST）

参数通过 JSON Body 传递，使用 `@RequestBody` 接收：

```java
// ✅ 正确 — 分页 + 多条件筛选
@PostMapping("/page")
public ResultData<Page<VO>> page(@RequestBody PageQueryRequest request) { ... }

// ✅ 正确 — 含数组/日期范围的复杂筛选
@PostMapping("/list")
public ResultData<List<VO>> list(@RequestBody FilterRequest request) { ... }
```

### 3.4 写操作（POST）

```java
// ✅ 正确
@PostMapping("/create")
public ResultData<?> create(@Valid @RequestBody CreateRequest request) { ... }

@PostMapping("/update")
public ResultData<?> update(@Valid @RequestBody UpdateRequest request) { ... }

@PostMapping("/delete")
public ResultData<?> delete(@RequestBody IdRequest request) { ... }
```

---

## 4. 请求参数

### 4.1 参数传递方式

| 场景 | 方式 | 注解 |
|---|---|---|
| GET 简单查询 | URL Query String | `@RequestParam` |
| POST 复杂查询 | JSON Body | `@RequestBody` |
| POST 写操作 | JSON Body | `@RequestBody` |
| 内部接口路径参数 | URL Path | `@PathVariable`（仅限 internal） |

### 4.2 参数校验

使用 Jakarta Validation 注解在 DTO 上声明校验规则，Controller 用 `@Valid` 触发：

```java
// POST 接口 — @Valid @RequestBody
@PostMapping("/create")
public ResultData<?> create(@Valid @RequestBody CreateRequest request) { ... }

// GET 接口 — 简单参数在方法签名上校验，复杂场景抽 DTO
@GetMapping("/detail")
public ResultData<VO> detail(@RequestParam @NotNull Long id) { ... }
```

```java
// DTO 侧
public class CreateRequest {
    @NotBlank(message = "名称不能为空")
    private String name;

    @NotNull(message = "公司ID不能为空")
    private Long companyId;
}
```

### 4.3 分页请求

所有分页查询请求 DTO 必须继承 `BasePageQuery`，子类禁止重复声明 `pageNum` / `pageSize`：

```java
// ✅ 正确
public class PermissionGroupPageQueryRequest extends BasePageQuery {
    private String name;
    private Long companyId;
}

// ❌ 错误 — 直接声明分页字段
public class PermissionGroupPageQueryRequest {
    private Integer pageNum;
    private Integer pageSize;
    private String name;
}
```

---

## 5. 响应结构

### 5.1 统一响应体

所有 Controller 返回值必须包装为 `ResultData<T>`，禁止直接返回实体或 String：

```java
// ✅ 正确
@PostMapping("/create")
public ResultData<?> create(@Valid @RequestBody CreateRequest request) {
    service.create(request);
    return ResultData.ok("创建成功");
}

// ✅ 正确 — 泛型返回
@GetMapping("/detail")
public ResultData<VO> detail(@RequestParam Long id) {
    return ResultData.ok(service.getById(id));
}
```

### 5.2 ResultData 结构

```json
{
    "code": 200,
    "msg": "操作成功",
    "data": { ... },
    "success": true
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | int | 业务状态码，200 表示成功 |
| `msg` | string | 提示信息 |
| `data` | object / null | 返回数据 |
| `success` | boolean | 是否成功 |

### 5.3 成功响应

- `ResultData.ok()` — 无数据返回
- `ResultData.ok(data)` — 带数据返回
- `ResultData.ok("自定义消息")` — 自定义消息

### 5.4 失败响应

- `ResultData.fail("错误描述")` — 通用失败
- `ResultData.fail(code, "错误描述")` — 自定义错误码
- 禁止在 Controller 中 `try-catch` 手动包装错误，异常交给全局异常处理器

---

## 6. 分页规范

### 6.1 路径约定

分页接口路径末层固定为 `page`，使用 POST 方法：

```
POST /bi/permission/permissionGroup/page
POST /bi/report/minigame/income/page
POST /auth/user/page
```

### 6.2 请求体

分页请求 DTO 继承 `BasePageQuery`（见 4.3）。

### 6.3 响应体

分页响应使用 MyBatis-Plus 的 `Page<T>` 对象：

```json
{
    "code": 200,
    "msg": "操作成功",
    "data": {
        "records": [ ... ],
        "total": 100,
        "size": 20,
        "current": 1,
        "pages": 5
    },
    "success": true
}
```

---

## 7. 错误码

### 7.1 HTTP 状态码

| HTTP | code | 场景 |
|---|---|---|
| 200 | 200 | 成功 |
| 400 | 400 | 参数校验失败 |
| 401 | 401 | 未带 token / 签名错 / 过期 |
| 403 | 403 | 无权限 |
| 404 | 404 | 资源不存在 |
| 429 | 429 | 限流命中 |
| 500 | 500 | 服务内部错误 |

### 7.2 业务错误码

业务错误码在 `ResultData.fail(code, msg)` 中自定义，各模块自行登记。

---

## 8. 内部接口与对外接口

### 8.1 路径区分

| 类型 | 路径特征 | 调用方 | 鉴权 |
|---|---|---|---|
| 对外接口 | 不含 `/internal/` 段 | 前端 / 外部客户端 | gateway JWT 验签 |
| 内部接口 | `/internal/**` | 后端服务间 Feign `lb://` | mTLS + 内部信任 |

### 8.2 内部接口规则

- 路径以 `/internal/**` 开头
- 服务本机注册，不经 gateway
- 可使用 `@GetMapping`、`@PathVariable`
- 使用 `@SkipAuth` 跳过网关鉴权
- 新增内部接口必须在本文档登记

### 8.3 安全边界

- gateway 对 `/<prefix>/internal/**` 返回 404
- 下游服务清理客户端传入的 `X-User-*` Header
- 内部接口不得暴露到外部网络

---

## 9. 认证与鉴权

### 9.1 认证链路

```
客户端 → gateway（JWT 验签、注入 X-User-* Header）→ 下游服务（消费 Header）
```

- 下游服务不得自行解析 JWT
- 下游服务通过 `AuthContextHolder` 获取当前用户身份

### 9.2 鉴权注解

| 注解 | 说明 |
|---|---|
| `@AdminOnly` | 仅平台管理员可访问 |
| `@SkipAuth` | 跳过认证（内部接口） |

---

## 10. Swagger 文档

- 每个 Controller 必须加 `@Tag(name = "...")` 中文描述
- 每个接口必须加 `@Operation(summary = "...")` 中文描述
- 内部接口不暴露到 Swagger

```java
@RestController
@RequestMapping("/permission/permissionGroup")
@Tag(name = "权限组管理")
public class PermissionGroupController {

    @Operation(summary = "分页查询权限组")
    @PostMapping("/page")
    public ResultData<Page<VO>> page(@RequestBody PageQueryRequest query) { ... }
}
```

---

## 11. 控制器类规范

### 11.1 类命名与依赖注入

- 类名：`{业务名}Controller`
- 注入：`@RequiredArgsConstructor` + `private final`，禁止 `@Autowired` 字段注入
- Controller 只注入业务 Service，不直接注入 MpService

### 11.2 完整示例

```java
@RestController
@RequestMapping("/permission/permissionGroup")
@RequiredArgsConstructor
@Tag(name = "权限组管理")
public class PermissionGroupController {

    private final PermissionGroupService permissionGroupService;

    // 简单查询 — GET
    @Operation(summary = "查询权限组详情")
    @GetMapping("/detail")
    public ResultData<PermissionGroupDetailVO> detail(@RequestParam Long id) {
        return ResultData.ok(permissionGroupService.getDetail(id));
    }

    // 无参全量列表 — GET
    @Operation(summary = "查询全部权限组")
    @GetMapping("/list")
    public ResultData<List<DimPermissionGroupMp>> list() {
        return ResultData.ok(permissionGroupService.list());
    }

    // 分页查询 — POST
    @Operation(summary = "分页查询权限组")
    @PostMapping("/page")
    public ResultData<Page<PermissionGroupPageVO>> page(
            @RequestBody PermissionGroupPageQueryRequest query) {
        return ResultData.ok(permissionGroupService.page(query));
    }

    // 写操作 — POST
    @Operation(summary = "创建权限组")
    @PostMapping("/create")
    public ResultData<?> create(@Valid @RequestBody CreatePermissionGroupRequest request) {
        permissionGroupService.create(request);
        return ResultData.ok("创建成功");
    }

    @Operation(summary = "更新权限组")
    @PostMapping("/update")
    public ResultData<?> update(@Valid @RequestBody UpdatePermissionGroupRequest request) {
        permissionGroupService.update(request);
        return ResultData.ok("更新成功");
    }

    @Operation(summary = "删除权限组")
    @PostMapping("/delete")
    public ResultData<?> delete(@RequestBody IdRequest request) {
        permissionGroupService.delete(request.getId());
        return ResultData.ok("删除成功");
    }
}
```

---

## 12. 存量代码迁移

现有代码主要问题：

| 问题 | 现状 | 目标 |
|---|---|---|
| 路径风格不一致 | `/system/permissionGroup`、`/api/admin/app` | 统一为 `/{业务层}/{具体业务}` |
| 查询用 POST | 全部 `@PostMapping` | 简单查询改为 `@GetMapping` |

迁移原则：
- 新增接口必须严格遵守本规范
- 存量接口随业务迭代逐步改造，不专门做一次性迁移

---

## 附录：快速检查清单

- [ ] 路径是否遵循 `/{服务名}/{业务层}/{具体业务}/{动词}` 结构？
- [ ] 路径是否为驼峰命名（禁止 kebab-case）？
- [ ] 简单查询是否用 GET？复杂查询/写操作是否用 POST？
- [ ] 是否需要 `@Valid` 校验？
- [ ] 返回值是否为 `ResultData<T>`？
- [ ] 分页请求是否继承了 `BasePageQuery`？
- [ ] 分页路径末层是否为 `page`？
- [ ] Controller 是否只注入业务 Service？
- [ ] 是否加了 `@Tag` 和 `@Operation`？