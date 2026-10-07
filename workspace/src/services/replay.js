import { nowIso, HttpError, toCsv, canonical, sha256 } from '../util.js';
import { verifyChain } from '../ledger.js';

/**
 * 只读审计回放服务（供值班人员使用）。
 *
 * 数据来源是追加账本（store.auditTrail，即 audit.log 的内存形态），
 * 不读取任何可变业务 Map 之外的内容，也绝不调用 store.audit/save/写文件——
 * 回放与导出对线上状态零写入。
 *
 * 提供：
 *  - verify()        哈希链校验（链失败 → CHAIN_INVALID）
 *  - timeline()      从账本折叠重建一条协同时间线 + 可选截面（截面）
 *  - diff()          选择两个历史截面，查看风险/承诺/消息差异
 *  - exportDiff()    差异导出（json / csv；其余格式 → UNSUPPORTED_FORMAT）
 */
export class ReplayService {
  constructor(store) {
    this.store = store;
  }

  /** 取账本条目（数组副本，纯读） */
  _entries() {
    return [...this.store.auditTrail];
  }

  /** 链校验；失败时抛出可识别错误（422 CHAIN_INVALID） */
  verify({ throwOnInvalid = true } = {}) {
    const result = verifyChain(this._entries(), {
      malformedLines: this.store.malformedAuditLines,
    });
    if (!result.ok && throwOnInvalid) {
      throw new HttpError(422, 'CHAIN_INVALID', '追加账本哈希链校验失败，回放结果不可信', {
        verification: result,
      });
    }
    return result;
  }

  /* ================= 折叠（fold）：账本 → 时间线 ================= */

