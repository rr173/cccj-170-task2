import {
  uuid, nowIso, HttpError, requireFields, requireIsoDate, requireNumber,
} from '../util.js';

/**
 * 机动候选与承诺服务。
 *
 * 不变量：
 *  1. 批准即冻结：燃料约束、任务窗口、对方协同消息快照写入承诺，之后不可变。
 *  2. 承诺版本单调：每事件承诺链版本号严格递增；并发批准通过
 *     expectedCommitmentVersion 比较并交换（CAS），只有一个成功，其余 409。
 *  3. 已下达（DISPATCHED）承诺为终态，任何迟到低版本消息/新批准都不得撤销它。
 *  4. 候选必须基于事件当前头版本评估（新观测到达后旧候选不可直接批准）。
 */
export class ManeuverService {
  constructor(store, conjunction, coordination) {
    this.store = store;
    this.conjunction = conjunction;
    this.coordination = coordination;
  }

  /* ---------------- 候选 ---------------- */

  submitCandidate(eventId, input) {
    requireFields(input, ['objectId', 'dvVector', 'executionEpoch', 'expectedFuelKg', 'operatorId']);
    const event = this.conjunction.getEvent(eventId);
    const obj = this.conjunction.getObject(input.objectId);
    if (obj.id !== event.primaryObjectId && obj.id !== event.secondaryObjectId) {
      throw new HttpError(400, 'VALIDATION', `目标 ${obj.id} 不属于事件 ${eventId}`);
    }
    requireIsoDate(input.executionEpoch, 'executionEpoch');
    requireNumber(input.expectedFuelKg, 'expectedFuelKg', { min: 0 });
    const dv = input.dvVector;
    for (const k of ['x', 'y', 'z']) requireNumber(dv[k], `dvVector.${k}`);
    const dvMag = Math.hypot(dv.x, dv.y, dv.z);
    if (dvMag <= 0) throw new HttpError(400, 'VALIDATION', 'dvVector 模长必须大于 0');

    const n = this.store.nextSeq('candidate');
    const candidate = {
      id: `CND-${String(n).padStart(4, '0')}`,
      eventId,
      objectId: obj.id,
      operatorId: input.operatorId,
      eventVersion: event.currentVersion, // 基于当前头版本评估
      dvVector: { x: dv.x, y: dv.y, z: dv.z },
      dvMagnitudeKmS: dvMag,
      executionEpoch: input.executionEpoch,
      expectedFuelKg: input.expectedFuelKg,
      notes: input.notes || null,
      status: 'SUBMITTED',
      submittedAt: nowIso(),
    };
    this.store.state.candidates.set(candidate.id, candidate);
    this.store.audit('CANDIDATE_SUBMITTED', { candidateId: candidate.id, eventId, eventVersion: candidate.eventVersion });
    this.store.save();
    return candidate;
  }

