import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { MU_EARTH, propagate } from '../src/physics.js';
import { sealEntry, GENESIS_HASH, verifyChain, computeLegacyRoot } from '../src/ledger.js';

let app, base;

before(async () => {
  app = createApp({ screening: { windowSec: 7200, stepSec: 30, thresholdKm: 50 } });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});
after(() => { app.store.flush(); app.server.close(); });

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: r.status, headers: r.headers, text: await r.text() };
  const data = await r.json();
  return { status: r.status, data };
}

/* ---------- 测试数据 ---------- */
const T0 = '2026-10-06T00:00:00Z';
const tPlus = (sec) => new Date(Date.parse(T0) + sec * 1000).toISOString();
const mu = MU_EARTH;
const circ = (r) => Math.sqrt(mu / r);
const cov3 = (s) => [[s, 0, 0], [0, s, 0], [0, 0, s]];
const TCA_BACK_SEC = 3000;
const rP = 7000.07, aB = 7001;
const vP = Math.sqrt(mu * (2 / rP - 1 / aB));
const aTca = [7000, 0, 0, 0, circ(7000), 0];
const bTca = (radialOff, ctOff = 0.05) => [rP + radialOff, 0, ctOff, 0, vP, 0.0008];
const epochState = (tcaCfg, obsOffsetSec) => {
  const s = propagate(tcaCfg, -(TCA_BACK_SEC - obsOffsetSec));
  return { x: s[0], y: s[1], z: s[2], vx: s[3], vy: s[4], vz: s[5] };
};

let objA, objB, eventId;
let createdSeq, v1Seq, v2Seq;
const ingest = (objectId, source, epoch, state, cov = 0.01) =>
  api('/api/orbit-solutions', {
    method: 'POST',
    body: { objectId, source, epoch, state, positionCovariance: cov3(cov) },
  });

test('回放：账本单元 — 封印与哈希链校验', () => {
  const e1 = sealEntry({ ts: '2026-10-06T00:00:00Z', kind: 'A' }, 1, GENESIS_HASH);
  const e2 = sealEntry({ ts: '2026-10-06T00:01:00Z', kind: 'B' }, 2, e1.hash);
  const ok = verifyChain([e1, e2]);
  assert.equal(ok.status, 'VALID');
  assert.equal(ok.headSeq, 2);

  // 篡改内容 → HASH_MISMATCH
  const tampered = [{ ...e1, pc: 0.5 }, e2];
  const bad = verifyChain(tampered);
  assert.equal(bad.status, 'INVALID');
  assert.ok(bad.errors.some((e) => e.code === 'HASH_MISMATCH'));

  // 删除第一条（跳号 + 前链断裂）
  const gap = verifyChain([{ ...e2, prevHash: GENESIS_HASH }]);
  assert.equal(gap.status, 'INVALID');
  assert.ok(gap.errors.some((e) => e.code === 'SEQ_GAP'));

  // 旧前缀：无 hash 的条目作为链首可通过（披露 legacyCount）
  const legacy = [{ ts: '2026-10-05T00:00:00Z', kind: 'OLD' }];
  const legacyRoot = computeLegacyRoot(legacy);
  const e3 = sealEntry({ ts: '2026-10-06T00:02:00Z', kind: 'C' }, 1, legacyRoot);
  const mixed = verifyChain([...legacy, e3]);
  assert.equal(mixed.status, 'VERIFIED_WITH_LEGACY_PREFIX');
  assert.equal(mixed.legacyCount, 1);
  assert.equal(mixed.sealedCount, 1);
});

test('回放准备：注册目标并产生事件 v1', async () => {
  let r = await api('/api/objects', { method: 'POST', body: { name: 'SAT-A', operator: 'OPS-A', fuelBudgetKg: 50, missionWindows: [{ notBefore: tPlus(3600), notAfter: tPlus(14400) }] } });
  objA = r.data.id;
  r = await api('/api/objects', { method: 'POST', body: { name: 'DEB-B', operator: 'OPS-B' } });
  objB = r.data.id;
  await ingest(objA, 'INTERNAL', T0, epochState(aTca, 0));
  r = await ingest(objB, 'CDM', T0, epochState(bTca(0), 0));
  eventId = r.data.events[0].event.id;
  assert.equal(eventId, 'EVT-0001');

  const v = await api(`/api/replay/verify`);
  assert.equal(v.status, 200);
  assert.equal(v.data.verification.status, 'VALID');
  assert.ok(v.data.readOnly === true);
});

