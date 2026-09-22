# E2E 基础链路操作手册

**环境**: 本地 docker（MySQL 8 / Redis 6 / Nacos） | **公司 ID**: `6001` | **日期**: 2026-07-27

## 概念

### 业务概念

| 概念 | 是什么 |
|------|--------|
| **项目组（ProjectGroup）** | 公司下组织层，管理应用组 |
| **应用组（AppGroup）** | 权限边界，管理多个游戏；登录人员可见游戏由此控制 |
| **产品（Product）** | 具体的游戏母体，一个产品有多个子包 |
| **appid（子包）** | 游戏的一个子包/接入端，数据上报最小单位，与 Space 1:1 |

层级：`项目组 → 应用组 → 产品 → appid`。

### Report 域概念

| 概念 | 是什么 |
|------|--------|
| **Space（空间）** | 运营创建、与 appid（子包）1:1 绑定的容器，可被分享 |
| **Dashboard（看板）** | 页面画布，挂在 Space 下或个人区，可被分享；与 Folder 平级，可不挂 Folder |
| **Report（报表）** | 分析图表，**可独立存在**，可挂载到多个看板，每个挂载点独立布局 |
| **Folder（文件夹）** | 组织层，个人区或空间内；与 Dashboard 平级，不强制包含 |
| **dashboard_component** | 看板-报表关联表，承载 N:M 挂载与布局坐标 |

**核心关系**：`appid 1:1 Space`、`Space → (Dashboard | Folder)`（平级）、`Dashboard N:M Report`（via dashboard_component）。Space 和 Dashboard 均可独立分享，不分享则仅 owner 可见。

## 前置条件

### 1. 启动基础设施

```bash
docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "mysql8|redis6|nacos"
```

### 2. 启动 auth 服务（30005）

```bash
cd /opt/project/qpointplay-data
mvn -Plocal -pl qpointplay-service/qpointplay-service-auth -am -DskipTests spring-boot:run
```

### 3. 启动 report 服务（30006，首次启动会执行 Flyway V001–V013 建表）

```bash
cd /opt/project/qpointplay-data
mvn -Plocal -pl qpointplay-service/qpointplay-service-report -am -DskipTests spring-boot:run
```

### 4. 现有数据概览

| 实体 | 数据 |
|------|------|
| 公司 | id=6001 |
| 应用组 | iOS 应用组(2077319410657390594)、Android 应用组(2077319410657390595)、另一个应用组(2077319410657390596) |
| appid（子包） | app_001(2077597832956723202)、app_002(2077613801926066177) 等（event_center.app） |
| 测试成员 | id=`2077643313543913473`，name=`rr`，email=`123@qq.com` |
| 成员所属应用组 | 经 `member_app_group` 推导：iOS/Android 应用组、另一个应用组 |

> 以下全链路使用成员 `rr`（id=2077643313543913473），appid `app_001`（id=2077597832956723202）。

---

## 一、获取登录 Token（SaaS 公司成员登录）

### 端点: `POST /auth/v1/login`

> 公司成员走 SaaS 登录（email + password），平台员工才走 `/auth/v1/platform/login`（username + password）。本手册的测试成员 `rr` 是公司成员。

```bash
curl -s -X POST http://localhost:30005/auth/v1/login \
  -H 'Content-Type: application/json' \
  -d '{"email": "123@qq.com", "password": "<实际密码>"}' | jq .
```

**将 accessToken 保存为环境变量**：

```bash
TOKEN="<从响应中复制 accessToken>"
```

> 若密码未知，也可以跳过登录——report 内部端点不需要 token，常规端点直连时设 `X-User-*` Header 即可。

---

## 二、验证成员权限快照

### 2.1 获取成员权限快照（验证 appIds）

**端点**: `GET /auth/internal/users/{userId}/reportPermissionSnapshot`

```bash
curl -s http://localhost:30005/auth/internal/users/2077643313543913473/reportPermissionSnapshot | jq .
```

**预期响应**（关键字段）：
```json
{
  "code": 200,
  "data": {
    "userId": 2077643313543913473,
    "appIds": ["2077597832956723202", "2077613801926066177", "app_001", "app_002"]
  }
}
```

> `appIds` 即成员可见的全部 Space key（App 与 Space 1:1）。`projectGroupIds` 在 report 域已停用，auth 侧保留兼容。

---

## 三、Space（空间）管理

> Space 由运营创建。下面用 X-User-Id 模拟运营身份。