  getCandidate(id) {
    const c = this.store.state.candidates.get(id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', `机动候选不存在: ${id}`);
    return c;
  }

  rejectCandidate(id, { rejectedBy, reason } = {}) {
    const c = this.getCandidate(id);
    if (c.status !== 'SUBMITTED') {
      throw new HttpError(409, 'INVALID_STATE', `候选状态 ${c.status} 不可拒绝`);
    }
    c.status = 'REJECTED';
    c.rejectedAt = nowIso();
    c.rejectedBy = rejectedBy || null;
    c.rejectReason = reason || null;
    this.store.audit('CANDIDATE_REJECTED', { candidateId: id, reason });
    this.store.save();
    return c;
  }

  /* ---------------- 批准（冻结 + CAS） ---------------- */

  /**
   * 批准候选 → 生成不可变承诺。
   * @param expectedCommitmentVersion 调用方看到的承诺链头版本（无承诺时为 0）。
   *        并发批准时只有一个 CAS 成功，失败者收到 409 与当前头版本。
   */
  approveCandidate(candidateId, { expectedCommitmentVersion, approvedBy } = {}) {
    requireNumber(expectedCommitmentVersion, 'expectedCommitmentVersion', { min: 0 });
    const candidate = this.getCandidate(candidateId);
    const event = this.conjunction.getEvent(candidate.eventId);
    const obj = this.conjunction.getObject(candidate.objectId);

    if (candidate.status !== 'SUBMITTED') {
      throw new HttpError(409, 'INVALID_STATE', `候选状态 ${candidate.status} 不可批准`);
    }
    // 新观测到达后事件头已前进：旧评估的候选不可直接批准
    if (candidate.eventVersion !== event.currentVersion) {
      throw new HttpError(409, 'STALE_EVENT_VERSION',
        `候选基于事件版本 ${candidate.eventVersion}，当前头版本 ${event.currentVersion}，请重新评估后提交`,
        { currentEventVersion: event.currentVersion });
    }
    // CAS：承诺链头必须等于调用方预期
    if (expectedCommitmentVersion !== event.commitmentHead) {
      throw new HttpError(409, 'VERSION_CONFLICT',
        `承诺链头已推进到 ${event.commitmentHead}，并发批准冲突，请基于最新状态重试`,
        { currentCommitmentHead: event.commitmentHead });
    }
    // 已下达承诺存在：除非事件已有更新版本评估，否则禁止再批准（不得变相撤销已下达机动）
    const dispatched = this._commitmentsForEvent(event.id).find((c) => c.status === 'DISPATCHED');
    if (dispatched && candidate.eventVersion <= dispatched.eventVersion) {
      throw new HttpError(409, 'DISPATCHED_EXISTS',
        `承诺 ${dispatched.id} 已下达且候选未基于更新的事件版本，禁止批准`);
    }

    // ---- 冻结 1：燃料约束（同事件未下达承诺将被本次批准原子取代，不计入已耗） ----
    const fuel = this._freezeFuel(obj, candidate, event);
    // ---- 冻结 2：任务窗口 ----
    const missionWindow = this._freezeWindow(obj, candidate);
    // ---- 冻结 3：对方协同消息快照 ----
    const coordination = this.coordination.snapshotForEvent(event.id);

    const n = this.store.nextSeq('commitment');
    const version = event.commitmentHead + 1;
    const commitment = {
      id: `CMT-${String(n).padStart(4, '0')}`,
      eventId: event.id,
      eventVersion: candidate.eventVersion,
      version,
      candidateId: candidate.id,
      objectId: obj.id,
      operatorId: candidate.operatorId,
      maneuver: {
        dvVector: candidate.dvVector,
        dvMagnitudeKmS: candidate.dvMagnitudeKmS,
        executionEpoch: candidate.executionEpoch,
      },
      frozen: { fuel, missionWindow, coordination },
      status: 'APPROVED',
      approvedBy: approvedBy || null,
      createdAt: nowIso(),
    };

    // 原子提交：前序 APPROVED 承诺被更高版本取代（DISPATCHED 永不取代）
    for (const c of this._commitmentsForEvent(event.id)) {
      if (c.status === 'APPROVED') {
        c.status = 'SUPERSEDED';
        c.supersededBy = commitment.id;
      }
    }
    this.store.state.commitments.set(commitment.id, commitment);
    event.commitmentHead = version;
    candidate.status = 'APPROVED';
    candidate.commitmentId = commitment.id;

    this.store.audit('COMMITMENT_CREATED', {
      commitmentId: commitment.id, eventId: event.id, version,
      fuelFrozen: fuel, windowFrozen: missionWindow, coordHash: coordination.snapshotHash,
    });
    // 出站协同：向对方通报已批准计划
    this.coordination.emitOutbound(event.id, 'PLAN_SHARE', {
      commitmentId: commitment.id, version,
      executionEpoch: candidate.executionEpoch, dvMagnitudeKmS: candidate.dvMagnitudeKmS,
    });
    this.store.save();
    return commitment;
  }

  /** 燃料冻结：预算 - 已承诺消耗 ≥ 本次需求，快照全部数值。
   *  同事件 APPROVED 承诺将在本事务内被取代，其占用不计入（原子替换语义）。 */
  _freezeFuel(obj, candidate, event) {
    const consumed = this._commitmentsForObject(obj.id)
      .filter((c) => c.status === 'DISPATCHED' || (c.status === 'APPROVED' && c.eventId !== event.id))
      .reduce((sum, c) => sum + c.frozen.fuel.requiredKg, 0);
    const remaining = obj.fuelBudgetKg - consumed;
    if (candidate.expectedFuelKg > remaining + 1e-9) {
      throw new HttpError(422, 'FUEL_CONSTRAINT',
        `燃料约束不满足: 需求 ${candidate.expectedFuelKg} kg > 剩余 ${remaining.toFixed(3)} kg`,
        { budgetKg: obj.fuelBudgetKg, consumedKg: consumed, requiredKg: candidate.expectedFuelKg });
    }
    return {
      budgetKg: obj.fuelBudgetKg,
      consumedBeforeKg: consumed,
      requiredKg: candidate.expectedFuelKg,
      remainingAfterKg: remaining - candidate.expectedFuelKg,
      constraintCheckedAt: nowIso(),
    };
  }

  /** 任务窗口冻结：执行时刻必须落在某个允许窗口内，快照该窗口 */
  _freezeWindow(obj, candidate) {
    const execMs = Date.parse(candidate.executionEpoch);
    const win = (obj.missionWindows || []).find(
      (w) => execMs >= Date.parse(w.notBefore) && execMs <= Date.parse(w.notAfter));
    if (obj.missionWindows?.length && !win) {
      throw new HttpError(422, 'WINDOW_CONSTRAINT',
        `执行时刻 ${candidate.executionEpoch} 不在任何任务窗口内`,
        { missionWindows: obj.missionWindows });
    }
    return {
      executionEpoch: candidate.executionEpoch,
      matchedWindow: win || null,
      allWindows: obj.missionWindows || [],
      constraintCheckedAt: nowIso(),
    };
  }

  /* ---------------- 下达 ---------------- */

  /** 下达承诺：APPROVED → DISPATCHED（终态，不可变） */
  dispatchCommitment(id, { dispatchedBy } = {}) {
    const c = this.getCommitment(id);
    if (c.status !== 'APPROVED') {
      throw new HttpError(409, 'INVALID_STATE', `承诺状态 ${c.status} 不可下达（仅 APPROVED 可下达）`);
    }
    c.status = 'DISPATCHED';
    c.dispatchedAt = nowIso();
    c.dispatchedBy = dispatchedBy || null;
    this.store.audit('COMMITMENT_DISPATCHED', { commitmentId: id, eventId: c.eventId, version: c.version });
    this.coordination.emitOutbound(c.eventId, 'PLAN_SHARE', {
      commitmentId: c.id, version: c.version, status: 'DISPATCHED',
      executionEpoch: c.maneuver.executionEpoch,
    });
    this.store.save();
    return c;
  }

  getCommitment(id) {
    const c = this.store.state.commitments.get(id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', `承诺不存在: ${id}`);
    return c;
  }

  _commitmentsForEvent(eventId) {
    return [...this.store.state.commitments.values()].filter((c) => c.eventId === eventId);
  }

  _commitmentsForObject(objectId) {
    return [...this.store.state.commitments.values()].filter((c) => c.objectId === objectId);
  }

  listCommitments({ eventId, objectId } = {}) {
    let cs = [...this.store.state.commitments.values()];
    if (eventId) cs = cs.filter((c) => c.eventId === eventId);
    if (objectId) cs = cs.filter((c) => c.objectId === objectId);
    return cs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