test('时间线：折叠重建单事件，截面 = 创建 + 风险v1', async () => {
  const r = await api(`/api/replay/timeline?eventId=${eventId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.scope, 'EVENT');
  const kinds = r.data.sections.map((s) => s.kind);
  assert.deepEqual(kinds, ['EVENT_CREATED', 'EVENT_VERSION_APPENDED']);
  createdSeq = r.data.sections[0].seq;
  v1Seq = r.data.sections[1].seq;
  assert.ok(v1Seq > createdSeq);
  // 时间线标签包含风险信息
  assert.ok(r.data.timeline.some((t) => /RED/.test(t.label)));
});

test('时间线：单截面快照 at=v1', async () => {
  const r = await api(`/api/replay/timeline?eventId=${eventId}&at=v1`);
  assert.equal(r.status, 200);
  const snap = r.data.snapshot;
  assert.equal(snap.events[0].risk.version, 1);
  assert.equal(snap.events[0].risk.riskLevel, 'RED');
  assert.equal(snap.events[0].commitments.length, 0);
  assert.ok(snap.stateHash);
});

test('时间线继续：新观测 v2 + 消息 + 承诺 + 下达', async () => {
  // 入站消息 v1
  await api('/api/coordination/messages', { method: 'POST', body: {
    messageId: 'RP-MSG-1', counterpartId: 'OPS-B', eventId, type: 'PLAN_SHARE', version: 1, payload: {},
  } });
  // 事件 v2
  await ingest(objB, 'CDM', tPlus(600), epochState(bTca(0.2), 600));
  // 候选 → 批准 → 下达
  const c = (await api(`/api/conjunctions/${eventId}/maneuvers`, { method: 'POST', body: {
    objectId: objA, operatorId: 'OPS-A', dvVector: { x: 0, y: 0.0005, z: 0 },
    executionEpoch: tPlus(7200), expectedFuelKg: 2,
  } })).data;
  const cmt = (await api(`/api/maneuvers/${c.id}/approve`, {
    method: 'POST', body: { expectedCommitmentVersion: 0, approvedBy: 'OPS-A' },
  })).data;
  await api(`/api/commitments/${cmt.id}/dispatch`, { method: 'POST', body: { dispatchedBy: 'OPS-A' } });
  v2Seq = app.store.auditTrail.filter((e) => e.kind === 'EVENT_VERSION_APPENDED').slice(-1)[0].seq;

  const r = await api(`/api/replay/timeline?eventId=${eventId}`);
  const kinds = r.data.sections.map((s) => s.kind);
  assert.ok(kinds.includes('MESSAGE_RECEIVED'));
  assert.ok(kinds.includes('COMMITMENT_CREATED'));
  assert.ok(kinds.includes('COMMITMENT_DISPATCHED'));
  // 出站 PLAN_SHARE（批准 + 下达各一条）
  assert.equal(r.data.sections.filter((s) => s.kind === 'MESSAGE_SENT').length, 2);
});

test('差异：v1 → latest 含风险/承诺/消息变化', async () => {
  const r = await api(`/api/replay/diff?eventId=${eventId}&from=v1&to=latest`);
  assert.equal(r.status, 200);
  assert.equal(r.data.direction, 'FORWARD');
  assert.equal(r.data.from.seq, v1Seq);
  const d = r.data.differences;
  assert.ok(d.risk.changed);
  assert.equal(d.risk.to.version, 2);
  assert.equal(d.risk.fields.find((f) => f.field === 'pc').to, d.risk.to.pc);
  assert.equal(d.risk.fields.find((f) => f.field === 'version').from, 1);
  assert.equal(d.risk.fields.find((f) => f.field === 'version').to, 2);
  assert.equal(d.commitments.added.length, 1);
  assert.equal(d.commitments.added[0].status, 'DISPATCHED');
  // 入站 1 条 + 出站 2 条
  assert.equal(d.messages.added.length, 3);
  assert.ok(d.messages.added.some((m) => m.id === 'RP-MSG-1'));
});

test('差异：事件创建截面 → 风险v1 仅风险变化，无承诺/消息', async () => {
  const r = await api(`/api/replay/diff?eventId=${eventId}&from=${createdSeq}&to=${v1Seq}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.differences.risk.from, null);
  assert.equal(r.data.differences.risk.to.version, 1);
  assert.equal(r.data.differences.commitments.added.length, 0);
  assert.equal(r.data.differences.messages.added.length, 0);
});