### 3.1 创建空间（绑定 appid，1:1）

**端点**: `POST /report/space/create`

**请求参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | Long | 是 | 绑定的 appid/子包 ID（校验未被其他空间绑定） |
| name | String | 是 | 空间名称，≤20 字符 |
| sortOrder | Integer | 否 | 排序，默认 0 |

```bash
curl -s -X POST http://localhost:30006/report/space/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d '{
    "appId": 2077597832956723202,
    "name": "消消乐数据空间",
    "sortOrder": 0
  }' | jq .

SPACE_ID=$(上述响应的 .data.spaceId)
```

**预期响应**：
```json
{
  "code": 200,
  "data": {
    "spaceId": "<雪花 ID>",
    "appId": 2077597832956723202,
    "appGroupId": 2077319410657390594,
    "name": "消消乐数据空间",
    "ownerId": 2077643313543913473,
    "status": "ACTIVE",
    "sortOrder": 0
  }
}
```

### 3.2 校验：同一 App 不可重复绑定

```bash
curl -s -X POST http://localhost:30006/report/space/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d '{
    "appId": 2077597832956723202,
    "name": "重复空间"
  }' | jq .
```

**预期**：`code != 200`，提示该 App 已绑定空间。

### 3.3 查询空间分页（按应用组过滤）

**端点**: `POST /report/space/page`

```bash
# 查询当前用户可见的空间（owner 或被分享）
curl -s -X POST http://localhost:30006/report/space/page \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d '{
    "appGroupId": 2077319410657390594,
    "pageNum": 1,
    "pageSize": 10
  }' | jq '.data.records[] | {spaceId, name, appId, appGroupId, ownerId}'
```

### 3.4 空间详情

**端点**: `GET /report/space/detail`

```bash
curl -s "http://localhost:30006/report/space/detail?spaceId=$SPACE_ID" \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" | jq .
```

### 3.5 重命名空间

**端点**: `POST /report/space/update`

```bash
curl -s -X POST http://localhost:30006/report/space/update \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"name\": \"消消乐周报空间\",
    \"baseRevision\": 0,
    \"editToken\": \"$EDIT_TOKEN\"
  }" | jq .
```

> 重命名/移交需先获取编辑租约（见 3.7）。

### 3.6 分享空间与可见性验证

> PRD：Space 不分享则仅 owner 可见；分享后被分享成员可按角色查看/编辑。Space 分享不自动分享其下看板。

**端点**: `POST /report/space/share`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | Long | 是 | 空间 ID |
| memberId | Long | 是 | 被分享成员 |
| role | String | 是 | `VIEWER`（只读）或 `COLLABORATOR`（可编辑） |

**前置**：假设另有一名成员 B（id=`<成员B_ID>`，如 `2077640313543913472`），其原本看不到 `rr` 创建的空间。

#### 3.6.1 分享为 VIEWER

```bash
curl -s -X POST http://localhost:30006/report/space/share \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"memberId\": <成员B_ID>,
    \"role\": \"VIEWER\"
  }" | jq .
```

#### 3.6.2 验证：成员 B 现在能看到该空间

```bash
# 用成员 B 的 X-User-Id 查询空间分页，应能在结果中看到 $SPACE_ID
curl -s -X POST http://localhost:30006/report/space/page \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: <成员B_ID>" \
  -H "X-User-Name: <成员B名>" \
  -d '{
    "pageNum": 1,
    "pageSize": 50
  }' | jq ".data.records[] | {spaceId, name, ownerId, role}"
```

**预期**：响应含 `$SPACE_ID`，`role=VIEWER`。

#### 3.6.3 验证：VIEWER 不可编辑（被拦截）

```bash
# 成员 B 尝试重命名空间——应被拒（需 COLLABORATOR 或 owner）
curl -s -X POST http://localhost:30006/report/space/update \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: <成员B_ID>" \
  -H "X-User-Name: <成员B名>" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"name\": \"VIEWER 不该改成功\"
  }" | jq .
```

**预期**：`code != 200`，提示权限不足。

#### 3.6.4 升级为 COLLABORATOR

```bash
curl -s -X POST http://localhost:30006/report/space/share \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"memberId\": <成员B_ID>,
    \"role\": \"COLLABORATOR\"
  }" | jq .
```

> 同一成员对同一空间仅一条 grant 记录（`uk_asset_grant`），重复分享为升级/降级 role。

#### 3.6.5 验证：COLLABORATOR 可编辑

