/**
 * 轨道力学与风险评估：
 *  - 通用变量法二体传播（Stumpff 函数）
 *  - 中心差分状态转移矩阵（STM）传播协方差
 *  - 最近接近点（TCA）搜索：粗采样 + 黄金分割精化
 *  - 会合平面投影 + 短弧 Encounter 近似碰撞概率 Pc
 */
import { matMul, matT } from './util.js';

export const MU_EARTH = 398600.4418; // km^3/s^2

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

function stumpff(z) {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return { C: (1 - Math.cos(s)) / z, S: (s - Math.sin(s)) / (s * s * s) };
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return { C: (Math.cosh(s) - 1) / -z, S: (Math.sinh(s) - s) / (s * s * s) };
  }
  return { C: 0.5 - z / 24 + (z * z) / 720, S: 1 / 6 - z / 120 + (z * z) / 5040 };
}

/** 二体传播：state=[x,y,z,vx,vy,vz] (km, km/s)，dt 秒 */
export function propagate(state, dt, mu = MU_EARTH) {
  if (dt === 0) return state.slice();
  const r0v = state.slice(0, 3);
  const v0v = state.slice(3, 6);
  const r0 = norm(r0v);
  const v0 = norm(v0v);
  const sqrtMu = Math.sqrt(mu);
  const alpha = 2 / r0 - (v0 * v0) / mu;
  const rv0 = dot(r0v, v0v);

  let chi = Math.abs(alpha) > 1e-9 ? sqrtMu * dt * alpha : (sqrtMu * dt) / r0;
  if (!Number.isFinite(chi) || chi === 0) chi = (sqrtMu * dt) / r0;

  let C = 0.5, S = 1 / 6, z = 0;
  for (let i = 0; i < 64; i++) {
    z = alpha * chi * chi;
    ({ C, S } = stumpff(z));
    // 通用开普勒方程：√μ·dt = (r0·v0/√μ)χ²C + (1−αr0)χ³S + r0·χ
    const F =
      (rv0 / sqrtMu) * chi * chi * C +
      (1 - alpha * r0) * chi * chi * chi * S +
      r0 * chi -
      sqrtMu * dt;
    if (Math.abs(F) < 1e-9) break;
    const dF = (rv0 / sqrtMu) * chi * (1 - z * S) + (1 - alpha * r0) * chi * chi * C + r0;
    chi -= F / dF;
  }
  z = alpha * chi * chi;
  ({ C, S } = stumpff(z));

  const f = 1 - (chi * chi / r0) * C;
  const g = dt - (chi ** 3 / sqrtMu) * S;
  const r = vAdd(vScale(r0v, f), vScale(v0v, g));
  const rn = norm(r);
  const fdot = (sqrtMu / (rn * r0)) * chi * (z * S - 1);
  const gdot = 1 - (chi * chi / rn) * C;
  const v = vAdd(vScale(r0v, fdot), vScale(v0v, gdot));
  return [...r, ...v];
}

/** 中心差分 STM：Φ = ∂x(t)/∂x(t0)，6x6 */
export function stateTransitionMatrix(state, dt, mu = MU_EARTH) {
  const Phi = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (let col = 0; col < 6; col++) {
    const h = Math.max(Math.abs(state[col]) * 1e-6, 1e-6);
    const sp = state.slice(); sp[col] += h;
    const sm = state.slice(); sm[col] -= h;
    const pp = propagate(sp, dt, mu);
    const pm = propagate(sm, dt, mu);
    for (let row = 0; row < 6; row++) Phi[row][col] = (pp[row] - pm[row]) / (2 * h);
  }
  return Phi;
}

/** 协方差传播：C(t) = Φ C0 Φᵀ */
export function propagateCovariance(cov6, state, dt, mu = MU_EARTH) {
  if (dt === 0) return cov6;
  const Phi = stateTransitionMatrix(state, dt, mu);
  return matMul(Phi, matMul(cov6, matT(Phi)));
}

const distanceAt = (stateA, epochAMs, stateB, epochBMs, tMs) => {
  const a = propagate(stateA, (tMs - epochAMs) / 1000);
  const b = propagate(stateB, (tMs - epochBMs) / 1000);
  return norm(vSub(a.slice(0, 3), b.slice(0, 3)));
};

function goldenMin(fn, lo, hi, tolMs = 10) {
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = fn(c), fd = fn(d);
  while (b - a > tolMs) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = fn(c); }
    else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = fn(d); }
  }
  const t = (a + b) / 2;
  return { tMs: t, distKm: fn(t) };
}

/**
 * 在 [max(epochA,epochB), +windowSec] 内搜索近距离接近。
 * 返回 { minima: [{tMs, distKm}], deepest } —— minima 仅含低于 thresholdKm 的局部极小。
 */
