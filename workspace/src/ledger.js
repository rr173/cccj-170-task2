import { sha256, canonical } from './util.js';

/**
 * 追加账本（append-only ledger）原语：
 *  - 每条审计条目封印时记录 seq / prevHash / hash，形成 SHA-256 哈希链
 *  - 链上任何删除、篡改、重排、跳号都可被 verifyChain 识别
 *  - 账本只允许追加；回放服务只读取、折叠，不写入任何线上状态
 *
 * 兼容：功能上线前产生的旧条目没有 seq/hash，它们只允许作为链首的
 * “未封印前缀”存在，其折叠摘要作为后续封印条目的 prevHash（旧根），
 * 校验时明确披露 legacy 前缀（内容可读但不可密码学验真）。
 */

export const GENESIS_HASH = 'GENESIS';

/** 计算条目自身哈希（不含 hash 字段本身） */
export function hashEntry(entry) {
  const { hash, ...rest } = entry;
  return sha256(canonical(rest));
}

/**
 * 封印一条新审计条目：链入哈希链。
 * @param {object} entry 不含 seq/prevHash/hash 的审计条目
 * @param {number} seq   本封印序号（从 1 开始，严格连续）
 * @param {string} prevHash 上一封印条目的 hash；链首为旧根或 GENESIS
 */
export function sealEntry(entry, seq, prevHash) {
  const sealed = { ...entry, seq, prevHash };
  sealed.hash = hashEntry(sealed);
  return sealed;
}

/** 旧条目（无 hash）前缀的虚拟折叠根：与封印条目同一迭代规则 */
export function computeLegacyRoot(entries, fromHash = GENESIS_HASH) {
  let h = fromHash;
  for (const e of entries) h = sha256(h + canonical(stripSeal(e)));
  return h;
}

function stripSeal(entry) {
  const { hash, seq, prevHash, ...rest } = entry;
  return rest;
}

/**
 * 校验哈希链。
 * @returns {{ok:boolean,status:string,headSeq:number,headHash:string,
 *   total:number,sealedCount:number,legacyCount:number,
 *   legacyRootHash:string,errors:Array}}
 * status: VALID（全链封印且一致）/ VERIFIED_WITH_LEGACY_PREFIX（存在未封印旧前缀）/ INVALID
 */
export function verifyChain(entries, { malformedLines = 0 } = {}) {
  const errors = [];
  let legacyCount = 0;
  let sealedCount = 0;
  let prevHash = GENESIS_HASH;
  let expectSeq = 1;
  let seenSealed = false;

  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object' || typeof e.kind !== 'string' || typeof e.ts !== 'string') {
      errors.push({ index: i, seq: null, code: 'MALFORMED_ENTRY', message: `第 ${i + 1} 条账本记录结构损坏` });
      return;
    }
    const sealed = typeof e.hash === 'string';
    if (!sealed) {
      if (seenSealed) {
        errors.push({ index: i, seq: null, code: 'LEGACY_AFTER_SEALED', message: `第 ${i + 1} 条未封印旧记录出现在封印记录之后（追加顺序被破坏）` });
      }
      legacyCount++;
      prevHash = sha256(prevHash + canonical(stripSeal(e)));
      return;
    }
    seenSealed = true;
    if (e.seq !== expectSeq) {
      errors.push({ index: i, seq: e.seq, code: 'SEQ_GAP',
        message: `封印序号不连续：期望 ${expectSeq}，实际 ${e.seq}（账本可能缺失记录）`,
        expectedSeq: expectSeq, gotSeq: e.seq });
    }
    if (e.prevHash !== prevHash) {
      errors.push({ index: i, seq: e.seq, code: 'PREV_HASH_MISMATCH',
        message: `条目 ${e.seq} 的前链哈希不匹配（前序记录被篡改或重排）`, expected: prevHash, got: e.prevHash });
    }
    if (e.hash !== hashEntry(e)) {
      errors.push({ index: i, seq: e.seq, code: 'HASH_MISMATCH',
        message: `条目 ${e.seq} 内容哈希不匹配（记录内容被篡改）`, expected: hashEntry(e), got: e.hash });
    }
    sealedCount++;
    expectSeq = e.seq + 1;
    prevHash = e.hash;
  });

  for (let i = 0; i < malformedLines; i++) {
    errors.push({ index: null, seq: null, code: 'MALFORMED_AUDIT_LINE', message: '审计日志文件存在无法解析的损坏行' });
  }

  const legacyRootHash = legacyCount ? computeLegacyRoot(entries.filter((e) => e && typeof e.hash !== 'string')) : GENESIS_HASH;
  const ok = errors.length === 0;
  return {
    ok,
    status: !ok ? 'INVALID' : legacyCount ? 'VERIFIED_WITH_LEGACY_PREFIX' : 'VALID',
    total: entries.length,
    sealedCount,
    legacyCount,
    headSeq: sealedCount,
    headHash: prevHash,
    legacyRootHash,
    errors,
    checkedAt: new Date().toISOString(),
  };
}