  /**
   * 折叠全账本，产出每个事件的协同状态变迁。
   * 只折叠能归属于事件的账本记录；无 eventId 的记录（如 SOLUTION_*）不属于协同时间线。
   */
  _fold(entries) {
    const events = new Map();
    const ensure = (eventId) => {
      if (!events.has(eventId)) {
        events.set(eventId, {
          eventId,
          createdAt: null,
          createdSeq: null,
          riskVersions: [],      // EVENT_VERSION_APPENDED 顺序折叠
          commitments: new Map(),
          messages: new Map(),
          timeline: [],
          sections: [],
        });
      }
      return events.get(eventId);
    };

    // 旧条目（功能上线前未封印）按顺序赋予负的虚拟序号，保证排序/截断语义一致
    let legacyCursor = 0;
    const seqOf = (e) => (typeof e.seq === 'number' ? e.seq : --legacyCursor);

    for (const e of entries) {
      const d = e;
      const eventId = d.eventId;
      const seq = seqOf(d);
      switch (d.kind) {
        case 'EVENT_CREATED': {
          const ev = ensure(eventId);
          ev.createdAt = d.ts;
          ev.createdSeq = seq;
          ev.timeline.push({ seq, ts: d.ts, kind: d.kind, label: `事件创建 ${eventId}`, legacy: typeof d.seq !== 'number' });
          ev.sections.push(this._section(d, eventId, `事件创建`, seq));
          break;
        }
        case 'EVENT_VERSION_APPENDED': {
          const ev = ensure(eventId);
          const v = {
            version: d.version, pc: d.pc, missKm: d.missKm, riskLevel: d.risk,
            tca: d.tca, status: d.status ?? null, appendedAt: d.ts, seq,
          };
          ev.riskVersions.push(v);
          ev.timeline.push({
            seq, ts: d.ts, kind: d.kind,
            label: `事件 v${d.version} · ${d.risk} · Pc=${sci(d.pc)} · 脱靶 ${fmtKm(d.missKm)} km`,
            legacy: typeof d.seq !== 'number',
          });
          ev.sections.push(this._section(d, eventId, `风险 v${d.version}（${d.risk}）`, seq));
          break;
        }
        case 'COMMITMENT_CREATED': {
          const ev = ensure(eventId);
          const fuel = d.fuelFrozen || {};
          // 原子取代：同事件此前仍为 APPROVED 的承诺进入 SUPERSEDED（DISPATCHED/CANCELLED 不动）
          for (const prev of ev.commitments.values()) {
            if (prev.status === 'APPROVED') {
              prev.status = 'SUPERSEDED';
              prev.supersededSeq = seq;
              prev.supersededBy = d.commitmentId;
            }
          }
          ev.commitments.set(d.commitmentId, {
            id: d.commitmentId,
            eventId,
            version: d.version,
            status: 'APPROVED',
            requiredFuelKg: fuel.requiredKg ?? null,
            remainingAfterKg: fuel.remainingAfterKg ?? null,
            snapshotHash: d.coordHash ?? null,
            createdAt: d.ts,
            seq,
          });
          ev.timeline.push({
            seq, ts: d.ts, kind: d.kind,
            label: `承诺 ${d.commitmentId} v${d.version} 已批准 · 冻结燃料 ${fuel.requiredKg ?? '?'} kg · 协同快照 ${(d.coordHash || '').slice(0, 12)}…`,
            legacy: typeof d.seq !== 'number',
          });
          ev.sections.push(this._section(d, eventId, `承诺 v${d.version} 创建`, seq));
          break;
        }
        case 'COMMITMENT_DISPATCHED': {
          const ev = ensure(eventId);
          const c = ev.commitments.get(d.commitmentId);
          if (c) {
            c.status = 'DISPATCHED';
            c.dispatchedAt = d.ts;
            c.dispatchedSeq = seq;
          }
          ev.timeline.push({ seq, ts: d.ts, kind: d.kind, label: `承诺 ${d.commitmentId} v${d.version} 已下达（终态）`, legacy: typeof d.seq !== 'number' });
          ev.sections.push(this._section(d, eventId, `承诺 v${d.version} 下达`, seq));
          break;
        }
        case 'COMMITMENT_CANCELLED_BY_COUNTERPART': {
          const ev = ensure(eventId);
          const c = ev.commitments.get(d.commitmentId);
          if (c) {
            c.status = 'CANCELLED';
            c.cancelledAt = d.ts;
            c.cancelledSeq = seq;
            c.cancelledByMessage = d.messageId ?? null;
          }
          ev.timeline.push({ seq, ts: d.ts, kind: d.kind, label: `承诺 ${d.commitmentId} 被对方高版本 CANCEL 撤销（消息 ${d.messageId} v${d.version}）`, legacy: typeof d.seq !== 'number' });
          ev.sections.push(this._section(d, eventId, `承诺 ${d.commitmentId} 撤销`, seq));
          break;
        }
        case 'MESSAGE_RECEIVED': {
          const ev = ensure(eventId);
          ev.messages.set(d.messageId, {
            id: d.messageId,
            direction: 'INBOUND',
            type: d.type,
            version: d.version,
            status: d.status,
            eventId,
            at: d.ts,
            seq,
          });
          ev.timeline.push({
            seq, ts: d.ts, kind: d.kind,
            label: `⬅ 入站 ${d.type} v${d.version}（${d.status}）· ${d.messageId}`,
            legacy: typeof d.seq !== 'number',
          });
          ev.sections.push(this._section(d, eventId, `入站消息 v${d.version} ${d.type}`, seq));
          break;
        }
        case 'MESSAGE_SENT': {
          const ev = ensure(eventId);
          ev.messages.set(d.messageId, {
            id: d.messageId,
            direction: 'OUTBOUND',
            type: d.type,
            version: d.version,
            status: 'SENT',
            counterpartId: d.counterpartId ?? null,
            eventId,
            at: d.ts,
            seq,
          });
          ev.timeline.push({
            seq, ts: d.ts, kind: d.kind,
            label: `➡ 出站 ${d.type} v${d.version} · ${d.messageId}`,
            legacy: typeof d.seq !== 'number',
          });
          ev.sections.push(this._section(d, eventId, `出站消息 v${d.version} ${d.type}`, seq));
          break;
        }
        case 'CANCEL_REJECTED_DISPATCHED': {
          const ev = ensure(eventId);
          ev.timeline.push({ seq, ts: d.ts, kind: d.kind, label: `CANCEL v${d.version} 被拒绝：已下达机动不可撤销（DISPATCHED_IMMUTABLE）`, legacy: typeof d.seq !== 'number' });
          break;
        }
        case 'CANCEL_REJECTED_STALE': {
          const ev = ensure(eventId);
          ev.timeline.push({ seq, ts: d.ts, kind: d.kind, label: `迟到低版本 CANCEL v${d.version} 被拒绝（≤ 冻结版本 ${d.frozenCpVersion}）`, legacy: typeof d.seq !== 'number' });
          break;
        }
        default:
          // 其余审计种类（目标/轨道解/候选拒绝/去重等）不属于协同时间线
          break;
      }
    }
    return events;
  }

