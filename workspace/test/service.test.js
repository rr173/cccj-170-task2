import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { MU_EARTH, propagate } from '../src/physics.js';

let app, base;

before(async () => {
  app = createApp({ screening: { windowSec: 7200, stepSec: 30, thresholdKm: 50 } });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});
after(() => { app.store.flush(); app.server.close(); });

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  return { status: r.status, data };
}

/* ---------- 测试数据：两颗相交轨道卫星 ---------- */
const T0 = '2026-10-06T00:00:00Z';
const tPlus = (sec) => new Date(Date.parse(T0) + sec * 1000).toISOString();
const mu = MU_EARTH;
const circ = (r) => Math.sqrt(mu / r);
const cov3 = (s) => [[s, 0, 0], [0, s, 0], [0, 0, s]];

// 以 TCA 构型反向传播生成观测时刻状态：保证观测时相距很远、约 2950s 后单次近距离交会
// B 为 a=7001km 椭圆轨道，TCA 时恰在近地点附近（径向脱靶可控）
const TCA_BACK_SEC = 3000;
const rP = 7000.07, aB = 7001;
const vP = Math.sqrt(mu * (2 / rP - 1 / aB));
const aTca = [7000, 0, 0, 0, circ(7000), 0];
const bTca = (radialOff, ctOff = 0.05) => [rP + radialOff, 0, ctOff, 0, vP, 0.0008];
const epochState = (tcaCfg, obsOffsetSec) => {
  const s = propagate(tcaCfg, -(TCA_BACK_SEC - obsOffsetSec));
  return { x: s[0], y: s[1], z: s[2], vx: s[3], vy: s[4], vz: s[5] };
};
const stateA = epochState(aTca, 0);                     // 主星（不变）
const stateB = epochState(bTca(0), 0);                  // v1: 脱靶 ~0.074km → RED
const stateB2 = epochState(bTca(0.2), 600);             // v2: 脱靶增大 → 风险下降
const stateB3 = epochState(bTca(0.05), 1200);           // v3: 再次变化

let objA, objB, eventId;

async function ingest(objectId, source, epoch, state, cov = 0.01) {
  return api('/api/orbit-solutions', {
    method: 'POST',
    body: { objectId, source, epoch, state, positionCovariance: cov3(cov) },
  });
}

test('物理：二体传播精度', () => {
  const r = 7000, v = circ(r), T = 2 * Math.PI * Math.sqrt(r ** 3 / mu);
  const s = propagate([r, 0, 0, 0, v, 0], T);
  assert.ok(Math.hypot(s[0] - r, s[1], s[2]) < 1e-6, '圆轨道一周应回到原点');
});

test('注册空间目标（含燃料预算与任务窗口）', async () => {
  let r = await api('/api/objects', {
    method: 'POST',
    body: {
      name: 'SAT-A', operator: 'OPS-A', hardBodyRadiusM: 10, fuelBudgetKg: 50,
      missionWindows: [{ notBefore: tPlus(3600), notAfter: tPlus(4 * 3600) }],
    },
  });
  assert.equal(r.status, 201);
  objA = r.data.id;
  r = await api('/api/objects', {
    method: 'POST', body: { name: 'DEB-B', operator: 'OPS-B', hardBodyRadiusM: 5 },
  });
  objB = r.data.id;
});

test('多来源轨道解接收 → 生成会合事件 v1 并评估风险', async () => {
  let r = await ingest(objA, 'INTERNAL', T0, stateA);
  assert.equal(r.status, 201);
  assert.equal(r.data.applied, true);
  r = await ingest(objB, 'CDM', T0, stateB);
  assert.equal(r.data.applied, true);
  assert.equal(r.data.events.length, 1);
  assert.equal(r.data.events[0].appended, true);
  eventId = r.data.events[0].event.id;

  const ev = (await api(`/api/conjunctions/${eventId}`)).data;
  assert.equal(ev.currentVersion, 1);
  assert.equal(ev.versions[0].riskLevel, 'RED'); // 59m 脱靶 + 100m 协方差 → 高 Pc
  assert.ok(ev.versions[0].pc > 1e-5);
  assert.ok(ev.versions[0].missDistanceKm.total < 1);
});