```bash
# 成员 B 获取编辑租约（COLLABORATOR 应能拿到）
B_LEASE=$(curl -s -X POST http://localhost:30006/report/asset/edit/acquire \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: <成员B_ID>" \
  -H "X-User-Name: <成员B名>" \
  -d "{
    \"targetType\": \"SPACE\",
    \"targetId\": $SPACE_ID,
    \"baseRevision\": 0
  }" | jq .)
B_EDIT_TOKEN=$(echo $B_LEASE | jq -r '.data.token')
B_BASE_REVISION=$(echo $B_LEASE | jq -r '.data.baseRevision')

# 成员 B 重命名空间——应成功
curl -s -X POST http://localhost:30006/report/space/update \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: <成员B_ID>" \
  -H "X-User-Name: <成员B名>" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"name\": \"成员B改的名\",
    \"baseRevision\": $B_BASE_REVISION,
    \"editToken\": \"$B_EDIT_TOKEN\"
  }" | jq .
```

#### 3.6.6 验证：Space 分享不自动分享其下看板

```bash
# 成员 B 查看其可见看板——不应包含 $DASHBOARD_ID（看板未单独分享）
curl -s -X POST http://localhost:30006/report/dashboard/page \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: <成员B_ID>" \
  -H "X-User-Name: <成员B名>" \
  -d '{
    "pageNum": 1,
    "pageSize": 50
  }' | jq ".data.records[] | {dashboardId, name}" | grep $DASHBOARD_ID || echo "看板未泄漏 ✓"
```

#### 3.6.7 取消分享

**端点**: `POST /report/space/unshare`

```bash
curl -s -X POST http://localhost:30006/report/space/unshare \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"memberId\": <成员B_ID>
  }" | jq .
```

**预期**：`asset_grant` 删除对应行；成员 B 再次查空间分页不再含 `$SPACE_ID`。

### 3.7 获取编辑租约（重命名/移交/删除前置）

**端点**: `POST /report/asset/edit/acquire`

```bash
LEASE_RESP=$(curl -s -X POST http://localhost:30006/report/asset/edit/acquire \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"targetType\": \"SPACE\",
    \"targetId\": $SPACE_ID,
    \"baseRevision\": 0
  }" | jq .)
EDIT_TOKEN=$(echo $LEASE_RESP | jq -r '.data.token')
BASE_REVISION=$(echo $LEASE_RESP | jq -r '.data.baseRevision')
```

### 3.8 移交空间

**端点**: `POST /report/space/transfer`

```bash
curl -s -X POST http://localhost:30006/report/space/transfer \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"newOwnerId\": <新 owner ID>,
    \"baseRevision\": $BASE_REVISION,
    \"editToken\": \"$EDIT_TOKEN\"
  }" | jq .
```

**预期**：移交后原 owner 变为 COLLABORATOR，新 owner 接管。

### 3.9 删除空间

**端点**: `POST /report/space/delete`

```bash
curl -s -X POST http://localhost:30006/report/space/delete \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"baseRevision\": $BASE_REVISION,
    \"editToken\": \"$EDIT_TOKEN\"
  }" | jq .
```

**预期**：空间软删，其下 Folder（SPACE scope）软删，Dashboard.space_id 置空（变个人看板，owner 保留），Report 跟随看板。

---

## 四、创建文件夹

### 4.1 创建空间文件夹

**端点**: `POST /report/folder/create`

**请求参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | String | 是 | 文件夹名称，≤20 字符 |
| scopeType | String | 是 | `SPACE`（空间内）或 `PERSONAL`（个人文件夹） |
| scopeId | Long | scopeType=SPACE 时必填 | 空间 ID |
| parentFolderId | Long | 否 | 父文件夹 ID（创建子文件夹时用） |
| sortOrder | Integer | 否 | 排序，默认 0 |

> 文件夹不再需要 `appId`——文件夹是空间下的组织层级，不绑定应用。

```bash
curl -s -X POST http://localhost:30006/report/folder/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"name\": \"日活分析\",
    \"scopeType\": \"SPACE\",
    \"scopeId\": $SPACE_ID,
    \"sortOrder\": 0
  }" | jq .

FOLDER_ID=$(上述响应的 .data.folderId)
```

**预期响应**：
```json
{
  "code": 200,
  "data": {
    "folderId": "<雪花 ID>",
    "scopeType": "SPACE",
    "scopeId": "<SPACE_ID>",
    "name": "日活分析",
    "folderType": "CUSTOM",
    "ownerId": 2077643313543913473,
    "sortOrder": 0
  }
}
```

