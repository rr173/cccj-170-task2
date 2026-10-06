/**
 * 演示数据：注册两个目标 → 注入多来源轨道解 → 生成 RED 会合事件
 * 用法：先启动服务 (npm start)，再执行 npm run seed
 */
import { propagate, MU_EARTH } from '../src/physics.js';

const base = process.env.BASE_URL || 'http://localhost:8080';
const T0 = new Date(Date.now() - 3600 * 1000).toISOString(); // 观测时点：1 小时前
const tPlus = (sec) => new Date(Date.parse(T0) + sec * 1000).toISOString();
const circ = (r) => Math.sqrt(MU_EARTH / r);

async function api(path, method = 'GET', body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${data.error?.message}`);
  return data;
}

const rP = 7000.07, aB = 7001;
const vP = Math.sqrt(MU_EARTH * (2 / rP - 1 / aB));
const aTca = [7000, 0, 0, 0, circ(7000), 0];
const bTca = (off) => [rP + off, 0, 0.05, 0, vP, 0.0008];
const epochState = (cfg, backSec) => {
  const s = propagate(cfg, -backSec);
  return { x: s[0], y: s[1], z: s[2], vx: s[3], vy: s[4], vz: s[5] };
};
const cov = (s) => [[s, 0, 0], [0, s, 0], [0, 0, s]];

const satA = await api('/api/objects', 'POST', {
  name: 'SAT-A 遥感卫星', operator: 'OPS-A', hardBodyRadiusM: 10, fuelBudgetKg: 50,
  missionWindows: [{ notBefore: tPlus(7200), notAfter: tPlus(6 * 3600) }],
});
const debB = await api('/api/objects', 'POST', {
  name: 'DEB-B 火箭残骸', operator: 'OPS-B', hardBodyRadiusM: 5,
});
console.log('目标已注册:', satA.name, debB.name);

// 多来源轨道解：内部定轨 + 外部 CDM
let r = await api('/api/orbit-solutions', 'POST', {
  objectId: satA.id, source: 'INTERNAL', epoch: T0, state: epochState(aTca, 3000), positionCovariance: cov(0.01),
});
console.log('SAT-A 轨道解已应用:', r.applied);
r = await api('/api/orbit-solutions', 'POST', {
  objectId: debB.id, source: 'CDM-18SPCS', epoch: T0, state: epochState(bTca(0), 3000), positionCovariance: cov(0.04),
});
const eventId = r.events[0].event.id;
console.log('会合事件:', eventId, '风险:', r.events[0].version.riskLevel,
  'Pc=', r.events[0].version.pc.toExponential(2), '脱靶', r.events[0].version.missDistanceKm.total.toFixed(3), 'km');

// 对方协同消息
await api('/api/coordination/messages', 'POST', {
  messageId: 'MSG-DEMO-001', counterpartId: 'OPS-B', eventId, type: 'PLAN_SHARE', version: 1,
  payload: { note: 'DEB-B 为无控残骸，无法机动，请贵方规避' },
});

// 提交并批准一个机动候选
const cand = await api(`/api/conjunctions/${eventId}/maneuvers`, 'POST', {
  objectId: satA.id, operatorId: 'OPS-A',
  dvVector: { x: 0, y: 0.0005, z: 0 }, executionEpoch: tPlus(3 * 3600), expectedFuelKg: 2,
  notes: '沿迹抬升 0.5 m/s',
});
const cmt = await api(`/api/maneuvers/${cand.id}/approve`, 'POST', {
  expectedCommitmentVersion: 0, approvedBy: 'OPS-A-值班员',
});
console.log('承诺已创建:', cmt.id, 'v' + cmt.version, '· 燃料冻结', cmt.frozen.fuel.requiredKg, 'kg · 协同快照', cmt.frozen.coordination.snapshotHash.slice(0, 12) + '…');

console.log('\n演示数据就绪。打开 http://localhost:8080 查看会合分析页面');
console.log('预警 API: curl ' + base + '/api/warnings');
console.log('导出: curl "' + base + '/api/coordination/export?eventId=' + eventId + '&format=csv"');
