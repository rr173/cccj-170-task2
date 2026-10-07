import {
  uuid, nowIso, sha256, canonical, HttpError, requireFields, requireNumber, toCsv,
} from '../util.js';

/**
 * 协同消息服务：
 *  - messageId 幂等去重（重放安全）
 *  - 每个 (对方, 事件) 通道维护单调递增的已应用版本；低版本消息记入 STALE_REJECTED
 *  - CANCEL 不得撤销已下达（DISPATCHED）承诺；迟到低版本 CANCEL 一律拒绝
 *  - 承诺创建/下达时自动生成出站 PLAN_SHARE 消息（本地序号单调）
 */
export class CoordinationService {
  constructor(store) {
    this.store = store;
  }

  _key(counterpartId, eventId) {
    return `${counterpartId}|${eventId}`;
  }

  appliedVersion(counterpartId, eventId) {
    return this.store.state.coordApplied.get(this._key(counterpartId, eventId)) || 0;
  }

  /**
   * 接收对方协同消息。返回受理回执（重放时返回原回执 + deduplicated 标记）。
   */
  receiveMessage(input) {
    requireFields(input, ['messageId', 'counterpartId', 'eventId', 'type', 'version']);
    requireNumber(input.version, 'version', { min: 0 });
    const s = this.store.state;

    // 1) 重放去重：同一 messageId 直接返回原回执，不产生任何状态变更
    const existing = s.receipts.get(input.messageId);
    if (existing) {
      this.store.audit('MESSAGE_REPLAY_DEDUPED', { messageId: input.messageId });
      return { ...existing, deduplicated: true };
    }

    const event = s.events.get(input.eventId);
    if (!event) throw new HttpError(404, 'NOT_FOUND', `会合事件不存在: ${input.eventId}`);

    const validTypes = ['PLAN_SHARE', 'PLAN_UPDATE', 'AGREEMENT', 'CANCEL', 'ACK'];
    if (!validTypes.includes(input.type)) {
      throw new HttpError(400, 'VALIDATION', `未知消息类型: ${input.type}`);
    }

    const msg = {
      id: input.messageId,
      direction: 'INBOUND',
      counterpartId: input.counterpartId,
      eventId: input.eventId,
      type: input.type,
      version: input.version,
      payload: input.payload || {},
      receivedAt: nowIso(),
      status: 'RECEIVED',
      statusReason: null,
    };

    const key = this._key(msg.counterpartId, msg.eventId);
    const applied = s.coordApplied.get(key) || 0;
    let receipt;

    // 2) 单调版本：低版本/同版本消息拒绝应用（重放或迟到）
    if (msg.version <= applied) {
      msg.status = 'STALE_REJECTED';
      msg.statusReason = `消息版本 ${msg.version} ≤ 已应用版本 ${applied}`;
      receipt = { messageId: msg.id, status: 'STALE_REJECTED', appliedVersion: applied, receivedVersion: msg.version };
    } else if (msg.type === 'CANCEL') {
      receipt = this._handleCancel(msg, event);
    } else {
      s.coordApplied.set(key, msg.version);
      msg.status = 'APPLIED';
      receipt = { messageId: msg.id, status: 'APPLIED', appliedVersion: msg.version };
    }

    s.messages.set(msg.id, msg);
    s.receipts.set(msg.id, receipt);
    this.store.audit('MESSAGE_RECEIVED', {
      messageId: msg.id, type: msg.type, version: msg.version, status: msg.status, eventId: msg.eventId,
    });
    this.store.save();
    return receipt;
  }

  /**
   * CANCEL 处理：
   *  - 目标承诺已 DISPATCHED → 一律拒绝（已下达机动不可撤销）
   *  - CANCEL 版本 ≤ 承诺冻结时的对方计划版本 → 迟到低版本，拒绝
   *  - 否则撤销未下达的承诺（状态机只前进：APPROVED → CANCELLED）
   */
  _handleCancel(msg, event) {
    const s = this.store.state;
    const commitmentId = msg.payload?.commitmentId;
    const commitment = commitmentId ? s.commitments.get(commitmentId) : null;
    if (!commitment) {
      msg.status = 'REJECTED';
      msg.statusReason = `CANCEL 引用的承诺不存在: ${commitmentId}`;
      return { messageId: msg.id, status: 'REJECTED', reason: msg.statusReason };
    }
    if (commitment.eventId !== event.id) {
      msg.status = 'REJECTED';
      msg.statusReason = 'CANCEL 引用的承诺不属于该事件';
      return { messageId: msg.id, status: 'REJECTED', reason: msg.statusReason };
    }
    if (commitment.status === 'DISPATCHED') {
      msg.status = 'REJECTED';
      msg.statusReason = 'DISPATCHED_IMMUTABLE: 已下达机动不可被撤销';
      this.store.audit('CANCEL_REJECTED_DISPATCHED', { commitmentId, messageId: msg.id, version: msg.version });
      return { messageId: msg.id, status: 'REJECTED', reason: msg.statusReason, commitmentStatus: 'DISPATCHED' };
    }
    if (commitment.status !== 'APPROVED') {
      msg.status = 'REJECTED';
      msg.statusReason = `承诺当前状态 ${commitment.status} 不可撤销`;
      return { messageId: msg.id, status: 'REJECTED', reason: msg.statusReason };
    }
    const frozenCpVersion = commitment.frozen.coordination.counterpartPlanVersion;
    if (msg.version <= frozenCpVersion) {
      msg.status = 'STALE_REJECTED';
      msg.statusReason = `迟到低版本撤销被拒绝: 版本 ${msg.version} ≤ 承诺冻结版本 ${frozenCpVersion}`;
      this.store.audit('CANCEL_REJECTED_STALE', { commitmentId, messageId: msg.id, version: msg.version, frozenCpVersion });
      return { messageId: msg.id, status: 'STALE_REJECTED', reason: msg.statusReason };
    }
    // 高版本 CANCEL 且承诺未下达：撤销
    commitment.status = 'CANCELLED';
    commitment.cancelledAt = nowIso();
    commitment.cancelledByMessage = msg.id;
    s.coordApplied.set(this._key(msg.counterpartId, msg.eventId), msg.version);
    msg.status = 'APPLIED';
    this.store.audit('COMMITMENT_CANCELLED_BY_COUNTERPART', {
      commitmentId, eventId: event.id, messageId: msg.id, version: msg.version,
    });
    return { messageId: msg.id, status: 'APPLIED', commitmentStatus: 'CANCELLED' };
  }