### 4.2 创建子文件夹（继承父文件夹空间）

```bash
curl -s -X POST http://localhost:30006/report/folder/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"name\": \"渠道子目录\",
    \"scopeType\": \"SPACE\",
    \"scopeId\": $SPACE_ID,
    \"parentFolderId\": $FOLDER_ID,
    \"sortOrder\": 1
  }" | jq .
```

### 4.3 创建个人文件夹

```bash
curl -s -X POST http://localhost:30006/report/folder/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d '{
    "name": "我的个人收藏",
    "scopeType": "PERSONAL",
    "scopeId": 2077643313543913473,
    "sortOrder": 0
  }' | jq .
```

### 4.4 校验：不存在的空间被拒绝

```bash
curl -s -X POST http://localhost:30006/report/folder/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d '{
    "name": "应该失败",
    "scopeType": "SPACE",
    "scopeId": 9999999999999999999
  }' | jq .
```

**预期**：`code != 200`，提示空间不存在或无权限。

### 4.5 查询文件夹列表

**端点**: `POST /report/folder/list`

```bash
# 查询空间下的文件夹
curl -s -X POST http://localhost:30006/report/folder/list \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"scopeType\": \"SPACE\",
    \"scopeId\": $SPACE_ID
  }" | jq .

# 查询个人文件夹
curl -s -X POST http://localhost:30006/report/folder/list \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d '{
    "scopeType": "PERSONAL",
    "scopeId": 2077643313543913473
  }' | jq .
```

---

## 五、创建看板

### 5.1 在空间文件夹下创建看板（继承空间归属）

**端点**: `POST /report/dashboard/create`

**请求参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | Long | 否 | folderId 非空时省略（从文件夹自动推导） |
| folderId | Long | 否 | 文件夹 ID；**可空（看板直挂 Space，与 Folder 平级）** |
| name | String | 是 | 看板名称，≤20 字符 |
| defaultTimeRange | Object | 否 | 默认时间范围 |
| components | Array | 是 | 看板组件列表（初始可为空数组 `[]`） |

> 看板不再需要 `appId`——看板是纯布局容器，不绑定应用。看板与 Folder 平级，可不挂 Folder 直挂 Space。

```bash
curl -s -X POST http://localhost:30006/report/dashboard/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"folderId\": $FOLDER_ID,
    \"name\": \"日活看板\",
    \"defaultTimeRange\": {\"type\": \"LAST_7_DAYS\"},
    \"components\": []
  }" | jq .

DASHBOARD_ID=$(上述响应的 .data.dashboardId)
```

**预期响应**：
```json
{
  "code": 200,
  "data": {
    "dashboardId": "<雪花 ID>",
    "spaceId": "<SPACE_ID>",
    "folderId": "<FOLDER_ID>",
    "name": "日活看板",
    "ownerId": 2077643313543913473,
    "status": "ACTIVE",
    "components": []
  }
}
```

### 5.1.1 看板直挂 Space（不挂 Folder）

```bash
curl -s -X POST http://localhost:30006/report/dashboard/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"name\": \"直挂空间看板\",
    \"components\": []
  }" | jq .
```

**预期**：`folderId=null`、`spaceId=$SPACE_ID`——看板与 Folder 平级，可不挂 Folder。

### 5.2 创建个人看板

```bash
curl -s -X POST http://localhost:30006/report/dashboard/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d '{
    "name": "个人临时看板",
    "components": []
  }' | jq .
```

**预期**：`spaceId=null`（个人看板）。

### 5.3 查询看板分页（按空间过滤）

**端点**: `POST /report/dashboard/page`

```bash
# 查询空间 $SPACE_ID 下的看板
curl -s -X POST http://localhost:30006/report/dashboard/page \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"pageNum\": 1,
    \"pageSize\": 10
  }" | jq '.data.records[] | {dashboardId, name, spaceId, folderId}'

# 查询个人看板（不传 spaceId）
curl -s -X POST http://localhost:30006/report/dashboard/page \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d '{
    "pageNum": 1,
    "pageSize": 10
  }' | jq '.data.records[] | {dashboardId, name, spaceId}'
```

### 5.4 看板详情

**端点**: `POST /report/dashboard/detail`

```bash
curl -s -X POST http://localhost:30006/report/dashboard/detail \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{\"dashboardId\": $DASHBOARD_ID}" | jq .
```

### 5.5 分享看板与可见性验证