test('预警 API 返回 RED 事件', async () => {
  const r = await api('/api/warnings');
  assert.equal(r.status, 200);
  const w = r.data.warnings.find((x) => x.eventId === eventId);
  assert.ok(w, '应包含该事件预警');
  assert.equal(w.level, 'RED');
});

test('新观测到达 → 事件版本单调递增（v2），风险重新评估', async () => {
  // 新观测：脱靶量增大 → 风险下降，但版本必须前进
  const r = await ingest(objB, 'CDM', tPlus(600), stateB2);
  assert.equal(r.data.applied, true);
  const ev = (await api(`/api/conjunctions/${eventId}`)).data;
  assert.equal(ev.currentVersion, 2);
  assert.ok(ev.versions[1].missDistanceKm.total > ev.versions[0].missDistanceKm.total);
  // 历史版本不可变
  const v1 = (await api(`/api/conjunctions/${eventId}/versions/1`)).data;
  assert.equal(v1.version, 1);
});

test('迟到观测（低时点）→ 存档但不回退事件版本', async () => {
  // 以介于 T0 与 T0+600 之间的时点重放旧数据
  const r = await ingest(objB, 'CDM', tPlus(300), stateB);
  assert.equal(r.status, 202);
  assert.equal(r.data.applied, false);
  assert.equal(r.data.late, true);
  const ev = (await api(`/api/conjunctions/${eventId}`)).data;
  assert.equal(ev.currentVersion, 2, '事件版本不得回退');
});