  /** 出站消息（本地序号单调递增） */
  emitOutbound(eventId, type, payload) {
    const s = this.store.state;
    const seq = (s.outboundSeq.get(eventId) || 0) + 1;
    s.outboundSeq.set(eventId, seq);
    const n = this.store.nextSeq('message');
    const msg = {
      id: `OUT-${String(n).padStart(6, '0')}`,
      direction: 'OUTBOUND',
      counterpartId: payload?.counterpartId || 'COUNTERPART',
      eventId,
      type,
      version: seq,
      payload,
      receivedAt: nowIso(),
      status: 'SENT',
    };
    s.messages.set(msg.id, msg);
    this.store.audit('MESSAGE_SENT', {
      messageId: msg.id, counterpartId: msg.counterpartId, type, eventId,
      version: seq, payload,
    });
    this.store.save();
    return msg;
  }

  /**
   * 承诺冻结用协同快照：当前事件已应用的入站消息 + 对方计划版本 + 哈希。
   */
  snapshotForEvent(eventId) {
    const s = this.store.state;
    const applied = [...s.messages.values()]
      .filter((m) => m.eventId === eventId && m.direction === 'INBOUND' && m.status === 'APPLIED')
      .map((m) => ({ messageId: m.id, type: m.type, version: m.version, receivedAt: m.receivedAt }))
      .sort((a, b) => a.version - b.version);
    let counterpartPlanVersion = 0;
    for (const [key, v] of s.coordApplied.entries()) {
      if (key.endsWith(`|${eventId}`)) counterpartPlanVersion = Math.max(counterpartPlanVersion, v);
    }
    const snapshot = { counterpartPlanVersion, agreedMessages: applied };
    return { ...snapshot, snapshotHash: sha256(canonical(snapshot)) };
  }

  listMessages(eventId) {
    let msgs = [...this.store.state.messages.values()];
    if (eventId) msgs = msgs.filter((m) => m.eventId === eventId);
    return msgs.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  /** 协同记录导出（JSON / CSV）：消息 + 承诺时间线 */
  exportRecords({ eventId, format = 'json' } = {}) {
    const s = this.store.state;
    const messages = this.listMessages(eventId);
    let commitments = [...s.commitments.values()];
    if (eventId) commitments = commitments.filter((c) => c.eventId === eventId);

    const records = [
      ...messages.map((m) => ({
        recordType: 'MESSAGE', id: m.id, eventId: m.eventId, direction: m.direction,
        counterpartId: m.counterpartId, msgType: m.type, version: m.version,
        status: m.status, statusReason: m.statusReason, at: m.receivedAt, payload: m.payload,
      })),
      ...commitments.map((c) => ({
        recordType: 'COMMITMENT', id: c.id, eventId: c.eventId, direction: 'LOCAL',
        counterpartId: null, msgType: `COMMITMENT_${c.status}`, version: c.version,
        status: c.status, statusReason: null, at: c.createdAt,
        payload: { candidateId: c.candidateId, frozen: c.frozen },
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    if (format === 'csv') {
      const rows = [[
        'recordType', 'id', 'eventId', 'direction', 'counterpartId',
        'msgType', 'version', 'status', 'statusReason', 'at', 'payload',
      ]];
      for (const r of records) {
        rows.push([
          r.recordType, r.id, r.eventId, r.direction, r.counterpartId ?? '',
          r.msgType, r.version, r.status, r.statusReason ?? '', r.at, JSON.stringify(r.payload),
        ]);
      }
      return toCsv(rows);
    }
    return { exportedAt: nowIso(), eventId: eventId || null, count: records.length, records };
  }
}