> 看板分享独立于空间分享：空间被分享不会自动分享其下看板，反之亦然。看板可被分享给空间外的成员（如个人看板分享）。

**端点**: `POST /report/dashboard/share`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dashboardId | Long | 是 | 看板 ID |
| memberId | Long | 是 | 被分享成员 |
| role | String | 是 | `VIEWER`（只读）或 `COLLABORATOR`（可编辑） |

#### 5.5.1 分享为 VIEWER

```bash
curl -s -X POST http://localhost:30006/report/dashboard/share \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"dashboardId\": $DASHBOARD_ID,
    \"memberId\": <成员B_ID>,
    \"role\": \"VIEWER\"
  }" | jq .
```

#### 5.5.2 验证：成员 B 能看到该看板（即使不在空间分享列表）

```bash
# 成员 B 查看其可见看板——应包含 $DASHBOARD_ID（即便空间未分享给 B）
curl -s -X POST http://localhost:30006/report/dashboard/page \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: <成员B_ID>" \
  -H "X-User-Name: <成员B名>" \
  -d '{
    "pageNum": 1,
    "pageSize": 50
  }' | jq ".data.records[] | {dashboardId, name, spaceId, role}"
```

**预期**：响应含 `$DASHBOARD_ID`，`role=VIEWER`。对应 PRD"共享给我的"分类。

#### 5.5.3 验证：VIEWER 不可编辑

```bash
# 成员 B 尝试更新看板布局——应被拒
curl -s -X POST http://localhost:30006/report/dashboard/update \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: <成员B_ID>" \
  -H "X-User-Name: <成员B名>" \
  -d "{
    \"dashboardId\": $DASHBOARD_ID,
    \"name\": \"VIEWER 不该改成功\"
  }" | jq .
```

**预期**：`code != 200`，提示权限不足。

#### 5.5.4 升级为 COLLABORATOR 并验证可编辑

```bash
curl -s -X POST http://localhost:30006/report/dashboard/share \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"dashboardId\": $DASHBOARD_ID,
    \"memberId\": <成员B_ID>,
    \"role\": \"COLLABORATOR\"
  }" | jq .

# 成员 B 获取编辑租约并更新看板——应成功
B_LEASE=$(curl -s -X POST http://localhost:30006/report/asset/edit/acquire \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: <成员B_ID>" \
  -H "X-User-Name: <成员B名>" \
  -d "{
    \"targetType\": \"DASHBOARD\",
    \"targetId\": $DASHBOARD_ID,
    \"baseRevision\": 0
  }" | jq .)
B_EDIT_TOKEN=$(echo $B_LEASE | jq -r '.data.token')
B_BASE_REVISION=$(echo $B_LEASE | jq -r '.data.baseRevision')

curl -s -X POST http://localhost:30006/report/dashboard/update \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: <成员B_ID>" \
  -H "X-User-Name: <成员B名>" \
  -d "{
    \"dashboardId\": $DASHBOARD_ID,
    \"name\": \"成员B改的看板名\",
    \"baseRevision\": $B_BASE_REVISION,
    \"editToken\": \"$B_EDIT_TOKEN\"
  }" | jq .
```

#### 5.5.5 取消分享

**端点**: `POST /report/dashboard/unshare`

```bash
curl -s -X POST http://localhost:30006/report/dashboard/unshare \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"dashboardId\": $DASHBOARD_ID,
    \"memberId\": <成员B_ID>
  }" | jq .
```

**预期**：`asset_grant(DASHBOARD)` 删除对应行；成员 B 再次查可见看板不再含 `$DASHBOARD_ID`。

### 5.6 移动看板到个人区

**端点**: `POST /report/dashboard/move`

**前置：获取编辑租约**（`targetType: DASHBOARD`）

```bash
LEASE_RESP=$(curl -s -X POST http://localhost:30006/report/asset/edit/acquire \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"targetType\": \"DASHBOARD\",
    \"targetId\": $DASHBOARD_ID,
    \"baseRevision\": 0
  }" | jq .)
EDIT_TOKEN=$(echo $LEASE_RESP | jq -r '.data.token')
BASE_REVISION=$(echo $LEASE_RESP | jq -r '.data.baseRevision')

# 移动到个人区
curl -s -X POST http://localhost:30006/report/dashboard/move \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"dashboardId\": $DASHBOARD_ID,
    \"baseRevision\": $BASE_REVISION,
    \"editToken\": \"$EDIT_TOKEN\"
  }" | jq .
```

