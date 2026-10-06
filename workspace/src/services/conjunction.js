import {
  uuid, nowIso, HttpError, requireFields, requireIsoDate, requireNumber, validateMatrix,
} from '../util.js';
import {
  findCloseApproaches, assessAtTca, riskLevel, DEFAULT_RISK_THRESHOLDS,
} from '../physics.js';

/** 同一事件 TCA 匹配窗口（秒）：新评估的 TCA 与事件头版本相差在此范围内则归为同一事件的新版本 */
const TCA_MATCH_WINDOW_SEC = 1800;

export const DEFAULT_SCREENING = {
  windowSec: 3 * 86400,   // 筛查窗口：3 天
  stepSec: 60,            // 粗采样步长
  thresholdKm: 25,        // 事件创建距离阈值
};

export class ConjunctionService {
  constructor(store, { screening = {}, riskThresholds = DEFAULT_RISK_THRESHOLDS } = {}) {
    this.store = store;
    this.screening = { ...DEFAULT_SCREENING, ...screening };
    this.riskThresholds = riskThresholds;
  }

  /* ---------------- 空间目标 ---------------- */

  createObject(input) {
    requireFields(input, ['name', 'operator']);
    const obj = {
      id: uuid(),
      name: input.name,
      operator: input.operator,
      noradId: input.noradId ?? null,
      hardBodyRadiusM: input.hardBodyRadiusM ?? 10,
      fuelBudgetKg: input.fuelBudgetKg ?? 0,
      missionWindows: (input.missionWindows || []).map((w) => {
        requireIsoDate(w.notBefore, 'missionWindows.notBefore');
        requireIsoDate(w.notAfter, 'missionWindows.notAfter');
        return { notBefore: w.notBefore, notAfter: w.notAfter };
      }),
      createdAt: nowIso(),
    };
    requireNumber(obj.hardBodyRadiusM, 'hardBodyRadiusM', { min: 0 });
    requireNumber(obj.fuelBudgetKg, 'fuelBudgetKg', { min: 0 });
    this.store.state.objects.set(obj.id, obj);
    this.store.audit('OBJECT_CREATED', { objectId: obj.id, name: obj.name });
    this.store.save();
    return obj;
  }

  getObject(id) {
    const o = this.store.state.objects.get(id);
    if (!o) throw new HttpError(404, 'NOT_FOUND', `空间目标不存在: ${id}`);
    return o;
  }

  /* ---------------- 轨道解接收（多来源） ---------------- */

  /**
   * 接收轨道解 + 协方差。
   * 单调规则：仅当 epoch 晚于该目标当前最新解时才触发重筛查；
   * 迟到（epoch 更旧）的解被存档但不回退任何事件版本。
   */
  ingestOrbitSolution(input) {
    requireFields(input, ['objectId', 'source', 'epoch', 'state']);
    const obj = this.getObject(input.objectId);
    requireIsoDate(input.epoch, 'epoch');
    const st = input.state;
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) requireNumber(st[k], `state.${k}`);
    const r = Math.hypot(st.x, st.y, st.z);
    if (r < 6400 || r > 2e5) throw new HttpError(400, 'VALIDATION', `地心距异常: ${r.toFixed(1)} km`);

    let covariance6;
    if (input.covariance) {
      validateMatrix(input.covariance, 6, 6, 'covariance');
      covariance6 = input.covariance;
    } else if (input.positionCovariance) {
      validateMatrix(input.positionCovariance, 3, 3, 'positionCovariance');
      covariance6 = Array.from({ length: 6 }, (_, i) =>
        Array.from({ length: 6 }, (_, j) => (i < 3 && j < 3 ? input.positionCovariance[i][j] : (i === j ? 1e-10 : 0))));
    } else {
      throw new HttpError(400, 'VALIDATION', '必须提供 covariance(6x6) 或 positionCovariance(3x3)');
    }

    const sol = {
      id: uuid(),
      objectId: obj.id,
      source: input.source,
      epoch: input.epoch,
      epochMs: Date.parse(input.epoch),
      frame: input.frame || 'J2000',
      state: { x: st.x, y: st.y, z: st.z, vx: st.vx, vy: st.vy, vz: st.vz },
      covariance: covariance6,
      receivedAt: nowIso(),
    };
    this.store.state.solutions.set(sol.id, sol);

    const latestId = this.store.state.latestByObject.get(obj.id);
    const latest = latestId ? this.store.state.solutions.get(latestId) : null;

    if (latest && sol.epochMs < latest.epochMs) {
      // 迟到观测：存档，不触发重筛查，不回退版本
      this.store.audit('SOLUTION_LATE', { solutionId: sol.id, objectId: obj.id, epoch: sol.epoch, latestEpoch: latest.epoch });
      this.store.save();
      return { solution: sol, applied: false, late: true, latestEpoch: latest.epoch, events: [] };
    }