export function findCloseApproaches(stateA, epochAMs, stateB, epochBMs, {
  windowSec = 3 * 86400,
  stepSec = 60,
  thresholdKm = 25,
} = {}) {
  const t0 = Math.max(epochAMs, epochBMs);
  const n = Math.max(1, Math.ceil(windowSec / stepSec));
  const fn = (t) => distanceAt(stateA, epochAMs, stateB, epochBMs, t);

  const samples = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = t0 + i * stepSec * 1000;
    samples[i] = { t, d: fn(t) };
  }

  const minima = [];
  let deepest = samples[0];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].d < deepest.d) deepest = samples[i];
    if (i === 0 || i === samples.length - 1) continue;
    const s = samples[i];
    if (s.d <= samples[i - 1].d && s.d < samples[i + 1].d && s.d < thresholdKm) {
      // 与已找到的极小点去重（间隔小于 1.5 步长）
      if (minima.length && s.t - minima[minima.length - 1].tMs < stepSec * 1500) continue;
      minima.push(goldenMin(fn, samples[i - 1].t, samples[i + 1].t));
    }
  }
  const deepestRefined = goldenMin(fn, Math.max(t0, deepest.t - stepSec * 1000), deepest.t + stepSec * 1000);
  return { minima, deepest: deepestRefined };
}

/**
 * 在 TCA 处评估风险。
 * @param radiusAM/radiusBM 硬体半径（米）
 */
export function assessAtTca({
  stateA, epochAMs, covA6, radiusAM,
  stateB, epochBMs, covB6, radiusBM,
  tcaMs,
}) {
  const dtA = (tcaMs - epochAMs) / 1000;
  const dtB = (tcaMs - epochBMs) / 1000;
  const a = propagate(stateA, dtA);
  const b = propagate(stateB, dtB);

  const relPos = vSub(b.slice(0, 3), a.slice(0, 3));
  const relVel = vSub(b.slice(3, 6), a.slice(3, 6));
  const miss = norm(relPos);
  const relSpeed = norm(relVel);

  // 主星 RIC 坐标系
  const rA = a.slice(0, 3);
  const R = vScale(rA, 1 / norm(rA));
  const hVec = cross(rA, a.slice(3, 6));
  const Cn = vScale(hVec, 1 / norm(hVec));
  const I = cross(Cn, R);
  const ric = { radial: dot(relPos, R), inTrack: dot(relPos, I), crossTrack: dot(relPos, Cn) };

  // 协方差传播到 TCA 并合成
  const covA = propagateCovariance(covA6, stateA, dtA);
  const covB = propagateCovariance(covB6, stateB, dtB);
  const comb = [
    [covA[0][0] + covB[0][0], covA[0][1] + covB[0][1], covA[0][2] + covB[0][2]],
    [covA[1][0] + covB[1][0], covA[1][1] + covB[1][1], covA[1][2] + covB[1][2]],
    [covA[2][0] + covB[2][0], covA[2][1] + covB[2][1], covA[2][2] + covB[2][2]],
  ];

  // 会合平面（垂直于相对速度）
  const nHat = vScale(relVel, 1 / relSpeed);
  const ref = Math.abs(nHat[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let e1 = cross(nHat, ref);
  e1 = vScale(e1, 1 / norm(e1));
  const e2 = cross(nHat, e1);
  const E = [e1, e2];
  const C2 = matMul(E, matMul(comb, matT(E)));
  const xi = [dot(relPos, e1), dot(relPos, e2)];

  const det = C2[0][0] * C2[1][1] - C2[0][1] * C2[1][0];
  let pc = 0;
  let sigmaX = 0, sigmaY = 0;
  if (det > 0) {
    sigmaX = Math.sqrt(C2[0][0]);
    sigmaY = Math.sqrt(C2[1][1]);
    const inv = [[C2[1][1] / det, -C2[0][1] / det], [-C2[1][0] / det, C2[0][0] / det]];
    const q = xi[0] * (inv[0][0] * xi[0] + inv[0][1] * xi[1]) + xi[1] * (inv[1][0] * xi[0] + inv[1][1] * xi[1]);
    const pdf = Math.exp(-0.5 * q) / (2 * Math.PI * Math.sqrt(det));
    const Rm = (radiusAM + radiusBM) / 1000; // 合成硬体半径，km
    // 短弧 encounter 近似：Pc ≈ 圆面积 × 会合平面概率密度
    pc = Math.min(1, Math.PI * Rm * Rm * pdf);
  }

  return {
    tca: new Date(tcaMs).toISOString(),
    missDistanceKm: {
      total: miss,
      radial: ric.radial,
      inTrack: ric.inTrack,
      crossTrack: ric.crossTrack,
    },
    relativeVelocityKmS: relSpeed,
    encounterPlane: { sigmaXKm: sigmaX, sigmaYKm: sigmaY, missXKm: xi[0], missYKm: xi[1] },
    combinedHardBodyRadiusM: radiusAM + radiusBM,
    pc,
  };
}

export const DEFAULT_RISK_THRESHOLDS = {
  pcRed: 1e-4,
  pcYellow: 1e-6,
  missRedKm: 1,
  missYellowKm: 5,
};

export function riskLevel(assessment, th = DEFAULT_RISK_THRESHOLDS) {
  if (assessment.pc >= th.pcRed || assessment.missDistanceKm.total <= th.missRedKm) return 'RED';
  if (assessment.pc >= th.pcYellow || assessment.missDistanceKm.total <= th.missYellowKm) return 'YELLOW';
  return 'GREEN';
}

export const RISK_ORDER = { GREEN: 0, YELLOW: 1, RED: 2 };