**预期**：移动后看板的 `spaceId` 置空（成为个人看板），其下报表同步置空。

---

## 六、创建报表与挂载看板

> Report **可独立存在**（不挂任何看板），保存时 `dashboardId` 选填。一个 Report 可挂载到多个 Dashboard，每个挂载点独立保存布局坐标。挂载关系通过 `dashboard_component` 关联表承载（V009 合并的逆向）。
> 独立报表 = 无 dashboard_component 关联行的 Report，对应 PRD"已存报表"。

### 6.1 创建独立报表（不挂看板）

**端点**: `POST /report/report/create`

**请求参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | Long | 否 | 所属空间 ID（不传=个人区独立报表） |
| name | String | 是 | 报表名称，≤50 字符 |
| remark | String | 否 | 备注，≤80 字符 |
| appGroupId | Long | 空间内可省略 | 应用组 ID（权限边界）。空间内由 space 反推；个人区独立报表必填 |
| definition | Object | 是 | 分析定义（空间内：`appId` 必须 = space.appId；个人区：`appId` 为用户有权的任意 app） |

```bash
curl -s -X POST http://localhost:30006/report/report/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"name\": \"日活趋势\",
    \"remark\": \"近7天日活用户数趋势\",
    \"definition\": {
      \"appId\": 2077597832956723202,
      \"analysisType\": \"EVENT\",
      \"metrics\": [{\"eventCode\": \"login\", \"aggregation\": \"USER_COUNT\"}],
      \"timeRange\": {\"type\": \"LAST_7_DAYS\"}
    }
  }" | jq .

REPORT_ID=$(上述响应的 .data.reportId)
```

**预期**：`spaceId=$SPACE_ID`、无 `dashboardId` 字段、无 `dashboard_component` 关联行——独立报表状态。

### 6.2 把报表挂载到看板（dashboard_component 关联）

**端点**: `POST /report/dashboard/mountReport`

**请求参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dashboardId | Long | 是 | 目标看板 ID |
| reportId | Long | 是 | 要挂载的报表 ID |
| positionX / positionY / width / height | Integer | 否 | 该挂载点的布局坐标，默认 0 |
| sortOrder | Integer | 否 | 该挂载点的排序 |
| displayOverrideJson | Object | 否 | 该挂载点的展示覆盖 |

```bash
curl -s -X POST http://localhost:30006/report/dashboard/mountReport \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"dashboardId\": $DASHBOARD_ID,
    \"reportId\": $REPORT_ID,
    \"positionX\": 0,
    \"positionY\": 0,
    \"width\": 6,
    \"height\": 4
  }" | jq .
```

**预期**：写入 `dashboard_component` 关联行；挂载一致性校验 `Dashboard.space_id = Report.space_id`（同空间或同为 null）通过。

### 6.3 同一报表挂到第二个看板（多看板挂载，布局独立）

```bash
# 创建第二个看板
DASHBOARD_B=$(curl -s -X POST http://localhost:30006/report/dashboard/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{\"spaceId\": $SPACE_ID, \"name\": \"运营周报\", \"components\": []}" | jq -r '.data.dashboardId')

# 同一报表挂到第二个看板，布局不同（位置 (6,0)）
curl -s -X POST http://localhost:30006/report/dashboard/mountReport \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"dashboardId\": $DASHBOARD_B,
    \"reportId\": $REPORT_ID,
    \"positionX\": 6,
    \"positionY\": 0,
    \"width\": 6,
    \"height\": 4
  }" | jq .
```

**预期**：第二条 `dashboard_component` 关联行写入（UK(dashboard_id, report_id) 不冲突，因 dashboard_id 不同）；两个挂载点的布局坐标独立保存。

### 6.4 校验：跨空间挂载被拒

```bash
# 把空间 A 的报表挂到空间 B 的看板——dashboard.spaceId ≠ report.spaceId
curl -s -X POST http://localhost:30006/report/dashboard/mountReport \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"dashboardId\": <空间B的看板ID>,
    \"reportId\": $REPORT_ID
  }" | jq .
```

**预期**：`code != 200`，提示挂载一致性失败（dashboard.space_id ≠ report.space_id）。

### 6.5 校验：跨空间取数被拒（创建时）

```bash
# 在空间 A 内创建报表，但 definition.appId 指向空间 B 的应用
curl -s -X POST http://localhost:30006/report/report/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"name\": \"应该失败\",
    \"definition\": {
      \"appId\": 2077613801926066177,
      \"analysisType\": \"EVENT\",
      \"metrics\": []
    }
  }" | jq .
```