    this.store.state.latestByObject.set(obj.id, sol.id);
    this.store.audit('SOLUTION_APPLIED', { solutionId: sol.id, objectId: obj.id, epoch: sol.epoch, source: sol.source });
    const events = this.rescreenObject(obj.id);
    this.store.save();
    return { solution: sol, applied: true, late: false, events };
  }

  /* ---------------- 筛查与事件版本 ---------------- */

  /** 对指定目标与其余所有有最新轨道解的目标做结对筛查 */
  rescreenObject(objectId) {
    const touched = [];
    for (const otherId of this.store.state.objects.keys()) {
      if (otherId === objectId) continue;
      const otherSolId = this.store.state.latestByObject.get(otherId);
      if (!otherSolId) continue;
      const r = this.assessPair(objectId, otherId);
      if (r) touched.push(...r);
    }
    return touched;
  }

  /** 全量重筛查（手动触发） */
  rescreenAll() {
    const ids = [...this.store.state.objects.keys()].filter((id) => this.store.state.latestByObject.has(id));
    const touched = [];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const r = this.assessPair(ids[i], ids[j]);
        if (r) touched.push(...r);
      }
    return touched;
  }

  assessPair(objectIdA, objectIdB) {
    const s = this.store.state;
    const solA = s.solutions.get(s.latestByObject.get(objectIdA));
    const solB = s.solutions.get(s.latestByObject.get(objectIdB));
    if (!solA || !solB) return null;
    const objA = s.objects.get(objectIdA);
    const objB = s.objects.get(objectIdB);

    const stateA = [solA.state.x, solA.state.y, solA.state.z, solA.state.vx, solA.state.vy, solA.state.vz];
    const stateB = [solB.state.x, solB.state.y, solB.state.z, solB.state.vx, solB.state.vy, solB.state.vz];

    const { minima, deepest } = findCloseApproaches(stateA, solA.epochMs, stateB, solB.epochMs, this.screening);
    const pairKey = [objectIdA, objectIdB].sort().join('|');
    const openEvents = [...s.events.values()].filter((e) => e.pairKey === pairKey && e.status !== 'CLOSED');

    const results = [];
    const matched = new Set();

    // 低于阈值的局部极小 → 生成/更新事件
    for (const m of minima) {
      const ev = this._matchEvent(openEvents, m.tMs, matched);
      const assessment = this._buildAssessment(solA, solB, objA, objB, m.tMs);
      const event = ev || this._createEvent(pairKey, objectIdA, objectIdB);
      matched.add(event.id);
      results.push(this._appendVersion(event, assessment));
    }

    // 已有但未匹配到近距离极小的事件：用最深处评估更新（风险可能下降/解除）
    for (const ev of openEvents) {
      if (matched.has(ev.id)) continue;
      if (Math.abs(deepest.tMs - ev.headTcaMs) > TCA_MATCH_WINDOW_SEC * 1000) continue;
      const assessment = this._buildAssessment(solA, solB, objA, objB, deepest.tMs);
      results.push(this._appendVersion(ev, assessment));
    }
    return results;
  }

  _matchEvent(openEvents, tcaMs, excluded) {
    let best = null, bestDt = Infinity;
    for (const ev of openEvents) {
      if (excluded.has(ev.id)) continue;
      const dt = Math.abs(ev.headTcaMs - tcaMs);
      if (dt <= TCA_MATCH_WINDOW_SEC * 1000 && dt < bestDt) { best = ev; bestDt = dt; }
    }
    return best;
  }

  _createEvent(pairKey, a, b) {
    const n = this.store.nextSeq('event');
    const event = {
      id: `EVT-${String(n).padStart(4, '0')}`,
      pairKey,
      primaryObjectId: a,
      secondaryObjectId: b,
      status: 'OPEN',
      versions: [],
      rejectedAssessments: [], // 被单调规则拒绝的评估（审计可见）
      currentVersion: 0,
      headTcaMs: 0,
      commitmentHead: 0, // 承诺链头版本号
      createdAt: nowIso(),
    };
    this.store.state.events.set(event.id, event);
    this.store.audit('EVENT_CREATED', { eventId: event.id, pairKey });
    return event;
  }

  _buildAssessment(solA, solB, objA, objB, tcaMs) {
    const stateOf = (s) => [s.state.x, s.state.y, s.state.z, s.state.vx, s.state.vy, s.state.vz];
    const a = assessAtTca({
      stateA: stateOf(solA), epochAMs: solA.epochMs, covA6: solA.covariance, radiusAM: objA.hardBodyRadiusM,
      stateB: stateOf(solB), epochBMs: solB.epochMs, covB6: solB.covariance, radiusBM: objB.hardBodyRadiusM,
      tcaMs,
    });
    return {
      inputs: {
        primarySolutionId: solA.id, secondarySolutionId: solB.id,
        primaryEpoch: solA.epoch, secondaryEpoch: solB.epoch,
        primaryEpochMs: solA.epochMs, secondaryEpochMs: solB.epochMs,
      },
      tca: a.tca, tcaMs,
      missDistanceKm: a.missDistanceKm,
      relativeVelocityKmS: a.relativeVelocityKmS,
      encounterPlane: a.encounterPlane,
      combinedHardBodyRadiusM: a.combinedHardBodyRadiusM,
      pc: a.pc,
      riskLevel: riskLevel(a, this.riskThresholds),
    };
  }

  /**
   * 追加事件版本 —— 单调版本化核心规则：
   * 仅当新评估的两个输入观测 epoch 均不旧于头版本、且至少一个更新时才接受；
   * 否则记入 rejectedAssessments（迟到/重放数据不得回退风险历史）。
   */
  _appendVersion(event, assessment) {
    const head = event.versions[event.versions.length - 1];
    if (head) {
      const newer =
        assessment.inputs.primaryEpochMs >= head.inputs.primaryEpochMs &&
        assessment.inputs.secondaryEpochMs >= head.inputs.secondaryEpochMs &&
        (assessment.inputs.primaryEpochMs > head.inputs.primaryEpochMs ||
          assessment.inputs.secondaryEpochMs > head.inputs.secondaryEpochMs);
      if (!newer) {
        const rej = { at: nowIso(), reason: 'STALE_OBSERVATION', inputs: assessment.inputs, tca: assessment.tca };
        event.rejectedAssessments.push(rej);
        this.store.audit('EVENT_VERSION_REJECTED', { eventId: event.id, reason: rej.reason });
        return { event, appended: false, rejected: rej };
      }
    }
    const version = {
      version: event.versions.length + 1,
      ...assessment,
      createdAt: nowIso(),
    };
    event.versions.push(version);
    event.currentVersion = version.version;
    event.headTcaMs = version.tcaMs;
    // 风险解除/重开
    if (version.riskLevel === 'GREEN' && version.missDistanceKm.total > this.screening.thresholdKm) {
      event.status = 'CLOSED';
    } else if (event.status === 'CLOSED') {
      event.status = 'OPEN';
    }
    this.store.audit('EVENT_VERSION_APPENDED', {
      eventId: event.id, version: version.version, pc: version.pc,
      missKm: version.missDistanceKm.total, risk: version.riskLevel,
    });
    return { event, appended: true, version };
  }

  /* ---------------- 查询 ---------------- */

  getEvent(id) {
    const e = this.store.state.events.get(id);
    if (!e) throw new HttpError(404, 'NOT_FOUND', `会合事件不存在: ${id}`);
    return e;
  }

  eventSummary(e) {
    const head = e.versions[e.versions.length - 1];
    return {
      id: e.id, status: e.status,
      primaryObjectId: e.primaryObjectId, secondaryObjectId: e.secondaryObjectId,
      currentVersion: e.currentVersion, commitmentHead: e.commitmentHead,
      head: head ? {
        version: head.version, tca: head.tca, pc: head.pc,
        missDistanceKm: head.missDistanceKm, riskLevel: head.riskLevel,
        relativeVelocityKmS: head.relativeVelocityKmS,
      } : null,
      createdAt: e.createdAt,
    };
  }

  listEvents({ status, minRisk } = {}) {
    const order = { GREEN: 0, YELLOW: 1, RED: 2 };
    let evs = [...this.store.state.events.values()];
    if (status) evs = evs.filter((e) => e.status === status);
    if (minRisk) evs = evs.filter((e) => e.versions.length && order[e.versions[e.versions.length - 1].riskLevel] >= order[minRisk]);
    return evs.map((e) => this.eventSummary(e))
      .sort((a, b) => (b.head?.pc ?? 0) - (a.head?.pc ?? 0));
  }

  /** 预警 API：头版本风险达到阈值的事件 */
  warnings(minLevel = 'YELLOW') {
    const order = { GREEN: 0, YELLOW: 1, RED: 2 };
    return this.listEvents({ status: 'OPEN' })
      .filter((e) => e.head && order[e.head.riskLevel] >= order[minLevel])
      .map((e) => ({
        eventId: e.id,
        level: e.head.riskLevel,
        pc: e.head.pc,
        missDistanceKm: e.head.missDistanceKm.total,
        tca: e.head.tca,
        primaryObjectId: e.primaryObjectId,
        secondaryObjectId: e.secondaryObjectId,
        eventVersion: e.currentVersion,
        commitmentHead: e.commitmentHead,
      }));
  }
}