  _section(entry, eventId, label, seq) {
    return { seq, ts: entry.ts, eventId, kind: entry.kind, label, legacy: typeof entry.seq !== 'number' };
  }

  /* ================= 查询：时间线 + 截面 ================= */

  /**
   * 重建协同时间线。
   * @param {object} opts eventId（必填时限定单个事件）、at（截面选择器）
   */
  timeline({ eventId = null, at = null } = {}) {
    const verification = this.verify();
    const entries = this._entries();

    if (eventId) {
      // 事件必须在账本中出现过（EVENT_CREATED），否则是可识别的“不存在截面/事件”
      if (!entries.some((e) => e.kind === 'EVENT_CREATED' && e.eventId === eventId)) {
        throw new HttpError(404, 'EVENT_NOT_FOUND', `账本中不存在会合事件: ${eventId}`);
      }
    }

    const folded = this._fold(entries);
    const scope = eventId ? [eventId] : [...folded.keys()];
    const events = scope
      .map((id) => folded.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

    const globalSections = eventId
      ? events[0]?.sections ?? []
      : events.flatMap((ev) => ev.sections)
          .sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts));

    const timeline = eventId
      ? (events[0]?.timeline ?? [])
      : events.flatMap((ev) => ev.timeline).sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts));

    const response = {
      readOnly: true,
      generatedAt: nowIso(),
      filter: { eventId: eventId || null, at: at || null },
      verification,
      scope: eventId ? 'EVENT' : 'GLOBAL',
      sectionCount: globalSections.length,
      sections: globalSections,
      events: events.map((ev) => ({
        eventId: ev.eventId,
        createdAt: ev.createdAt,
        riskVersionCount: ev.riskVersions.length,
        commitmentCount: ev.commitments.size,
        messageCount: ev.messages.size,
      })),
      timeline,
    };

    if (at != null && at !== '') {
      const res = this._resolveSection(globalSections, at, eventId);
      response.snapshot = this._snapshotAt(folded, scope, res);
      response.at = this._selectorInfo(at, res);
    }
    return response;
  }

  /** 折叠截至某条账本序号（含）的风险/承诺/消息截面 */
  _snapshotAt(folded, scope, section) {
    const upto = section.seq;
    const eventSnapshots = scope.map((id) => {
      const ev = folded.get(id);
      const risks = ev.riskVersions.filter((v) => v.seq <= upto);
      const head = risks[risks.length - 1] || null;
      const commitments = [...ev.commitments.values()]
        .filter((c) => c.seq <= upto)
        .map((c) => this._commitmentAt(c, upto));
      const messages = [...ev.messages.values()]
        .filter((m) => m.seq <= upto)
        .map((m) => this._messageAt(m, upto))
        .sort((a, b) => a.seq - b.seq);
      return {
        eventId: ev.eventId,
        existed: ev.createdSeq != null && ev.createdSeq <= upto,
        risk: head ? {
          version: head.version,
          riskLevel: head.riskLevel,
          pc: head.pc,
          missDistanceKm: head.missKm,
          tca: head.tca,
          status: head.status,
        } : null,
        commitments,
        messages,
      };
    });
    return {
      at: { seq: section.seq, ts: section.ts, label: section.label, kind: section.kind },
      stateHash: this._stateHash(eventSnapshots),
      events: eventSnapshots,
    };
  }

  /** 截面处承诺状态：下达/撤销/取代发生在截面之后则仍为 APPROVED */
  _commitmentAt(c, upto) {
    let status = 'APPROVED';
    if (c.status === 'DISPATCHED' && (c.dispatchedSeq ?? Infinity) <= upto) status = 'DISPATCHED';
    else if (c.status === 'CANCELLED' && (c.cancelledSeq ?? Infinity) <= upto) status = 'CANCELLED';
    else if (c.status === 'SUPERSEDED' && (c.supersededSeq ?? Infinity) <= upto) status = 'SUPERSEDED';
    return {
      id: c.id,
      version: c.version,
      status,
      requiredFuelKg: c.requiredFuelKg,
      remainingAfterKg: c.remainingAfterKg,
      snapshotHash: c.snapshotHash,
      createdAt: c.createdAt,
    };
  }

  _messageAt(m, upto) {
    return {
      id: m.id, direction: m.direction, type: m.type, version: m.version,
      status: m.status, counterpartId: m.counterpartId ?? null, at: m.at, seq: m.seq,
    };
  }

  _stateHash(eventSnapshots) {
    const compact = eventSnapshots.map((e) => ({
      eventId: e.eventId,
      risk: e.risk && { v: e.risk.version, level: e.risk.riskLevel, pc: e.risk.pc },
      commitments: e.commitments.map((c) => [c.id, c.version, c.status]),
      messages: e.messages.map((m) => [m.id, m.version, m.status]),
    }));
    return sha256(canonical(compact));
  }

  /* ================= 截面选择器 ================= */

  /**
   * 解析截面选择器：
   *  - 纯数字 n           → 封印账本序号 seq=n（必须存在且落在范围内）
   *  - latest / head      → 最新截面
   *  - genesis / earliest → 最早截面
   *  - event:v<n>（单事件范围）→ 该事件第 n 个风险版本
   */
  _resolveSection(sections, selector, eventIdScope = null) {
    if (!sections.length) throw new HttpError(409, 'NO_SECTIONS', '账本中尚无可重建的协同截面（无已创建事件）');
    const s = String(selector).trim();
    const bySeq = (seq) => sections.find((x) => x.seq === seq);

    if (/^\d+$/.test(s)) {
      const seq = Number(s);
      const hit = bySeq(seq);
      if (!hit) {
        throw new HttpError(404, 'SECTION_NOT_FOUND',
          `账本中不存在序号为 ${seq} 的截面（当前有效封印序号 1…${sections[sections.length - 1].seq}）`,
          { requestedSeq: seq, maxSeq: sections[sections.length - 1].seq });
      }
      return hit;
    }
    const low = s.toLowerCase();
    if (low === 'latest' || low === 'head') return sections[sections.length - 1];
    if (low === 'genesis' || low === 'earliest' || low === 'first') return sections[0];
    if (eventIdScope && /^v\d+$/i.test(low)) {
      const n = Number(low.slice(1));
      const riskSections = sections.filter((x) => x.kind === 'EVENT_VERSION_APPENDED');
      const target = riskSections[n - 1];
      if (!target) {
        throw new HttpError(404, 'SECTION_NOT_FOUND',
          `事件 ${eventIdScope} 不存在风险版本 v${n}（当前 1…${riskSections.length}）`);
      }
      return target;
    }
    if (eventIdScope && /^event:v\d+$/i.test(low)) {
      return this._resolveSection(sections, low.slice(6), eventIdScope);
    }
    throw new HttpError(404, 'SECTION_NOT_FOUND',
      `无法识别的截面选择器: ${selector}（支持：账本序号 / latest / genesis / v<n>）`,
      { selector });
  }

  _selectorInfo(selector, section) {
    return { selector: String(selector), seq: section.seq, ts: section.ts, label: section.label };
  }

  /* ================= 双截面差异 ================= */

  diff({ eventId = null, from, to } = {}) {
    if (from == null || from === '' || to == null || to === '') {
      throw new HttpError(400, 'VALIDATION', '必须提供两个截面选择器 from 与 to');
    }
    const verification = this.verify();
    const entries = this._entries();

    if (eventId && !entries.some((e) => e.kind === 'EVENT_CREATED' && e.eventId === eventId)) {
      throw new HttpError(404, 'EVENT_NOT_FOUND', `账本中不存在会合事件: ${eventId}`);
    }

    const folded = this._fold(entries);
    const scope = eventId ? [eventId] : [...folded.keys()];
    const allSections = scope
      .map((id) => folded.get(id))
      .filter(Boolean)
      .flatMap((ev) => ev.sections)
      .sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts));

    const a = this._resolveSection(allSections, from, eventId);
    const b = this._resolveSection(allSections, to, eventId);

    // 跨事件选择：两个截面不属于同一事件 → 可识别错误（单事件范围内由解析保证）
    if (!eventId && a.eventId !== b.eventId) {
      throw new HttpError(400, 'CROSS_EVENT_SELECTION',
        `跨事件截面比较被拒绝：${from} 属于 ${a.eventId}，${to} 属于 ${b.eventId}`,
        { from: { selector: String(from), eventId: a.eventId, seq: a.seq }, to: { selector: String(to), eventId: b.eventId, seq: b.seq } });
    }
    const scopeEventIds = eventId ? [eventId] : [a.eventId];

    const snapA = this._snapshotAt(folded, scopeEventIds, a);
    const snapB = this._snapshotAt(folded, scopeEventIds, b);

    return {
      readOnly: true,
      generatedAt: nowIso(),
      filter: { eventId: eventId || a.eventId, from: String(from), to: String(to) },
      verification,
      from: this._selectorInfo(from, a),
      to: this._selectorInfo(to, b),
      direction: a.seq <= b.seq ? 'FORWARD' : 'BACKWARD',
      eventId: eventId || a.eventId,
      differences: this._buildDifferences(snapA, snapB),
    };
  }

  _buildDifferences(snapA, snapB) {
    const ea = snapA.events[0];
    const eb = snapB.events[0];
    return {
      risk: this._riskDiff(ea?.risk ?? null, eb?.risk ?? null),
      commitments: this._collectionDiff(
        (ea?.commitments ?? []).map((c) => [c.id, c]),
        (eb?.commitments ?? []).map((c) => [c.id, c]),
        (c) => this._commitmentFingerprint(c),
        (c) => this._commitmentView(c),
      ),
      messages: this._collectionDiff(
        (ea?.messages ?? []).map((m) => [m.id, m]),
        (eb?.messages ?? []).map((m) => [m.id, m]),
        (m) => this._messageFingerprint(m),
        (m) => this._messageView(m),
      ),
    };
  }

  _riskDiff(a, b) {
    const fields = [];
    const add = (field, label, x, y, changed) => fields.push({ field, label, from: x, to: y, changed });
    add('riskLevel', '风险等级', a?.riskLevel ?? null, b?.riskLevel ?? null, a?.riskLevel !== b?.riskLevel);
    add('pc', '碰撞概率 Pc', a?.pc ?? null, b?.pc ?? null, (a?.pc ?? null) !== (b?.pc ?? null));
    add('missDistanceKm', '脱靶距离 (km)', a?.missDistanceKm ?? null, b?.missDistanceKm ?? null, (a?.missDistanceKm ?? null) !== (b?.missDistanceKm ?? null));
    add('status', '事件状态', a?.status ?? null, b?.status ?? null, a?.status !== b?.status);
    add('version', '风险版本', a?.version ?? 0, b?.version ?? 0, a?.version !== b?.version);
    return {
      changed: fields.some((f) => f.changed && f.field !== 'version') || a?.version !== b?.version,
      from: a,
      to: b,
      fields,
    };
  }

  _collectionDiff(pairsA, pairsB, fingerprint, view) {
    const ma = new Map(pairsA);
    const mb = new Map(pairsB);
    const added = [], removed = [], changed = [], unchanged = [];
    for (const [id, bv] of mb) {
      const av = ma.get(id);
      if (!av) added.push(view(bv));
      else if (canonical(fingerprint(av)) !== canonical(fingerprint(bv))) {
        changed.push({ id, from: view(av), to: view(bv) });
      } else unchanged.push(view(bv));
    }
    for (const [id, av] of ma) if (!mb.has(id)) removed.push(view(av));
    return {
      changed: added.length + removed.length + changed.length > 0,
      addedCount: added.length,
      removedCount: removed.length,
      changedCount: changed.length,
      unchangedCount: unchanged.length,
      added, removed, changed, unchanged,
    };
  }

  _commitmentFingerprint(c) {
    return { version: c.version, status: c.status, fuel: c.requiredFuelKg };
  }
  _commitmentView(c) {
    return {
      id: c.id, version: c.version, status: c.status,
      requiredFuelKg: c.requiredFuelKg, remainingAfterKg: c.remainingAfterKg,
      snapshotHash: c.snapshotHash, createdAt: c.createdAt,
    };
  }
  _messageFingerprint(m) {
    return { version: m.version, status: m.status };
  }
  _messageView(m) {
    return {
      id: m.id, direction: m.direction, type: m.type, version: m.version,
      status: m.status, counterpartId: m.counterpartId, at: m.at,
    };
  }

  /* ================= 导出（只读，不落盘） ================= */

  /**
   * 导出差异。
   * @param format json | csv（其余 → 415 UNSUPPORTED_FORMAT）
   * @returns {{format, contentType, filename, body}}
   */
  exportDiff({ eventId = null, from, to, format = 'json' } = {}) {
    const result = this.diff({ eventId, from, to });
    if (format === 'json') {
      return {
        format: 'json',
        contentType: 'application/json; charset=utf-8',
        filename: `audit-diff-${result.eventId}-${safe(from)}-to-${safe(to)}.json`,
        body: JSON.stringify({ exportedAt: nowIso(), readOnly: true, ...result }, null, 2),
      };
    }
    if (format === 'csv') {
      return {
        format: 'csv',
        contentType: 'text/csv; charset=utf-8',
        filename: `audit-diff-${result.eventId}-${safe(from)}-to-${safe(to)}.csv`,
        body: this._diffToCsv(result),
      };
    }
    throw new HttpError(415, 'UNSUPPORTED_FORMAT',
      `不支持的导出格式: ${format}（仅支持 json / csv）`, { supportedFormats: ['json', 'csv'] });
  }

  _diffToCsv(r) {
    const rows = [[
      'category', 'change', 'id', 'field', 'fromValue', 'toValue',
      'eventId', 'fromSeq', 'toSeq', 'chainStatus',
    ]];
    const meta = [r.eventId, r.from.seq, r.to.seq, r.verification.status];
    const d = r.differences;
    // 风险字段
    for (const f of d.risk.fields) {
      rows.push(['RISK', f.changed ? 'CHANGED' : 'UNCHANGED', r.eventId, f.label,
        f.field === 'pc' ? sci(f.from) : csvVal(f.from, f.field),
        f.field === 'pc' ? sci(f.to) : csvVal(f.to, f.field), ...meta]);
    }
    // 承诺
    for (const c of d.commitments.added)
      rows.push(['COMMITMENT', 'ADDED', c.id, 'status', '', c.status, ...meta]);
    for (const c of d.commitments.removed)
      rows.push(['COMMITMENT', 'REMOVED', c.id, 'status', c.status, '', ...meta]);
    for (const c of d.commitments.changed) {
      rows.push(['COMMITMENT', 'CHANGED', c.id, 'status', c.from.status, c.to.status, ...meta]);
      if (c.from.requiredFuelKg !== c.to.requiredFuelKg) {
        rows.push(['COMMITMENT', 'CHANGED', c.id, 'requiredFuelKg', c.from.requiredFuelKg, c.to.requiredFuelKg, ...meta]);
      }
    }
    // 消息
    for (const m of d.messages.added)
      rows.push(['MESSAGE', 'ADDED', m.id, m.type, '', `${m.direction} v${m.version} ${m.status}`, ...meta]);
    for (const m of d.messages.removed)
      rows.push(['MESSAGE', 'REMOVED', m.id, m.type, `${m.direction} v${m.version} ${m.status}`, '', ...meta]);
    for (const m of d.messages.changed)
      rows.push(['MESSAGE', 'CHANGED', m.id, 'status', m.from.status, m.to.status, ...meta]);
    return toCsv(rows);
  }
}

/* ---------- 小工具 ---------- */
function sci(x) {
  if (x == null || Number.isNaN(x)) return '';
  return typeof x === 'number' ? x.toExponential(2) : String(x);
}
function fmtKm(x) {
  return typeof x === 'number' ? x.toFixed(3) : (x ?? '?');
}
function csvVal(v, field) {
  if (v == null) return '';
  if (field === 'missDistanceKm') return typeof v === 'number' ? v.toFixed(3) : String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function scalar(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function safe(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}