**预期**：`code != 200`，提示禁止跨空间取数。

### 6.6 个人区独立报表（definition.appId 可为任意有权 app）

```bash
# 个人区独立报表：不传 spaceId，appGroupId 必填（无 space 可反推）
curl -s -X POST http://localhost:30006/report/report/create \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"appGroupId\": 2077319410657390594,
    \"name\": \"跨应用对比\",
    \"definition\": {
      \"appId\": 2077597832956723202,
      \"analysisType\": \"EVENT\",
      \"metrics\": []
    }
  }" | jq .
```

### 6.7 解挂报表（删除关联行，Report 本身不删）

**端点**: `POST /report/dashboard/unmountReport`

```bash
curl -s -X POST http://localhost:30006/report/dashboard/unmountReport \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"dashboardId\": $DASHBOARD_ID,
    \"reportId\": $REPORT_ID
  }" | jq .
```

**预期**：`dashboard_component` 关联行软删；Report 本身不删；报表在其他看板的挂载不受影响。

### 6.8 查询报表分页（按空间过滤）

**端点**: `POST /report/report/page`

```bash
# 查询空间内全部报表（含独立 + 已挂载）
curl -s -X POST http://localhost:30006/report/report/page \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"pageNum\": 1,
    \"pageSize\": 10
  }' | jq '.data.records[] | {reportId, name, spaceId}'

# 仅查"已存未放置"独立报表（无 dashboard_component 关联）
curl -s -X POST http://localhost:30006/report/report/page \
  -H 'Content-Type: application/json' \
  -H "X-User-Id: 2077643313543913473" \
  -H "X-User-Name: rr" \
  -d "{
    \"spaceId\": $SPACE_ID,
    \"unmountedOnly\": true,
    \"pageNum\": 1,
    \"pageSize\": 10
  }" | jq '.data.records[] | {reportId, name}'
```

对应 PRD"已存报表"列表。

---

## 七、删除级联验证

### 7.1 删除空间 → 看板归还 owner 未分组，独立报表归还个人区

> PRD 规定：删除空间后，空间下的看板将移动到看板所有者的【我的看板/未分组文件夹】，该操作不可恢复。看板不软删、不丢弃，而是归还到各 owner 的个人【未分组】系统文件夹；独立报表（无挂载）space_id 置 null 归还 owner 个人区；空间文件夹随空间软删。

**端点**: `POST /report/space/delete`（见 3.9，需编辑租约）

**验证**：
```bash
# 看板已移动到 owner 的【未分组】系统文件夹（space_id=null, folder_id=owner UNCLASSIFIED）
docker exec mysql8 mysql -uroot -pRootPass2024 -e \
  "SELECT id, name, space_id, folder_id, owner_id FROM qpointplay_report.dashboard WHERE id=$DASHBOARD_ID AND del_flag=0;"

# 看板的 dashboard_component 关联行：dashboard_id 不变，跟随看板
docker exec mysql8 mysql -uroot -pRootPass2024 -e \
  "SELECT id, dashboard_id, report_id FROM qpointplay_report.dashboard_component WHERE dashboard_id=$DASHBOARD_ID AND del_flag=0;"

# 已挂载报表：space_id=null（跟随看板归还），关联行仍在
docker exec mysql8 mysql -uroot -pRootPass2024 -e \
  "SELECT id, name, space_id FROM qpointplay_report.report WHERE id=$REPORT_ID AND del_flag=0;"

# 独立报表（无关联）：space_id=null，归还个人区
docker exec mysql8 mysql -uroot -pRootPass2024 -e \
  "SELECT id, name, space_id FROM qpointplay_report.report WHERE space_id IS NULL AND owner_id=2077643313543913473 AND del_flag=0 LIMIT 5;"

# 空间文件夹随空间软删
docker exec mysql8 mysql -uroot -pRootPass2024 -e \
  "SELECT id, name, del_flag FROM qpointplay_report.folder WHERE scope_type='SPACE' AND scope_id=$SPACE_ID;"

# Space 软删，不可恢复
docker exec mysql8 mysql -uroot -pRootPass2024 -e \
  "SELECT id, name, del_flag FROM qpointplay_report.space WHERE id=$SPACE_ID;"
```

**预期结果**：

