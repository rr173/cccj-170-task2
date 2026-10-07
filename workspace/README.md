# 空间目标碰撞预警与机动协同服务 (Conjunction Guard)

接收多来源轨道解与协方差，按观测时点生成**单调版本化**的会合事件并评估碰撞风险；
运营方提交规避机动候选，批准时**冻结**燃料约束、任务窗口与对方协同消息，形成**不可变承诺**；
协同消息通道具备幂等去重与单调版本控制——**已下达机动不会被迟到低版本消息撤销**。

零依赖（Node ≥ 18 内置模块），开箱即用。

## 快速开始

```bash
npm start          # 启动服务，默认 http://localhost:8080（PORT/DATA_DIR 可配）
npm run seed       # 注入演示数据（RED 会合事件 + 已批准承诺）
npm test           # 45 个场景测试
```

- 会合分析页面： http://localhost:8080
- 只读审计回放： http://localhost:8080/replay
- 预警 API： `GET /api/warnings`
- 协同记录导出： `GET /api/coordination/export?format=csv`
- 审计回放： `GET /api/replay/timeline?eventId=...` / `/api/replay/diff?eventId=...&from=&to=`

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
| GET | `/api/replay/chain` | 追加账本哈希链校验报告（不写状态） |
| GET | `/api/replay/timeline?eventId=&minRisk=` | 从追加账本只读重建该事件协同时间线 |
| GET | `/api/replay/diff?eventId=&from=&to=&format=json\|csv` | 两个历史截面的风险/承诺/消息差异并导出 |
| GET | `/api/audit` | 审计日志 |

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

## 只读审计回放（值班人员）

从**追加账本**（`data/audit.log`，每条记录含 `seq / prevHash / hash` 哈希链）离线重建协同时间线，
支持选取两个历史截面对比风险、承诺、消息的差异并导出（JSON/CSV）。
回放与导出**只读账本文件**，不调用任何写路径，不产生审计记录，不改变事件版本/承诺/消息（测试覆盖）。

- 截面描述符：账本序号（如 `13`）、ISO 时间戳（取该时间点前最后一条记录）、`HEAD`
- 两个截面顺序可颠倒，服务自动按账本顺序归正并在结果中标记 `orderSwapped`
- 页面 `/replay` 显示：筛选条件（事件/最低风险/两截面）、哈希链校验结果、重建时间线、差异内容与导出链接

可识别错误：

| HTTP | code | 触发 |
|---|---|---|
| 404 | `SNAPSHOT_NOT_FOUND` | 截面序号/时间在账本上不存在 |
| 409 | `CHAIN_VALIDATION_FAILED` | 哈希链断裂/篡改/损坏行，时间线、差异、导出一律拒绝 |
| 409 | `CROSS_EVENT_SELECTION` | 截面锚定记录分属不同会合事件 |
| 415 | `UNSUPPORTED_FORMAT` | 导出格式非 json/csv |
| 400 | `VALIDATION` / `IDENTICAL_CUT` | 截面格式非法 / 两截面为同一点 |

## 数据与目录

```
src/physics.js              轨道力学与 Pc
src/services/conjunction.js 轨道解接收、筛查、事件版本（单调追加）
src/services/maneuver.js    候选、批准冻结、承诺 CAS、下达
src/services/coordination.js 协同消息幂等/单调/撤销规则、导出
src/services/replay.js       只读审计回放：哈希链校验、时间线重建、双截面差异与导出
src/store.js                内存状态 + JSON 快照写穿 + 哈希链追加账本（audit.log）
data/                       运行时生成（store.json, audit.log）
test/service.test.js        23 个场景测试（含并发批准、重放、迟到撤销）
test/replay.test.js         22 个回放测试（链校验/时间线/双截面/导出/篡改/重启续链）
```
