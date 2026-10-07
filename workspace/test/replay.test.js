import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { ReplayService } from '../src/services/replay.js';
import { propagate, MU_EARTH } from '../src/physics.js';

let app, base, auditFile, dataFile;
let objA, objB, objC;
const events = {};

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  auditFile = path.join(dir, 'audit.log');
  dataFile = path.join(dir, 'store.json');
  app = createApp({
    dataFile, auditFile,
    screening: { windowSec: 7200, stepSec: 30, thresholdKm: 50 },
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  await seedScenario();
});
after(() => { app.store.flush(); app.server.close(); });

async function api(p, { method = 'GET', body } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  return { status: r.status, data };
}

/* ---------- 场景数据 ---------- */
const T0 = '2026-10-06T00:00:00Z';
const tPlus = (sec) => new Date(Date.parse(T0) + sec * 1000).toISOString();
const circ = (r) => Math.sqrt(MU_EARTH / r);
const cov3 = (s) => [[s, 0, 0], [0, s, 0], [0, 0, s]];
const TCA_BACK_SEC = 3000;
const rP = 7000.07, aB = 7001;
const vP = Math.sqrt(MU_EARTH * (2 / rP - 1 / aB));
const aTca = [7000, 0, 0, 0, circ(7000), 0];
const bTca = (radialOff, ctOff = 0.05) => [rP + radialOff, 0, ctOff, 0, vP, 0.0008];
const epochState = (tcaCfg, obsOffsetSec) => {
  const s = propagate(tcaCfg, -(TCA_BACK_SEC - obsOffsetSec));
  return { x: s[0], y: s[1], z: s[2], vx: s[3], vy: s[4], vz: s[5] };
};
async function ingest(objectId, source, epoch, state, cov = 0.01) {
  return api('/api/orbit-solutions', {
    method: 'POST',
    body: { objectId, source, epoch, state, positionCovariance: cov3(cov) },
  });
}

async function seedScenario() {
  objA = (await api('/api/objects', { method: 'POST', body: {
    name: 'SAT-A', operator: 'OPS-A', hardBodyRadiusM: 10, fuelBudgetKg: 50,
    missionWindows: [{ notBefore: tPlus(3600), notAfter: tPlus(4 * 3600) }],
  } })).data.id;
  objB = (await api('/api/objects', { method: 'POST', body: { name: 'DEB-B', operator: 'OPS-B' } })).data.id;
  objC = (await api('/api/objects', { method: 'POST', body: { name: 'DEB-C', operator: 'OPS-C' } })).data.id;

  await ingest(objA, 'INTERNAL', T0, epochState(aTca, 0));
  // 事件1：A-B，RED
  let r = await ingest(objB, 'CDM', T0, epochState(bTca(0), 0));
  events.ab = r.data.events[0].event.id;
  // 事件2：A-C（C 与 B 同状态）→ 独立 pair 事件
  r = await ingest(objC, 'CDM', T0, epochState(bTca(0), 0));
  const ev2 = r.data.events.find((x) => x.event.id !== events.ab);
  assert.ok(ev2, '应产生第二个独立事件（跨事件测试用）');
  events.ac = ev2.event.id;

  // 入站消息 v1（在 A-B 事件 v2 之前）
  await api('/api/coordination/messages', { method: 'POST', body: {
    messageId: 'MSG-X-001', counterpartId: 'OPS-B', eventId: events.ab, type: 'PLAN_UPDATE', version: 1, payload: {},
  } });

  // 事件 v2
  await ingest(objB, 'CDM', tPlus(600), epochState(bTca(0.2), 600));

  // 候选 → 批准承诺 v1
  const cand = (await api(`/api/conjunctions/${events.ab}/maneuvers`, { method: 'POST', body: {
    objectId: objA, operatorId: 'OPS-A', dvVector: { x: 0, y: 0.0005, z: 0 },
    executionEpoch: tPlus(3700), expectedFuelKg: 2,
  } })).data;
  await api(`/api/maneuvers/${cand.id}/approve`, { method: 'POST',
    body: { expectedCommitmentVersion: 0, approvedBy: 'OPS-A' } });

  // 事件 v3 → 新候选 → 承诺 v2
  await ingest(objB, 'CDM', tPlus(1200), epochState(bTca(0.1), 1200));
  const cand2 = (await api(`/api/conjunctions/${events.ab}/maneuvers`, { method: 'POST', body: {
    objectId: objA, operatorId: 'OPS-A', dvVector: { x: 0, y: 0.0006, z: 0 },
    executionEpoch: tPlus(3800), expectedFuelKg: 2.5,
  } })).data;
  const cmt2 = (await api(`/api/maneuvers/${cand2.id}/approve`, { method: 'POST',
    body: { expectedCommitmentVersion: 1, approvedBy: 'OPS-A' } })).data;

  // 承诺 v2 下达
  await api(`/api/commitments/${cmt2.id}/dispatch`, { method: 'POST', body: { dispatchedBy: 'OPS-A' } });

  // 一条消息重放（幂等）
  await api('/api/coordination/messages', { method: 'POST', body: {
    messageId: 'MSG-X-001', counterpartId: 'OPS-B', eventId: events.ab, type: 'PLAN_UPDATE', version: 1, payload: {},
  } });
}