| 实体 | 级联后状态 |
|------|-----------|
| Space | 软删（del_flag=1，不可恢复） |
| 空间文件夹（SPACE scope） | 软删（del_flag=1） |
| 看板 | `space_id=NULL`、`folder_id=owner` 的 `UNCLASSIFIED` 文件夹 ID（行仍在，del_flag=0，归还到 owner 个人未分组） |
| 看板的 dashboard_component 关联行 | `dashboard_id` 不变（跟随看板），关联行仍在 |
| 已挂载报表 | `space_id=NULL`（跟随看板归还），关联行仍指向原看板 |
| 独立报表（无关联） | `space_id=NULL`，归还 owner 个人区 |

### 7.2 级联清空端点幂等验证

**端点**: `POST /report/internal/spaces/{spaceId}/clearReferences`

> 此内部端点供 auth 删 appid 时调用，按 spaceId 把看板归还 owner 未分组、独立报表归还个人区。重复调用幂等。

```bash
curl -s -X POST http://localhost:30006/report/internal/spaces/$SPACE_ID/clearReferences | jq .
# 预期（第二次调用，幂等）：dashboardsCleared: 0, reportsCleared: 0, foldersDeleted: 0
```

---

## 八、端点清单汇总

### report 服务（30006）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/report/space/create` | POST | 创建空间（运营，绑定 appid 1:1） |
| `/report/space/page` | POST | 空间分页（按 appGroupId 过滤，owner 或被分享） |
| `/report/space/detail` | GET | 空间详情 |
| `/report/space/update` | POST | 重命名空间（需编辑租约） |
| `/report/space/delete` | POST | 删除空间（级联清空看板 spaceId） |
| `/report/space/share` | POST | 分享空间（VIEWER/COLLABORATOR） |
| `/report/space/unshare` | POST | 取消分享 |
| `/report/space/transfer` | POST | 移交空间 |
| `/report/folder/create` | POST | 创建文件夹（scopeType=PERSONAL/SPACE，无需 appId） |
| `/report/folder/list` | POST | 查文件夹列表 |
| `/report/folder/update` | POST | 重命名 |
| `/report/folder/delete` | POST | 删除 |
| `/report/dashboard/create` | POST | 创建看板（无需 appId，纯布局容器，folderId 可空=直挂 Space） |
| `/report/dashboard/update` | POST | 更新看板 |
| `/report/dashboard/move` | POST | 移动看板（级联报表归属） |
| `/report/dashboard/copy` | POST | 复制看板 |
| `/report/dashboard/page` | POST | 看板分页（按 spaceId 过滤） |
| `/report/dashboard/detail` | POST | 看板详情 |
| `/report/dashboard/share` | POST | 分享看板（独立于空间分享） |
| `/report/dashboard/unshare` | POST | 取消分享看板 |
| `/report/dashboard/transfer` | POST | 移交看板 |
| `/report/dashboard/delete` | POST | 删除看板（级联软删其下 dashboard_component 关联行） |
| `/report/dashboard/refresh` | POST | 刷新看板 |
| `/report/dashboard/mountReport` | POST | 把报表挂载到看板（dashboard_component 关联行，含布局坐标） |
| `/report/dashboard/unmountReport` | POST | 解挂报表（软删关联行，报表本身不删） |
| `/report/report/create` | POST | 创建报表（可独立存在，dashboardId 选填；空间内禁止跨空间取数） |
| `/report/report/update` | POST | 更新报表 |
| `/report/report/page` | POST | 报表分页（按 spaceId/appGroupId 过滤，支持 unmountedOnly 查已存未放置） |
| `/report/report/detail` | POST | 报表详情 |
| `/report/report/delete` | POST | 删除报表（级联软删所有 dashboard_component 关联行） |
| `/report/asset/edit/acquire` | POST | 获取编辑租约（targetType ∈ {SPACE, DASHBOARD, REPORT}） |
| `/report/internal/spaces/{id}/clearReferences` | POST | 级联清空（内部接口，按 spaceId） |
| `/report/internal/appGroups/{id}/clearReferences` | POST | 级联清空（内部接口，按 appGroupId） |

### auth 服务（30005）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/internal/projectGroups/{id}` | GET | 项目组详情（auth 域，report 不再引用） |
| `/auth/internal/projectGroups/listByIds` | GET | 批量查项目组 |
| `/auth/internal/users/{id}/reportPermissionSnapshot` | GET | 权限快照（含 appIds = 可见 Space key） |
| `/auth/v1/login` | POST | SaaS 公司成员登录（email + password） |
| `/auth/v1/platform/login` | POST | 平台员工登录（username + password，运营场景） |
