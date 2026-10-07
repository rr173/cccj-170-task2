import fs from 'node:fs';
import { HttpError, sha256, canonical, nowIso, toCsv } from '../util.js';

const GENESIS_HASH = 'GENESIS';

/**
 * 只读审计回放服务（值班人员使用）。
 *
 * 数据来源是**追加账本**（audit.log 优先；无文件时退回内存账本），
 * 重放过程只做读取与重建，绝不触碰线上 Store 的活动状态，也不写入任何记录。
 *
 * 能力：
 *  1. verifyChain：校验账本哈希链（seq 连续 / prevHash 衔接 / hash 正确 / 无损坏行）
 *  2. timeline：按事件从账本重放重建一条协同时间线（风险版本 / 承诺 / 消息）
 *  3. resolveCut：把截面描述符（seq | ts | HEAD）解析为账本上的一个确定位置
 *  4. diff：两个截面之间风险、承诺、消息的差异
 *  5. exportDiff：JSON / CSV 导出
 *
 * 可识别错误：
 *  SNAPSHOT_NOT_FOUND      截面不存在
 *  CHAIN_VALIDATION_FAILED 链校验失败（时间线/差异/导出一律拒绝）
 *  CROSS_EVENT_SELECTION   两个截面分属不同事件
 *  UNSUPPORTED_FORMAT      不支持的导出格式
 */
export class ReplayService {
  constructor(store, { auditFile = null } = {}) {
    this.store = store;
    this.auditFile = auditFile || store.auditFile || null;
  }

  /* ================= 账本读取（只读） ================= */

  /**
   * 读取追加账本。优先读磁盘文件（权威追加账本），否则退回内存账本。
   * 损坏/不可解析的行返回 null 占位，保持行号可定位。
   */
  _readLedger() {
    if (this.auditFile && fs.existsSync(this.auditFile)) {
      const lines = fs.readFileSync(this.auditFile, 'utf8').split('\n').filter((l) => l.trim().length);
      return lines.map((line, i) => {
        try {
          const e = JSON.parse(line);
          if (!e || typeof e !== 'object' || !e.kind) return { __malformed: true, line: i + 1, reason: '记录缺少 kind 字段' };
          return e;
        } catch (e) {
          return { __malformed: true, line: i + 1, reason: `JSON 解析失败: ${e.message}` };
        }
      });
    }
    return this.store.auditTrail.map((e) => ({ ...e }));
  }

  /* ================= 链校验 ================= */

  /**
   * 校验整条哈希链。返回 {ok, entries, ...诊断}。ok=false 时 entries 仍返回（供页面展示断裂点）。
   */
  verifyChain() {
    const entries = this._readLedger();
    const errors = [];
    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;
    const involvedEvents = new Set();

    entries.forEach((e, i) => {
      const line = i + 1;
      if (e.__malformed) {
        errors.push({ line, code: 'MALFORMED_ENTRY', message: `第 ${line} 行损坏：${e.reason}` });
        return;
      }
      if (e.eventId) involvedEvents.add(e.eventId);
      if (!Number.isInteger(e.seq)) {
        errors.push({ line, seq: e.seq ?? null, code: 'BAD_SEQ', message: `第 ${line} 行缺少合法 seq` });
        return;
      }
      if (e.seq !== expectedSeq) {
        errors.push({ line, seq: e.seq, expectedSeq, code: 'SEQ_GAP',
          message: `序号不连续：第 ${line} 行 seq=${e.seq}，期望 ${expectedSeq}` });
      }
      if (e.prevHash !== expectedPrev) {
        errors.push({ line, seq: e.seq, code: 'PREV_HASH_MISMATCH',
          message: `第 ${line} 行（seq=${e.seq}）prevHash 与前一条记录不衔接，账本可能被截断或篡改` });
      }
      const { hash, ...body } = e;
      const recomputed = sha256(canonical(body));
      if (typeof hash !== 'string' || hash !== recomputed) {
        errors.push({ line, seq: e.seq ?? null, code: 'HASH_MISMATCH',
          message: `第 ${line} 行（seq=${e.seq ?? '?'}）内容哈希不匹配，记录可能被篡改` });
      }
      expectedPrev = typeof hash === 'string' ? hash : recomputed;
      expectedSeq = e.seq + 1;
    });

    return {
      ok: errors.length === 0,
      source: this.auditFile ? 'file' : 'memory',
      auditFile: this.auditFile,
      entriesChecked: entries.length,
      headSeq: entries.length ? entries[entries.length - 1].seq ?? null : 0,
      headHash: entries.length ? entries[entries.length - 1].hash || null : null,
      involvedEvents: [...involvedEvents].sort(),
      errors,
      verifiedAt: nowIso(),
    };
  }