test('差异：逆时间 latest → v1 方向 BACKWARD，承诺进入 removed', async () => {
  const r = await api(`/api/replay/diff?eventId=${eventId}&from=latest&to=v1`);
  assert.equal(r.status, 200);
  assert.equal(r.data.direction, 'BACKWARD');
  assert.equal(r.data.differences.commitments.removed.length, 1);
});

test('差异：相同截面 from==to 无差异', async () => {
  const r = await api(`/api/replay/diff?eventId=${eventId}&from=v1&to=v1`);
  assert.equal(r.status, 200);
  assert.equal(r.data.differences.risk.changed, false);
  assert.equal(r.data.differences.commitments.addedCount + r.data.differences.commitments.removedCount, 0);
});

test('错误：不存在的账本序号 → 404 SECTION_NOT_FOUND', async () => {
  const r = await api(`/api/replay/diff?eventId=${eventId}&from=v1&to=999999`);
  assert.equal(r.status, 404);
  assert.equal(r.data.error.code, 'SECTION_NOT_FOUND');
});

test('错误：不存在的事件版本 v99 → 404 SECTION_NOT_FOUND', async () => {
  const r = await api(`/api/replay/diff?eventId=${eventId}&from=v1&to=v99`);
  assert.equal(r.status, 404);
  assert.equal(r.data.error.code, 'SECTION_NOT_FOUND');
});

test('错误：无法识别的选择器 → 404 SECTION_NOT_FOUND', async () => {
  const r = await api(`/api/replay/diff?eventId=${eventId}&from=v1&to=bogus!`);
  assert.equal(r.status, 404);
  assert.equal(r.data.error.code, 'SECTION_NOT_FOUND');
});

test('错误：账本中不存在的事件 → 404 EVENT_NOT_FOUND', async () => {
  const r = await api('/api/replay/timeline?eventId=EVT-9999');
  assert.equal(r.status, 404);
  assert.equal(r.data.error.code, 'EVENT_NOT_FOUND');
});

test('错误：缺少 from/to → 400 VALIDATION', async () => {
  const r = await api(`/api/replay/diff?eventId=${eventId}&from=v1`);
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'VALIDATION');
});

