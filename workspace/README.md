# 空间目标碰撞预警与机动协同服务 (Conjunction Guard)

接收多来源轨道解与协方差，按观测时点生成**单调版本化**的会合事件并评估碰撞风险；
运营方提交规避机动候选，批准时**冻结**燃料约束、任务窗口与对方协同消息，形成**不可变承诺**；
协同消息通道具备幂等去重与单调版本控制——**已下达机动不会被迟到低版本消息撤销**。

值班人员另有一套**只读审计回放**：从哈希链封印的追加账本**折叠重建**协同时间线，
可选择两个历史截面比较风险/承诺/消息差异并导出（JSON/CSV）；回放全程不写线上状态，
链校验失败、截面不存在、跨事件比较或不支持格式都返回可识别错误码。

零依赖（Node ≥ 18 内置模块），开箱即用。

## 快速开始

```bash
npm start          # 启动服务，默认 http://localhost:8080（PORT/DATA_DIR 可配）
npm run seed       # 注入演示数据（RED 会合事件 + 已批准承诺）
npm test           # 44 个场景测试（23 业务 + 21 只读回放）
```

- 会合分析页面： http://localhost:8080
- **只读审计回放页面： http://localhost:8080/audit**
- 预警 API： `GET /api/warnings`
- 协同记录导出： `GET /api/coordination/export?format=csv`

## 核心不变量

| 场景 | 保证 |
|---|---|
| 新观测到达 | 仅当观测时点更新才追加事件版本（v1→v2→…），历史版本只读 |
| 迟到观测 | 存档并返回 `202 {applied:false, late:true}`，不回退任何事件版本 |
| 批准机动 | 原子冻结：燃料台账、命中的任务窗口、对方协同消息快照（含 SHA-256） |
| 两个候选并发批准 | `expectedCommitmentVersion` 比较并交换：恰一个成功，另一个 `409 VERSION_CONFLICT` |
| 对方计划变化 | 通道版本单调递增，新承诺冻结最新计划版本 |
| 消息重放 | `messageId` 幂等去重，返回原回执 `deduplicated:true`，零状态变更 |
| 迟到低版本消息 | `STALE_REJECTED` 记录审计，不应用 |
| 撤销已下达机动 | 一律拒绝 `DISPATCHED_IMMUTABLE`；未下达承诺仅接受高于冻结版本的 CANCEL |

## 风险评估方法

- 二体通用变量传播（Stumpff 函数），中心差分 STM 传播 6×6 协方差至 TCA
- 粗采样 + 黄金分割精化搜索最近接近点（TCA），输出 RIC 脱靶分量
- 会合平面（垂直相对速度）投影合成协方差，短弧近似 Pc ≈ πR²·p(脱靶点)
- 风险分级（`src/physics.js` 可配）：RED `Pc≥1e-4 或 脱靶≤1km`；YELLOW `Pc≥1e-6 或 ≤5km`

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/objects` | 注册目标（燃料预算、任务窗口、硬体半径） |
| POST | `/api/orbit-solutions` | 接收轨道解（`source` 多来源；`covariance` 6×6 或 `positionCovariance` 3×3） |
| POST | `/api/screen` | 手动重筛查 |
| GET | `/api/conjunctions` / `/:id` / `/:id/versions/:v` | 事件列表 / 详情 / 历史版本 |
| GET | `/api/warnings?minLevel=YELLOW` | 活动预警 |
| POST | `/api/conjunctions/:id/maneuvers` | 提交机动候选（绑定当前事件版本） |
| POST | `/api/maneuvers/:id/approve` | 批准 → 生成承诺（需 `expectedCommitmentVersion`） |
| POST | `/api/maneuvers/:id/reject` | 拒绝候选 |
| POST | `/api/commitments/:id/dispatch` | 下达（终态，不可撤销） |
| POST | `/api/coordination/messages` | 接收对方消息（幂等 + 单调版本） |
| GET | `/api/coordination/export?eventId=&format=json\|csv` | 协同记录导出 |
| GET | `/api/audit` | 审计日志 |
| GET | `/api/replay/verify` | 【只读】追加账本哈希链校验 |
| GET | `/api/replay/timeline?eventId=&at=` | 【只读】从账本折叠重建协同时间线（可选截面快照） |
| GET | `/api/replay/diff?eventId=&from=&to=` | 【只读】两个历史截面的风险/承诺/消息差异 |
| GET | `/api/replay/export?eventId=&from=&to=&format=json\|csv` | 【只读】差异导出（不支持格式 → 415） |

### 批准请求示例

```json
POST /api/maneuvers/CND-0002/approve
{ "expectedCommitmentVersion": 1, "approvedBy": "OPS-A" }
```

承诺中的冻结快照：

```json
"frozen": {
  "fuel":         { "budgetKg": 50, "consumedBeforeKg": 0, "requiredKg": 2, "remainingAfterKg": 48 },
  "missionWindow":{ "matchedWindow": { "notBefore": "...", "notAfter": "..." } },
  "coordination": { "counterpartPlanVersion": 1, "agreedMessages": [...], "snapshotHash": "bf59..." }
}
```

## 状态机

```
候选:    SUBMITTED → APPROVED / REJECTED
承诺:    APPROVED → DISPATCHED (终态)
              ├─→ SUPERSEDED  (被更高版本承诺原子取代)
              └─→ CANCELLED   (仅未下达时，被对方高版本 CANCEL)