  /** 需要链可信才能继续的操作入口 */
  _requireVerifiedChain() {
    const report = this.verifyChain();
    if (!report.ok) {
      throw new HttpError(409, 'CHAIN_VALIDATION_FAILED',
        `账本哈希链校验失败（${report.errors.length} 处），拒绝回放以避免基于不可信数据下结论`,
        { chain: report });
    }
    return report;
  }

  /* ================= 截面解析 ================= */

  /**
   * 解析截面描述符：
   *   { seq: 42 } / { ts: '2026-...' } / { cut: 'HEAD' } / { cut: '42' }
   * HEAD → 事件时间线上最后一条记录。
   * 返回 { cut, seq, ts, entry, eventId }。
   */
  resolveCut(cutInput, { eventScoped = [], eventId = null } = {}) {
    const raw = this._cutToken(cutInput);
    const entries = eventScoped; // 已按 seq 排序、属于该事件的记录

    if (raw === 'HEAD') {
      if (!entries.length) throw new HttpError(404, 'SNAPSHOT_NOT_FOUND',
        `事件 ${eventId} 账本上尚无任何记录，截面 HEAD 不存在`, { eventId, cut: 'HEAD' });
      const entry = entries[entries.length - 1];
      return { cut: 'HEAD', seq: entry.seq, ts: entry.ts, entry };
    }

    // seq 形式
    if (/^\d+$/.test(raw)) {
      const seq = Number(raw);
      const entry = entries.find((e) => e.seq === seq);
      if (!entry) {
        const any = this._readLedger().find((e) => !e.__malformed && e.seq === seq);
        if (any && any.eventId && any.eventId !== eventId) {
          throw new HttpError(409, 'CROSS_EVENT_SELECTION',
            `截面 seq=${seq} 属于事件 ${any.eventId}，与所选事件 ${eventId} 不同；差异对比不允许跨事件选择`,
            { eventId, cut: raw, recordEventId: any.eventId });
        }
        if (any) {
          // 中性全局记录（如 OBJECT_CREATED，无 eventId）：允许作为“早于该事件一切活动”的截面
          return { cut: raw, seq, ts: any.ts, entry: any, neutral: true };
        }
        throw new HttpError(404, 'SNAPSHOT_NOT_FOUND',
          `账本上不存在 seq=${seq} 的截面`, { eventId, cut: raw });
      }
      return { cut: raw, seq, ts: entry.ts, entry };
    }

    // ISO 时间戳形式：取 ts <= 指定时间的最后一条事件记录
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) {
      throw new HttpError(400, 'VALIDATION',
        `截面格式无法识别: ${raw}（支持账本序号 / ISO 时间 / HEAD）`, { cut: raw });
    }
    let chosen = null;
    for (const e of entries) {
      if (Date.parse(e.ts) <= ms) chosen = e;
      else break;
    }
    if (!chosen) {
      throw new HttpError(404, 'SNAPSHOT_NOT_FOUND',
        `事件 ${eventId} 在 ${raw} 之前没有任何账本记录，截面不存在`, { eventId, cut: raw });
    }
    return { cut: raw, seq: chosen.seq, ts: chosen.ts, entry: chosen };
  }

  _cutToken(input) {
    if (input === undefined || input === null || input === '') {
      throw new HttpError(400, 'VALIDATION', '缺少截面参数（seq / ts / cut）');
    }
    if (typeof input === 'object') {
      if (input.seq !== undefined && input.seq !== null && input.seq !== '') return String(input.seq);
      if (input.ts) return input.ts;
      if (input.cut) return String(input.cut);
      throw new HttpError(400, 'VALIDATION', '截面描述符必须包含 seq / ts / cut 之一');
    }
    return String(input).trim();
  }

  /* ================= 时间线重建（只读重放） ================= */

  /** 事件存在性：账本是权威回放源；活动状态仅在账本尚无记录时给出友好报错 */
  _assertEventExists(eventId, existsInLedger) {
    if (!existsInLedger && !this.store?.state?.events?.has?.(eventId)) {
      throw new HttpError(404, 'NOT_FOUND', `会合事件不存在或账本中无任何记录: ${eventId}`);
    }
  }

  /**
   * 按事件从账本重建协同时间线。
   * 不读取活动状态，全部结论由追加记录重放得到。
   */
  timeline(eventId, { minRisk } = {}) {
    const report = this._requireVerifiedChain();
    const all = this._readLedger().filter((e) => !e.__malformed);
    this._assertEventExists(eventId, all.some((e) => e.eventId === eventId));

    const facts = [];
    const riskVersions = [];                 // 追加接受的风险版本
    const commitments = new Map();          // commitmentId -> 重放状态
    const messages = new Map();             // messageId -> 重放状态

    for (const e of all) {
      if (e.eventId !== eventId) continue;
      switch (e.kind) {
        case 'EVENT_VERSION_APPENDED': {
          riskVersions.push({
            seq: e.seq, at: e.ts, eventVersion: e.version,
            pc: e.pc, missDistanceKm: e.missKm, riskLevel: e.risk,
          });
          facts.push(this._fact(e, 'RISK',
            `风险版本 v${e.version} · ${e.risk} · Pc=${sci(e.pc)} · 脱靶 ${fmtKm(e.missKm)} km`));
          break;
        }
        case 'EVENT_VERSION_REJECTED':
          facts.push(this._fact(e, 'RISK', `迟到评估被拒绝（${e.reason}），风险历史不回退`));
          break;
        case 'COMMITMENT_CREATED': {
          // 同事件前一个 APPROVED 承诺在原子提交时被取代
          for (const c of commitments.values()) {
            if (c.status === 'APPROVED') c.status = 'SUPERSEDED';
          }
          commitments.set(e.commitmentId, {
            commitmentId: e.commitmentId, version: e.version, status: 'APPROVED',
            seq: e.seq, createdAt: e.ts, eventVersion: null,
            fuel: e.fuelFrozen || null, missionWindow: e.windowFrozen || null,
            coordHash: e.coordHash || null,
          });
          facts.push(this._fact(e, 'COMMITMENT',
            `承诺 v${e.version}（${e.commitmentId}）批准并冻结燃料/窗口/协同快照`));
          break;
        }
        case 'COMMITMENT_DISPATCHED': {
          const c = commitments.get(e.commitmentId);
          if (c) { c.status = 'DISPATCHED'; c.dispatchedSeq = e.seq; c.dispatchedAt = e.ts; }
          facts.push(this._fact(e, 'COMMITMENT',
            `承诺 v${e.version}（${e.commitmentId}）下达 —— 终态，不可撤销`));
          break;
        }
        case 'COMMITMENT_CANCELLED_BY_COUNTERPART': {
          const c = commitments.get(e.commitmentId);
          if (c) { c.status = 'CANCELLED'; c.cancelledSeq = e.seq; c.cancelledByMessage = e.messageId; }
          facts.push(this._fact(e, 'COMMITMENT',
            `承诺（${e.commitmentId}）被对方高版本消息 ${e.messageId} 撤销`));
          break;
        }
        case 'MESSAGE_RECEIVED': {
          messages.set(e.messageId, {
            messageId: e.messageId, direction: 'INBOUND', counterpartId: e.counterpartId,
            type: e.type, version: e.version, status: e.status, seq: e.seq, receivedAt: e.ts,
          });
          facts.push(this._fact(e, 'MESSAGE',
            `入站 ${e.type} v${e.version}（${e.messageId}）→ ${e.status}`));
          break;
        }
        case 'MESSAGE_SENT': {
          messages.set(e.messageId, {
            messageId: e.messageId, direction: 'OUTBOUND', counterpartId: e.counterpartId,
            type: e.type, version: e.version, status: 'SENT', seq: e.seq, receivedAt: e.ts,
          });
          facts.push(this._fact(e, 'MESSAGE',
            `出站 ${e.type} v${e.version}（${e.messageId}）→ SENT`));
          break;
        }
        case 'MESSAGE_REPLAY_DEDUPED':
          facts.push(this._fact(e, 'MESSAGE', `消息 ${e.messageId} 重放，幂等去重，零状态变更`));
          break;
        case 'CANCEL_REJECTED_DISPATCHED':
          facts.push(this._fact(e, 'MESSAGE',
            `CANCEL ${e.messageId} 被拒：DISPATCHED_IMMUTABLE（已下达机动不可撤销）`));
          break;
        case 'CANCEL_REJECTED_STALE':
          facts.push(this._fact(e, 'MESSAGE',
            `CANCEL ${e.messageId} 被拒：迟到低版本（v${e.version} ≤ 冻结 v${e.frozenCpVersion}）`));
          break;
        default:
          facts.push(this._fact(e, 'OTHER', e.kind));
      }
    }

    const cuts = facts.map((f) => ({ seq: f.seq, ts: f.ts, label: f.label }));
    const headSeq = facts.length ? facts[facts.length - 1].seq : null;

    let risks = riskVersions;
    if (minRisk) {
      const order = { GREEN: 0, YELLOW: 1, RED: 2 };
      risks = risks.filter((r) => order[r.riskLevel] >= order[minRisk]);
    }

    return {
      eventId,
      filters: { eventId, minRisk: minRisk || null },
      chain: { ok: report.ok, source: report.source, entriesChecked: report.entriesChecked,
        headSeq: report.headSeq, headHash: report.headHash, errors: report.errors,
        verifiedAt: report.verifiedAt },
      headSeq,
      cuts,
      timeline: facts,
      reconstructed: {
        riskVersions: risks,
        currentRisk: riskVersions.length ? riskVersions[riskVersions.length - 1] : null,
        commitments: [...commitments.values()].sort((a, b) => a.seq - b.seq),
        messages: [...messages.values()].sort((a, b) => a.seq - b.seq),
      },
      generatedAt: nowIso(),
      readOnly: true,
    };
  }

  _fact(e, category, label) {
    return { seq: e.seq, ts: e.ts, kind: e.kind, category, label, eventId: e.eventId || null };
  }

  /* ================= 截面差异 ================= */

  /**
   * 两个截面对比。from 必须早于或等于 to；自动按账本顺序归正并标记 swapped。
   */
  diff(eventId, fromInput, toInput, { minRisk } = {}) {
    const chain = this._requireVerifiedChain();
    const scoped = this._readLedger()
      .filter((e) => !e.__malformed && e.eventId === eventId)
      .sort((a, b) => a.seq - b.seq);
    this._assertEventExists(eventId, scoped.length > 0);

    let from = this.resolveCut(fromInput, { eventScoped: scoped, eventId });
    let to = this.resolveCut(toInput, { eventScoped: scoped, eventId });
    let swapped = false;
    if (from.seq === to.seq) {
      throw new HttpError(400, 'IDENTICAL_CUT',
        '两个截面指向账本同一位置（seq=' + from.seq + '），无差异可比较',
        { eventId, seq: from.seq });
    }
    if (from.seq > to.seq) { [from, to] = [to, from]; swapped = true; }

    // 跨事件选择防护：截面锚定记录分属不同事件
    if (from.entry.eventId && to.entry.eventId && from.entry.eventId !== to.entry.eventId) {
      throw new HttpError(409, 'CROSS_EVENT_SELECTION',
        `截面分属不同事件：${from.entry.eventId} 与 ${to.entry.eventId}，差异对比必须限定在同一协同事件内`,
        { fromEventId: from.entry.eventId, toEventId: to.entry.eventId });
    }

    const a = this._materialize(scoped, from.seq);
    const b = this._materialize(scoped, to.seq);

    return {
      eventId,
      filters: { eventId, minRisk: minRisk || null },
      chain: { ok: true, source: chain.source, entriesChecked: chain.entriesChecked,
        headSeq: chain.headSeq, headHash: chain.headHash, verifiedAt: chain.verifiedAt },
      from: { cut: from.cut, seq: from.seq, ts: from.ts },
      to: { cut: to.cut, seq: to.seq, ts: to.ts },
      orderSwapped: swapped,
      risk: this._diffRisk(a.risk, b.risk),
      commitments: this._diffMap(a.commitments, b.commitments, 'commitmentId'),
      messages: this._diffMap(a.messages, b.messages, 'messageId'),
      generatedAt: nowIso(),
      readOnly: true,
    };
  }

  /** 重放某事件中 seq ≤ cutSeq 的全部记录，得到该截面的物化状态 */
  _materialize(scoped, cutSeq) {
    const commitments = new Map();
    const messages = new Map();
    let risk = null;

    for (const e of scoped) {
      if (e.seq > cutSeq) break;
      switch (e.kind) {
        case 'EVENT_VERSION_APPENDED':
          risk = {
            seq: e.seq, at: e.ts, eventVersion: e.version,
            pc: e.pc, missDistanceKm: e.missKm, riskLevel: e.risk,
          };
          break;
        case 'COMMITMENT_CREATED':
          for (const c of commitments.values()) if (c.status === 'APPROVED') c.status = 'SUPERSEDED';
          commitments.set(e.commitmentId, {
            commitmentId: e.commitmentId, version: e.version, status: 'APPROVED',
            at: e.ts, requiredFuelKg: e.fuelFrozen?.requiredKg ?? null,
            counterpartPlanVersion: null, coordHash: e.coordHash || null,
          });
          break;
        case 'COMMITMENT_DISPATCHED': {
          const c = commitments.get(e.commitmentId);
          if (c) { c.status = 'DISPATCHED'; c.dispatchedAt = e.ts; }
          break;
        }
        case 'COMMITMENT_CANCELLED_BY_COUNTERPART': {
          const c = commitments.get(e.commitmentId);
          if (c) { c.status = 'CANCELLED'; c.cancelledByMessage = e.messageId; }
          break;
        }
        case 'MESSAGE_RECEIVED':
          messages.set(e.messageId, {
            messageId: e.messageId, direction: 'INBOUND', counterpartId: e.counterpartId,
            type: e.type, version: e.version, status: e.status, at: e.ts,
          });
          break;
        case 'MESSAGE_SENT':
          messages.set(e.messageId, {
            messageId: e.messageId, direction: 'OUTBOUND', counterpartId: e.counterpartId,
            type: e.type, version: e.version, status: 'SENT', at: e.ts,
          });
          break;
        default:
          break;
      }
    }
    return { risk, commitments, messages };
  }

  _diffRisk(a, b) {
    if (!a && !b) return { changed: false, from: null, to: null, fields: [] };
    const fields = [];
    if (a && b) {
      for (const [field, fv, tv] of [
        ['eventVersion', a.eventVersion, b.eventVersion],
        ['riskLevel', a.riskLevel, b.riskLevel],
        ['pc', a.pc, b.pc],
        ['missDistanceKm', a.missDistanceKm, b.missDistanceKm],
      ]) {
        if (JSON.stringify(fv) !== JSON.stringify(tv)) fields.push({ field, from: fv, to: tv });
      }
    }
    // 一侧无风险记录（截面早于首次评估）本身就是变化（风险出现/消失）
    return { changed: true, appeared: !a, disappeared: !b, from: a, to: b, fields };
  }

  _diffMap(a, b, keyName) {
    const added = [], removed = [], changed = [];
    for (const [k, bv] of b.entries()) {
      const av = a.get(k);
      if (!av) added.push(bv);
      else {
        const fields = [];
        for (const field of new Set([...Object.keys(av), ...Object.keys(bv)])) {
          if (JSON.stringify(av[field]) !== JSON.stringify(bv[field])) {
            fields.push({ field, from: av[field] ?? null, to: bv[field] ?? null });
          }
        }
        if (fields.length) changed.push({ [keyName]: k, fields, before: av, after: bv });
      }
    }
    for (const [k, av] of a.entries()) if (!b.has(k)) removed.push(av);
    return {
      added: added.sort((x, y) => (x.at || '').localeCompare(y.at || '')),
      removed,
      changed: changed.sort((x, y) => (x.after.at || '').localeCompare(y.after.at || '')),
      counts: {
        from: a.size, to: b.size,
        added: added.length, removed: removed.length, changed: changed.length,
      },
    };
  }

  /* ================= 导出（只读，不落盘） ================= */

  exportDiff(eventId, fromInput, toInput, format = 'json', { minRisk } = {}) {
    const fmt = (format || 'json').toLowerCase();
    if (!['json', 'csv'].includes(fmt)) {
      throw new HttpError(415, 'UNSUPPORTED_FORMAT',
        `不支持的导出格式: ${format}（仅支持 json / csv）`, { format, supported: ['json', 'csv'] });
    }
    const diff = this.diff(eventId, fromInput, toInput, { minRisk });
    if (fmt === 'json') {
      return { format: 'json', filename: `replay-diff-${eventId}-${diff.from.seq}-${diff.to.seq}.json`, body: diff };
    }
    return { format: 'csv', filename: `replay-diff-${eventId}-${diff.from.seq}-${diff.to.seq}.csv`,
      body: this._diffToCsv(diff) };
  }

  _diffToCsv(d) {
    const rows = [];
    rows.push(['# section', 'change', 'id', 'field', 'from', 'to', 'detail']);
    rows.push(['META', 'EVENT', d.eventId, 'range',
      `seq ${d.from.seq}@${d.from.ts}`, `seq ${d.to.seq}@${d.to.ts}`,
      `orderSwapped=${d.orderSwapped}; chain=${d.chain.source}:${d.chain.headSeq}`]);

    const r = d.risk;
    if (r.from || r.to) {
      if (r.appeared) rows.push(['RISK', 'ADDED', `EVENTv${r.to.eventVersion}`, 'risk', '', JSON.stringify(r.to), '']);
      else if (r.disappeared) rows.push(['RISK', 'REMOVED', `EVENTv${r.from.eventVersion}`, 'risk', JSON.stringify(r.from), '', '']);
      for (const f of r.fields) rows.push(['RISK', 'CHANGED', `EVENTv${r.to.eventVersion}`, f.field, str(f.from), str(f.to), '']);
    }

    for (const c of d.commitments.added)
      rows.push(['COMMITMENT', 'ADDED', c.commitmentId, `v${c.version} ${c.status}`, '', c.at, `fuel=${c.requiredFuelKg}kg;hash=${(c.coordHash || '').slice(0, 16)}`]);
    for (const c of d.commitments.removed)
      rows.push(['COMMITMENT', 'REMOVED', c.commitmentId, `v${c.version} ${c.status}`, c.at, '', '']);
    for (const c of d.commitments.changed)
      for (const f of c.fields)
        rows.push(['COMMITMENT', 'CHANGED', c.commitmentId, f.field, str(f.from), str(f.to), `v${c.after.version}`]);

    for (const m of d.messages.added)
      rows.push(['MESSAGE', 'ADDED', m.messageId, `${m.direction} ${m.type} v${m.version}`, '', `${m.status}@${m.at}`, m.counterpartId || '']);
    for (const m of d.messages.removed)
      rows.push(['MESSAGE', 'REMOVED', m.messageId, `${m.direction} ${m.type} v${m.version}`, `${m.status}@${m.at}`, '', m.counterpartId || '']);
    for (const m of d.messages.changed)
      for (const f of m.fields)
        rows.push(['MESSAGE', 'CHANGED', m.messageId, f.field, str(f.from), str(f.to), '']);

    return toCsv(rows);
  }
}

const sci = (x) => (typeof x === 'number' ? (x === 0 ? '0' : x.toExponential(2)) : '-');
const fmtKm = (x) => (typeof x === 'number' ? x.toFixed(3) : '-');
const str = (v) => (v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