/* ================= 哈希链 ================= */

describe('哈希链账本', () => {
  test('审计记录携带 seq/prevHash/hash 且首尾衔接', async () => {
    const trail = app.store.auditTrail;
    assert.ok(trail.length > 5);
    for (let i = 0; i < trail.length; i++) {
      assert.equal(trail[i].seq, i + 1, 'seq 必须连续');
      assert.ok(trail[i].hash, '必须有 hash');
      assert.equal(trail[i].prevHash, i === 0 ? 'GENESIS' : trail[i - 1].hash, 'prevHash 必须衔接');
    }
    // 磁盘文件存在且每行可解析
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, trail.length);
  });

  test('GET /api/replay/chain 返回校验通过报告', async () => {
    const r = await api('/api/replay/chain');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.source, 'file');
    assert.ok(r.data.entriesChecked > 0);
    assert.ok(r.data.involvedEvents.includes(events.ab));
  });
});

/* ================= 时间线重建 ================= */

describe('时间线重建（只读）', () => {
  test('从追加账本重建事件风险/承诺/消息时间线', async () => {
    const r = await api(`/api/replay/timeline?eventId=${events.ab}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.readOnly, true);
    assert.equal(r.data.chain.ok, true);

    const { riskVersions, commitments, messages } = r.data.reconstructed;
    assert.equal(riskVersions.length, 3, '回放应得到 v1/v2/v3 三个风险版本');
    assert.equal(riskVersions[0].riskLevel, 'RED');
    assert.deepEqual(riskVersions.map((x) => x.eventVersion), [1, 2, 3]);

    const statuses = commitments.map((c) => `${c.version}:${c.status}`).sort();
    assert.ok(statuses.includes('1:SUPERSEDED'), 'v1 应在 v2 批准时被原子取代');
    assert.ok(statuses.includes('2:DISPATCHED'), 'v2 应为已下达终态');

    assert.ok(messages.some((m) => m.messageId === 'MSG-X-001' && m.direction === 'INBOUND'));
    assert.ok(messages.some((m) => m.direction === 'OUTBOUND'));

    // 时间线含关键事实类别
    const kinds = r.data.timeline.map((f) => f.kind);
    for (const k of ['EVENT_VERSION_APPENDED', 'COMMITMENT_CREATED', 'COMMITMENT_DISPATCHED', 'MESSAGE_RECEIVED']) {
      assert.ok(kinds.includes(k), `时间线应包含 ${k}`);
    }
    // 重放去重也在时间线上可见
    assert.ok(kinds.includes('MESSAGE_REPLAY_DEDUPED'));
  });

  test('minRisk 筛选条件生效并回显', async () => {
    const r = await api(`/api/replay/timeline?eventId=${events.ab}&minRisk=RED`);
    assert.equal(r.status, 200);
    assert.equal(r.data.filters.minRisk, 'RED');
    assert.ok(r.data.reconstructed.riskVersions.every((x) => x.riskLevel === 'RED'));
  });

  test('不存在的事件 → 404 可识别错误', async () => {
    const r = await api('/api/replay/timeline?eventId=EVT-9999');
    assert.equal(r.status, 404);
    assert.equal(r.data.error.code, 'NOT_FOUND');
  });

  test('回放不写入任何线上状态：对比前后账本长度与活动状态', async () => {
    const before = app.store.auditTrail.length;
    const evBefore = (await api(`/api/conjunctions/${events.ab}`)).data.currentVersion;
    await api(`/api/replay/timeline?eventId=${events.ab}`);
    await api(`/api/replay/diff?eventId=${events.ab}&from=1&to=HEAD`);
    const after = app.store.auditTrail.length;
    const evAfter = (await api(`/api/conjunctions/${events.ab}`)).data.currentVersion;
    assert.equal(after, before, '回放/对比不得追加任何审计记录');
    assert.equal(evAfter, evBefore, '线上事件版本不得变化');
  });
});

/* ================= 截面差异 ================= */

describe('双截面差异', () => {
  test('两个风险版本截面：风险 Pc/脱靶变化', async () => {
    // 找到 v1 与 v2 追加的 seq
    const tl = (await api(`/api/replay/timeline?eventId=${events.ab}`)).data;
    const v1 = tl.timeline.find((f) => f.kind === 'EVENT_VERSION_APPENDED' && f.label.includes('v1'));
    const v2 = tl.timeline.find((f) => f.kind === 'EVENT_VERSION_APPENDED' && f.label.includes('v2'));
    const r = await api(`/api/replay/diff?eventId=${events.ab}&from=${v1.seq}&to=${v2.seq}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.risk.changed, true);
    const fields = r.data.risk.fields.map((f) => f.field);
    assert.ok(fields.includes('pc'));
    assert.ok(fields.includes('missDistanceKm'));
    assert.equal(r.data.from.seq, v1.seq);
    assert.equal(r.data.to.seq, v2.seq);
  });

  test('承诺从无到有 → added；v1 被 v2 取代 → changed SUPERSEDED', async () => {
    const tl = (await api(`/api/replay/timeline?eventId=${events.ab}`)).data;
    const createdFacts = tl.timeline.filter((f) => f.kind === 'COMMITMENT_CREATED');
    assert.ok(createdFacts.length >= 2);
    const before = tl.timeline.filter((f) => f.seq < createdFacts[0].seq).pop().seq;
    const atV1 = createdFacts[0].seq;
    const atV2 = createdFacts[1].seq;

    let r = await api(`/api/replay/diff?eventId=${events.ab}&from=${before}&to=${atV1}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.commitments.added.length, 1);
    assert.equal(r.data.commitments.added[0].status, 'APPROVED');

    r = await api(`/api/replay/diff?eventId=${events.ab}&from=${atV1}&to=${atV2}`);
    assert.equal(r.status, 200);
    const ch = r.data.commitments.changed.find((c) => c.fields.some((f) => f.field === 'status'));
    assert.ok(ch, 'v1 承诺状态应发生变化');
    const sf = ch.fields.find((f) => f.field === 'status');
    assert.equal(sf.from, 'APPROVED');
    assert.equal(sf.to, 'SUPERSEDED');
    assert.equal(r.data.commitments.added[0].status, 'APPROVED');
  });

  test('消息增量出现在 added 中', async () => {
    const tl = (await api(`/api/replay/timeline?eventId=${events.ab}`)).data;
    const firstMsg = tl.timeline.find((f) => f.kind === 'MESSAGE_RECEIVED');
    // “from” 取该事件内严格早于首条消息的截面（避免落到其他事件的记录上）
    const earlier = tl.timeline.filter((f) => f.seq < firstMsg.seq).pop();
    const fromSeq = earlier ? earlier.seq : firstMsg.seq;
    const r = await api(`/api/replay/diff?eventId=${events.ab}&from=${fromSeq}&to=${firstMsg.seq}`);
    assert.equal(r.status, 200);
    assert.ok(r.data.messages.added.some((m) => m.messageId === 'MSG-X-001'));
    assert.equal(r.data.messages.counts.added, 1);
  });

  test('HEAD 截面与时间戳截面', async () => {
    const tl = (await api(`/api/replay/timeline?eventId=${events.ab}`)).data;
    const r = await api(`/api/replay/diff?eventId=${events.ab}&from=1&to=HEAD`);
    assert.equal(r.status, 200);
    assert.equal(r.data.to.seq, tl.headSeq);

    // ts 形式：以该事件最早事实的 ts 为起点、HEAD 时间为终点
    const first = tl.timeline[0];
    const endTs = tl.timeline[tl.timeline.length - 1].ts;
    const rt = await api(
      `/api/replay/diff?eventId=${events.ab}&from=${encodeURIComponent(first.ts)}&to=${encodeURIComponent(endTs)}`);
    assert.equal(rt.status, 200);
    assert.ok(rt.data.to.seq >= rt.data.from.seq);
    assert.equal(rt.data.to.seq, tl.headSeq);
  });

  test('截面顺序颠倒 → 自动归正并标记 orderSwapped', async () => {
    const r = await api(`/api/replay/diff?eventId=${events.ab}&from=HEAD&to=1`);
    assert.equal(r.status, 200);
    assert.equal(r.data.orderSwapped, true);
    assert.ok(r.data.to.seq > r.data.from.seq);
  });

  test('相同截面 → 400 IDENTICAL_CUT', async () => {
    const r = await api(`/api/replay/diff?eventId=${events.ab}&from=5&to=5`);
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'IDENTICAL_CUT');
  });

  test('不存在的截面 seq → 404 SNAPSHOT_NOT_FOUND', async () => {
    const r = await api(`/api/replay/diff?eventId=${events.ab}&from=1&to=999999`);
    assert.equal(r.status, 404);
    assert.equal(r.data.error.code, 'SNAPSHOT_NOT_FOUND');
  });

  test('非法截面格式 → 400 VALIDATION', async () => {
    const r = await api(`/api/replay/diff?eventId=${events.ab}&from=not-a-cut&to=HEAD`);
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'VALIDATION');
  });

  test('跨事件选择：截面 seq 属于另一事件 → 409 CROSS_EVENT_SELECTION', async () => {
    // 找一条属于 A-C 事件的记录
    const tlAc = (await api(`/api/replay/timeline?eventId=${events.ac}`)).data;
    const acSeq = tlAc.cuts[0].seq;
    // 以 A-B 为事件，但截面选了 A-C 的记录
    const r = await api(`/api/replay/diff?eventId=${events.ab}&from=1&to=${acSeq}`);
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'CROSS_EVENT_SELECTION');
    assert.ok(r.data.error.message.includes(events.ac));
  });

  test('未指定 eventId → 400（不允许无事件域回放）', async () => {
    const r = await api('/api/replay/diff?from=1&to=2');
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'VALIDATION');
  });
});

/* ================= 导出 ================= */

describe('差异导出', () => {
  test('JSON 导出包含筛选条件、链校验与差异内容', async () => {
    const r = await api(`/api/replay/diff?eventId=${events.ab}&from=1&to=HEAD&format=json`);
    assert.equal(r.status, 200);
    assert.equal(r.data.eventId, events.ab);
    assert.ok(r.data.chain.ok);
    assert.ok('risk' in r.data && 'commitments' in r.data && 'messages' in r.data);
    assert.equal(r.data.readOnly, true);
  });

  test('CSV 导出', async () => {
    const r = await fetch(`${base}/api/replay/diff?eventId=${events.ab}&from=1&to=HEAD&format=csv`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const text = await r.text();
    assert.match(text, /# section,change,id,field,from,to,detail/);
    assert.match(text, /RISK/);
  });

  test('不支持的格式 → 415 UNSUPPORTED_FORMAT', async () => {
    const r = await api(`/api/replay/diff?eventId=${events.ab}&from=1&to=HEAD&format=xml`);
    assert.equal(r.status, 415);
    assert.equal(r.data.error.code, 'UNSUPPORTED_FORMAT');
    assert.deepEqual(r.data.error.details.supported, ['json', 'csv']);
  });
});

/* ================= 链校验失败 / 重启续链 ================= */

describe('账本完整性', () => {
  test('篡改账本 → 链校验失败，时间线/差异/导出一律 409 CHAIN_VALIDATION_FAILED', async () => {
    // 在隔离目录复制一份账本并篡改第 2 行的风险数值
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-tamper-'));
    const tampered = path.join(dir, 'audit.log');
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    // 篡改一条事件相关记录的字段（保留原 hash → 重算哈希必然不匹配）
    const idx = lines.findIndex((l) => l.includes('"eventId":"EVT-'));
    assert.ok(idx >= 0);
    lines[idx] = lines[idx].replace(/"eventId":"(EVT-\d+)"/, '"eventId":"EVT-0000"');
    fs.writeFileSync(tampered, lines.join('\n'));

    const store2 = new Store({ auditFile: tampered });
    const rep = new ReplayService(store2, { auditFile: tampered });
    const report = rep.verifyChain();
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === 'HASH_MISMATCH' || e.code === 'PREV_HASH_MISMATCH'));

    assert.throws(() => rep.timeline(events.ab), (e) => e.code === 'CHAIN_VALIDATION_FAILED');
    assert.throws(() => rep.diff(events.ab, '1', 'HEAD'), (e) => e.code === 'CHAIN_VALIDATION_FAILED');
    assert.throws(() => rep.exportDiff(events.ab, '1', 'HEAD', 'csv'), (e) => e.code === 'CHAIN_VALIDATION_FAILED');

    // HTTP：chain 接口 409
    const r = await api('/api/replay/chain'); // 主账本仍正常 → 200（隔离验证用的是复制账本）
    assert.equal(r.status, 200);
  });

  test('损坏行（非 JSON）→ MALFORMED_ENTRY 链失败', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-corrupt-'));
    const f = path.join(dir, 'audit.log');
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    lines.splice(2, 0, '{ this is not json');
    fs.writeFileSync(f, lines.join('\n'));
    const rep = new ReplayService(new Store({ auditFile: f }), { auditFile: f });
    const report = rep.verifyChain();
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === 'MALFORMED_ENTRY'));
  });

  test('服务重启：从磁盘追加账本续链，新记录序号与 prevHash 正确衔接', async () => {
    app.store.flush();
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-restart-'));
    const f2 = path.join(dir2, 'audit.log');
    fs.copyFileSync(auditFile, f2);
    const store2 = new Store({ auditFile: f2 });
    const nBefore = store2.auditTrail.length;
    const e = store2.audit('POST_RESTART_MARKER', { ok: true });
    assert.equal(e.seq, nBefore + 1);
    assert.equal(e.prevHash, store2.auditTrail[nBefore - 1].hash);
    const rep = new ReplayService(store2, { auditFile: f2 });
    // 追加写入后整条链仍可校验通过
    assert.equal(rep.verifyChain().ok, true);
  });
});