test('提交机动候选（基于当前事件头版本）', async () => {
  const r = await api(`/api/conjunctions/${eventId}/maneuvers`, {
    method: 'POST',
    body: {
      objectId: objA, operatorId: 'OPS-A',
      dvVector: { x: 0, y: 0.0005, z: 0 }, executionEpoch: tPlus(7200), expectedFuelKg: 2,
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.eventVersion, 2);
  assert.equal(r.data.status, 'SUBMITTED');
});

let cand1, cand2;
test('提交两个并发候选', async () => {
  cand1 = (await api(`/api/conjunctions/${eventId}/maneuvers`, {
    method: 'POST',
    body: { objectId: objA, operatorId: 'OPS-A', dvVector: { x: 0, y: 0.0005, z: 0 }, executionEpoch: tPlus(7200), expectedFuelKg: 2 },
  })).data;
  cand2 = (await api(`/api/conjunctions/${eventId}/maneuvers`, {
    method: 'POST',
    body: { objectId: objA, operatorId: 'OPS-A', dvVector: { x: 0, y: -0.0008, z: 0 }, executionEpoch: tPlus(7500), expectedFuelKg: 3 },
  })).data;
  assert.equal(cand1.status, 'SUBMITTED');
  assert.equal(cand2.status, 'SUBMITTED');
});

test('并发批准：CAS 保证只有一个成功，另一个 409', async () => {
  // 两个批准都基于承诺链头 v0 并发发起
  const [r1, r2] = await Promise.all([
    api(`/api/maneuvers/${cand1.id}/approve`, { method: 'POST', body: { expectedCommitmentVersion: 0, approvedBy: 'OPS-A' } }),
    api(`/api/maneuvers/${cand2.id}/approve`, { method: 'POST', body: { expectedCommitmentVersion: 0, approvedBy: 'OPS-A' } }),
  ]);
  const results = [r1, r2].sort((a, b) => a.status - b.status);
  assert.equal(results[0].status, 201, '恰好一个批准成功');
  assert.equal(results[1].status, 409, '另一个必须 409 版本冲突');
  assert.equal(results[1].data.error.code, 'VERSION_CONFLICT');
  assert.equal(results[1].data.error.details.currentCommitmentHead, 1);
});

let commitmentV1;
test('批准成功的承诺冻结了燃料/窗口/协同', async () => {
  const ev = (await api(`/api/conjunctions/${eventId}`)).data;
  assert.equal(ev.commitmentHead, 1);
  commitmentV1 = ev.commitments.find((c) => c.version === 1);
  assert.equal(commitmentV1.status, 'APPROVED');
  // 燃料冻结
  assert.equal(commitmentV1.frozen.fuel.budgetKg, 50);
  assert.equal(commitmentV1.frozen.fuel.consumedBeforeKg, 0);
  assert.ok(commitmentV1.frozen.fuel.requiredKg > 0);
  // 窗口冻结
  assert.equal(commitmentV1.frozen.missionWindow.matchedWindow.notBefore, tPlus(3600));
  // 协同冻结（尚无入站消息）
  assert.equal(commitmentV1.frozen.coordination.counterpartPlanVersion, 0);
  assert.ok(commitmentV1.frozen.coordination.snapshotHash);
});

test('基于最新链头重新批准第二个候选 → 承诺 v2，v1 被取代', async () => {
  const r = await api(`/api/maneuvers/${cand2.id}/approve`, {
    method: 'POST', body: { expectedCommitmentVersion: 1, approvedBy: 'OPS-A' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.version, 2);
  assert.equal(r.data.frozen.fuel.consumedBeforeKg, 0, 'v1 已被取代，不占用燃料');
  const c1 = (await api(`/api/commitments/${commitmentV1.id}`)).data;
  assert.equal(c1.status, 'SUPERSEDED');
});

test('燃料约束：需求超过剩余预算 → 422', async () => {
  const big = (await api(`/api/conjunctions/${eventId}/maneuvers`, {
    method: 'POST',
    body: { objectId: objA, operatorId: 'OPS-A', dvVector: { x: 0, y: 0.01, z: 0 }, executionEpoch: tPlus(7200), expectedFuelKg: 100 },
  })).data;
  const r = await api(`/api/maneuvers/${big.id}/approve`, {
    method: 'POST', body: { expectedCommitmentVersion: 2, approvedBy: 'OPS-A' },
  });
  assert.equal(r.status, 422);
  assert.equal(r.data.error.code, 'FUEL_CONSTRAINT');
});

test('窗口约束：执行时刻在任务窗口外 → 422', async () => {
  const bad = (await api(`/api/conjunctions/${eventId}/maneuvers`, {
    method: 'POST',
    body: { objectId: objA, operatorId: 'OPS-A', dvVector: { x: 0, y: 0.0005, z: 0 }, executionEpoch: tPlus(100000), expectedFuelKg: 1 },
  })).data;
  const r = await api(`/api/maneuvers/${bad.id}/approve`, {
    method: 'POST', body: { expectedCommitmentVersion: 2, approvedBy: 'OPS-A' },
  });
  assert.equal(r.status, 422);
  assert.equal(r.data.error.code, 'WINDOW_CONSTRAINT');
});

test('对方计划变化（PLAN_UPDATE v1）→ 应用并推进协同版本', async () => {
  const r = await api('/api/coordination/messages', {
    method: 'POST',
    body: { messageId: 'MSG-B-001', counterpartId: 'OPS-B', eventId, type: 'PLAN_UPDATE', version: 1, payload: { note: '我方将保持轨道' } },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'APPLIED');
});

test('消息重放：同一 messageId 幂等去重，不产生状态变更', async () => {
  const body = { messageId: 'MSG-B-001', counterpartId: 'OPS-B', eventId, type: 'PLAN_UPDATE', version: 1, payload: {} };
  const r = await api('/api/coordination/messages', { method: 'POST', body });
  assert.equal(r.status, 200);
  assert.equal(r.data.deduplicated, true);
  const msgs = (await api(`/api/coordination/messages?eventId=${eventId}`)).data;
  assert.equal(msgs.filter((m) => m.id === 'MSG-B-001').length, 1, '消息只记录一次');
});

test('低版本消息（迟到）→ STALE_REJECTED，不应用', async () => {
  const r = await api('/api/coordination/messages', {
    method: 'POST',
    body: { messageId: 'MSG-B-002', counterpartId: 'OPS-B', eventId, type: 'PLAN_UPDATE', version: 1, payload: {} },
  });
  assert.equal(r.data.status, 'STALE_REJECTED');
  const r2 = await api('/api/coordination/messages', {
    method: 'POST',
    body: { messageId: 'MSG-B-003', counterpartId: 'OPS-B', eventId, type: 'PLAN_UPDATE', version: 0, payload: {} },
  });
  assert.equal(r2.data.status, 'STALE_REJECTED');
});

let commitmentV2;
test('下达承诺 v2 → DISPATCHED 终态', async () => {
  const ev = (await api(`/api/conjunctions/${eventId}`)).data;
  commitmentV2 = ev.commitments.find((c) => c.version === 2);
  const r = await api(`/api/commitments/${commitmentV2.id}/dispatch`, {
    method: 'POST', body: { dispatchedBy: 'OPS-A' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'DISPATCHED');
  // 重复下达 → 409
  const r2 = await api(`/api/commitments/${commitmentV2.id}/dispatch`, { method: 'POST', body: {} });
  assert.equal(r2.status, 409);
});

test('已下达机动不得被迟到低版本 CANCEL 撤销', async () => {
  // 对方以低版本（≤ 冻结时快照版本）发送 CANCEL
  const r = await api('/api/coordination/messages', {
    method: 'POST',
    body: { messageId: 'MSG-B-004', counterpartId: 'OPS-B', eventId, type: 'CANCEL', version: 1, payload: { commitmentId: commitmentV2.id } },
  });
  assert.equal(r.data.status, 'STALE_REJECTED');
  let c = (await api(`/api/commitments/${commitmentV2.id}`)).data;
  assert.equal(c.status, 'DISPATCHED', '已下达承诺保持终态');

  // 即使高版本 CANCEL 也不能撤销已下达承诺
  const r2 = await api('/api/coordination/messages', {
    method: 'POST',
    body: { messageId: 'MSG-B-005', counterpartId: 'OPS-B', eventId, type: 'CANCEL', version: 99, payload: { commitmentId: commitmentV2.id } },
  });
  assert.equal(r2.data.status, 'REJECTED');
  assert.match(r2.data.reason, /DISPATCHED_IMMUTABLE/);
  c = (await api(`/api/commitments/${commitmentV2.id}`)).data;
  assert.equal(c.status, 'DISPATCHED');
});

test('已下达后：基于旧事件版本的候选禁止批准', async () => {
  const c = (await api(`/api/conjunctions/${eventId}/maneuvers`, {
    method: 'POST',
    body: { objectId: objA, operatorId: 'OPS-A', dvVector: { x: 0, y: 0.0003, z: 0 }, executionEpoch: tPlus(7200), expectedFuelKg: 1 },
  })).data;
  const r = await api(`/api/maneuvers/${c.id}/approve`, {
    method: 'POST', body: { expectedCommitmentVersion: 2, approvedBy: 'OPS-A' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'DISPATCHED_EXISTS');
});

test('新观测推进事件版本后：可基于新版本批准后续机动（承诺链继续单调前进）', async () => {
  // 对方计划变化：PLAN_UPDATE v2
  let r = await api('/api/coordination/messages', {
    method: 'POST',
    body: { messageId: 'MSG-B-006', counterpartId: 'OPS-B', eventId, type: 'PLAN_UPDATE', version: 2, payload: { plan: 'updated' } },
  });
  assert.equal(r.data.status, 'APPLIED');

  // 新观测 → 事件 v3
  await ingest(objB, 'CDM', tPlus(1200), stateB3);
  const ev = (await api(`/api/conjunctions/${eventId}`)).data;
  assert.equal(ev.currentVersion, 3);

  // 基于 v3 的新候选可批准 → 承诺 v3
  const c = (await api(`/api/conjunctions/${eventId}/maneuvers`, {
    method: 'POST',
    body: { objectId: objA, operatorId: 'OPS-A', dvVector: { x: 0, y: 0.0004, z: 0 }, executionEpoch: tPlus(7200), expectedFuelKg: 1.5 },
  })).data;
  assert.equal(c.eventVersion, 3);
  r = await api(`/api/maneuvers/${c.id}/approve`, {
    method: 'POST', body: { expectedCommitmentVersion: 2, approvedBy: 'OPS-A' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.version, 3);
  // 新承诺的协同快照包含对方最新计划版本
  assert.equal(r.data.frozen.coordination.counterpartPlanVersion, 2);
  assert.ok(r.data.frozen.coordination.agreedMessages.some((m) => m.messageId === 'MSG-B-006'));
  // 已下达的 v2 承诺不受影响
  const c2 = (await api(`/api/commitments/${commitmentV2.id}`)).data;
  assert.equal(c2.status, 'DISPATCHED');
});

test('多对方协同：CANCEL 版本 ≤ 承诺冻结版本 → 拒绝撤销；高版本 CANCEL 可撤销未下达承诺', async () => {
  // 第三方 OPS-C 将其计划推进到 v5
  let r = await api('/api/coordination/messages', {
    method: 'POST',
    body: { messageId: 'MSG-C-001', counterpartId: 'OPS-C', eventId, type: 'PLAN_UPDATE', version: 5, payload: {} },
  });
  assert.equal(r.data.status, 'APPLIED');

  // 新观测 → 事件 v4；新候选批准 → 承诺 v4（冻结时对方计划版本 = 5）
  await ingest(objB, 'CDM', tPlus(1800), epochState(bTca(0.08), 1800));
  const ev = (await api(`/api/conjunctions/${eventId}`)).data;
  assert.equal(ev.currentVersion, 4);
  const cand = (await api(`/api/conjunctions/${eventId}/maneuvers`, {
    method: 'POST',
    body: { objectId: objA, operatorId: 'OPS-A', dvVector: { x: 0, y: 0.0002, z: 0 }, executionEpoch: tPlus(7200), expectedFuelKg: 1 },
  })).data;
  r = await api(`/api/maneuvers/${cand.id}/approve`, {
    method: 'POST', body: { expectedCommitmentVersion: 3, approvedBy: 'OPS-A' },
  });
  assert.equal(r.status, 201);
  const cmtV4 = r.data;
  assert.equal(cmtV4.frozen.coordination.counterpartPlanVersion, 5);

  // OPS-B 以 v3 发起 CANCEL：高于其通道已应用版本(2)，但 ≤ 承诺冻结版本(5) → 迟到低版本，拒绝
  r = await api('/api/coordination/messages', {
    method: 'POST',
    body: { messageId: 'MSG-B-007', counterpartId: 'OPS-B', eventId, type: 'CANCEL', version: 3, payload: { commitmentId: cmtV4.id } },
  });
  assert.equal(r.data.status, 'STALE_REJECTED');
  let c = (await api(`/api/commitments/${cmtV4.id}`)).data;
  assert.equal(c.status, 'APPROVED', '未下达承诺不被低版本撤销');

  // OPS-B 以 v6（高于冻结版本）CANCEL 未下达承诺 → 允许撤销
  r = await api('/api/coordination/messages', {
    method: 'POST',
    body: { messageId: 'MSG-B-008', counterpartId: 'OPS-B', eventId, type: 'CANCEL', version: 6, payload: { commitmentId: cmtV4.id } },
  });
  assert.equal(r.data.status, 'APPLIED');
  c = (await api(`/api/commitments/${cmtV4.id}`)).data;
  assert.equal(c.status, 'CANCELLED');
});

test('协同记录导出：JSON 与 CSV', async () => {
  const rj = await api(`/api/coordination/export?eventId=${eventId}&format=json`);
  assert.equal(rj.status, 200);
  assert.ok(rj.data.records.length > 0);
  assert.ok(rj.data.records.some((r) => r.recordType === 'COMMITMENT'));
  assert.ok(rj.data.records.some((r) => r.recordType === 'MESSAGE' && r.id === 'MSG-B-001'));

  const rc = await fetch(`${base}/api/coordination/export?eventId=${eventId}&format=csv`);
  assert.equal(rc.status, 200);
  assert.match(rc.headers.get('content-type'), /text\/csv/);
  const text = await rc.text();
  assert.match(text, /recordType,id,eventId/);
  assert.match(text, /MSG-B-001/);
  assert.match(text, /COMMITMENT_DISPATCHED/);
});

test('审计日志记录关键状态变更', async () => {
  const r = await api('/api/audit?limit=500');
  const kinds = r.data.map((e) => e.kind);
  for (const k of ['SOLUTION_APPLIED', 'SOLUTION_LATE', 'EVENT_VERSION_APPENDED',
    'COMMITMENT_CREATED', 'COMMITMENT_DISPATCHED', 'MESSAGE_REPLAY_DEDUPED',
    'CANCEL_REJECTED_DISPATCHED', 'CANCEL_REJECTED_STALE']) {
    assert.ok(kinds.includes(k), `审计应包含 ${k}`);
  }
});