事件:    版本只增不减；OPEN ⇄ CLOSED 由头版本风险决定
```

## 只读审计回放（值班台 `/audit`）

数据基础：每条审计条目写入 `audit.log` 时经 SHA-256 **哈希链封印**（`seq`/`prevHash`/`hash`）；
服务重启时从该追加账本回填并恢复链游标（见 `src/ledger.js`）。

- **重建**：`GET /api/replay/timeline?eventId=EVT-0001` 从账本顺序折叠出事件创建 →
  风险版本 → 承诺（批准/取代/撤销/下达）→ 入站/出站消息的完整时间线。
- **截面**：选择器支持账本序号（如 `13`）、`genesis`/`earliest`、`latest`/`head`、
  单事件内的 `v1`/`v2`；`at=` 可直接取某截面的风险/承诺/消息快照（含 `stateHash`）。
- **差异**：`GET /api/replay/diff?...&from=v1&to=latest` 输出风险字段逐项变化，
  以及承诺/消息的新增、移除、状态变化（支持逆时间 `BACKWARD`）。
- **导出**：`/api/replay/export` 支持 `json`（完整差异）与 `csv`（逐字段扁平表），
  响应 `Cache-Control: no-store`；全程仅 GET，不调用任何写入路径。
- **旧账本兼容**：功能上线前无哈希的旧记录只允许作为链首“未封印前缀”，
  其折叠摘要（旧根）链接后续封印条目，校验状态为 `VERIFIED_WITH_LEGACY_PREFIX` 并披露条数。

| 错误情形 | HTTP | error.code |
|---|---|---|
| 账本哈希链校验失败（篡改/删除/重排/损坏行） | 422 | `CHAIN_INVALID`（details 含每条错误） |
| 截面序号/版本/选择器不存在 | 404 | `SECTION_NOT_FOUND` |
| 账本中不存在该事件 | 404 | `EVENT_NOT_FOUND` |
| 两个截面分属不同事件 | 400 | `CROSS_EVENT_SELECTION` |
| 缺少 from/to | 400 | `VALIDATION` |
| 账本尚无任何事件截面 | 409 | `NO_SECTIONS` |
| 导出格式非 json/csv | 415 | `UNSUPPORTED_FORMAT` |

## 数据与目录

```
src/ledger.js               追加账本：哈希链封印/旧根/链校验（只读回放的信任基础）
src/physics.js              轨道力学与 Pc
src/services/conjunction.js 轨道解接收、筛查、事件版本（单调追加）
src/services/maneuver.js    候选、批准冻结、承诺 CAS、下达
src/services/coordination.js 协同消息幂等/单调/撤销规则、导出
src/services/replay.js      只读回放：账本折叠重建、截面、双截面差异、导出
src/store.js                内存状态 + JSON 快照写穿 + 哈希链封印审计日志（启动回填）
data/                       运行时生成（store.json, audit.log）
test/service.test.js        23 个场景测试（含并发批准、重放、迟到撤销）
test/replay.test.js         21 个回放测试（折叠/截面/差异/导出/四类错误/防篡改/零写入）
```