test('全局时间线与跨事件选择：不同事件的两个截面 → 400 CROSS_EVENT_SELECTION', async () => {
  // 注册第三个目标，与已有目标形成其它配对事件
  const cResp = await api('/api/objects', { method: 'POST', body: { name: 'DEB-C', operator: 'OPS-C' } });
  const objC = cResp.data.id;
  const ci = await ingest(objC, 'CDM', T0, epochState(bTca(0, 0.5), 0), 0.02);
  assert.equal(ci.status, 201);
  const g = await api('/api/replay/timeline');
  assert.equal(g.status, 200);
  assert.equal(g.data.scope, 'GLOBAL');
  const eventIds = [...new Set(g.data.sections.map((s) => s.eventId))];
  assert.ok(eventIds.length >= 2, '应重建出至少两个事件');

  const secOf = (ev) => g.data.sections.find((s) => s.eventId === ev && s.kind === 'EVENT_VERSION_APPENDED');
  const s1 = secOf(eventIds[0]);
  const s2 = secOf(eventIds[1]);
  assert.ok(s1 && s2 && s1.eventId !== s2.eventId);

  const r = await api(`/api/replay/diff?from=${s1.seq}&to=${s2.seq}`);
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'CROSS_EVENT_SELECTION');
  assert.equal(r.data.error.details.from.eventId, s1.eventId);
  assert.equal(r.data.error.details.to.eventId, s2.eventId);

  // 同事件两截面在全局模式下仍可比较
  const sameEv = g.data.sections.filter((s) => s.eventId === s1.eventId);
  const ok = await api(`/api/replay/diff?from=${sameEv[0].seq}&to=${sameEv[sameEv.length - 1].seq}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.eventId, s1.eventId);
});

test('导出：JSON 差异（含 readOnly 与筛选条件）', async () => {
  const r = await api(`/api/replay/export?eventId=${eventId}&from=v1&to=latest&format=json`);
  assert.equal(r.status, 200);
  assert.equal(r.data.readOnly, true);
  assert.equal(r.data.eventId, eventId);
  assert.equal(r.data.filter.from, 'v1');
  assert.equal(r.data.filter.to, 'latest');
  assert.equal(r.data.verification.status, 'VALID');
  assert.ok(r.data.differences);
});

test('导出：CSV 差异', async () => {
  const r = await api(`/api/replay/export?eventId=${eventId}&from=v1&to=latest&format=csv`, { raw: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.match(r.text, /category,change,id/);
  assert.match(r.text, /RISK/);
  assert.match(r.text, /COMMITMENT/);
  assert.match(r.text, /MESSAGE/);
});

test('错误：不支持的导出格式 → 415 UNSUPPORTED_FORMAT', async () => {
  const r = await api(`/api/replay/export?eventId=${eventId}&from=v1&to=latest&format=xml`);
  assert.equal(r.status, 415);
  assert.equal(r.data.error.code, 'UNSUPPORTED_FORMAT');
  assert.deepEqual(r.data.error.details.supportedFormats, ['json', 'csv']);
});

test('安全：链校验失败时所有回放端点拒绝服务 → 422 CHAIN_INVALID', async () => {
  // 直接篡改内存账本（等价于外部篡改 audit.log 后重启回填）
  const idx = app.store.auditTrail.findIndex((e) => e.kind === 'EVENT_VERSION_APPENDED' && e.eventId === eventId);
  const original = app.store.auditTrail[idx].pc;
  app.store.auditTrail[idx].pc = 0.999;
  try {
    let r = await api('/api/replay/verify');
    assert.equal(r.status, 422);
    assert.equal(r.data.error.code, 'CHAIN_INVALID');
    assert.equal(r.data.error.details.verification.status, 'INVALID');
    assert.ok(r.data.error.details.verification.errors.some((e) => e.code === 'HASH_MISMATCH'));

    r = await api(`/api/replay/timeline?eventId=${eventId}`);
    assert.equal(r.status, 422);
    assert.equal(r.data.error.code, 'CHAIN_INVALID');

    r = await api(`/api/replay/diff?eventId=${eventId}&from=v1&to=latest`);
    assert.equal(r.status, 422);
    assert.equal(r.data.error.code, 'CHAIN_INVALID');

    r = await api(`/api/replay/export?eventId=${eventId}&from=v1&to=latest&format=json`);
    assert.equal(r.status, 422);
    assert.equal(r.data.error.code, 'CHAIN_INVALID');
  } finally {
    app.store.auditTrail[idx].pc = original; // 还原，便于其它测试
  }
  const fixed = await api('/api/replay/verify');
  assert.equal(fixed.data.verification.status, 'VALID');
});

test('安全：删除中间账本条目（跳号 + 前链断裂）→ 422 CHAIN_INVALID', async () => {
  const idx = Math.floor(app.store.auditTrail.length / 2);
  const saved = app.store.auditTrail[idx];
  app.store.auditTrail.splice(idx, 1);
  try {
    const r = await api('/api/replay/verify');
    assert.equal(r.status, 422);
    assert.ok(r.data.error.details.verification.errors.some((e) => e.code === 'SEQ_GAP' || e.code === 'PREV_HASH_MISMATCH'));
  } finally {
    app.store.auditTrail.splice(idx, 0, saved);
  }
  const fixed = await api('/api/replay/verify');
  assert.equal(fixed.data.verification.status, 'VALID');
});

test('安全：回放与导出不写入线上状态（审计条目数与链头不变）', async () => {
  const before = app.store.auditTrail.length;
  const headBefore = app.store.chainHead;
  await api('/api/replay/verify');
  await api(`/api/replay/timeline?eventId=${eventId}`);
  await api(`/api/replay/diff?eventId=${eventId}&from=v1&to=latest`);
  await api(`/api/replay/export?eventId=${eventId}&from=v1&to=latest&format=json`);
  await api(`/api/replay/export?eventId=${eventId}&from=v1&to=latest&format=csv`, { raw: true });
  assert.equal(app.store.auditTrail.length, before, '回放不得追加审计条目');
  assert.equal(app.store.chainHead, headBefore, '链头哈希不得变化');
});
