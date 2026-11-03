#!/usr/bin/env node
// rekey-job-identity.mjs — 把 boss_jobs.key_hash 重算为新的岗位身份
//   新键 = 岗位名称 :: 公司 :: base城市（2026-10 用户要求，不再含 URL 指纹）
// 同时同步 boss_queue（列 key_hash + payload.key_hash）。
//
// 用法：
//   node boss/rekey-job-identity.mjs --dry-run    # 只看会改多少、是否有冲突
//   node boss/rekey-job-identity.mjs              # 执行（无冲突时）
//   node boss/rekey-job-identity.mjs --merge      # 若新键出现重复，保留最优行、删除其余后重算
//
// 幂等：已经是新键的行不会再改。
import { query, getConnection, closePool } from './pg-db.mjs';
import { ensureSchema } from './pg-schema.mjs';
import { candidateKeyHash, uniqueJobKey } from './boss-common.mjs';

const DRY = process.argv.includes('--dry-run');
const MERGE = process.argv.includes('--merge');

function keyOf(row) {
  return uniqueJobKey({ company: row.company, title: row.title, city: row.city, url: row.url });
}
function hashOf(row) {
  return candidateKeyHash({ company: row.company, title: row.title, city: row.city, url: row.url });
}

async function main() {
  await ensureSchema();
  const [rows] = await query('SELECT id, key_hash, company, title, city, url, greeted, score, status, availability, manual_excluded, contact_state, scanned_at FROM boss_jobs ORDER BY id');

  // 1) 分组检测新键冲突
  const groups = new Map();
  for (const r of rows) {
    const h = hashOf(r);
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(r);
  }
  const dupGroups = [...groups.values()].filter((v) => v.length > 1);
  console.log(JSON.stringify({ rows: rows.length, uniqueNewKeys: groups.size, duplicateGroups: dupGroups.length, merge: MERGE, dryRun: DRY }, null, 2));

  if (dupGroups.length && !MERGE && !DRY) {
    console.error(`[rekey] 新键出现 ${dupGroups.length} 组重复，未执行。用 --merge 保留最优行后重算，或先人工核对：`);
    for (const g of dupGroups.slice(0, 10)) {
      console.error('  - ' + g.map((x) => `#${x.id} ${x.company}/${x.title}/${x.city}`).join(' | '));
    }
    process.exitCode = 2;
    return;
  }
  if (dupGroups.length && DRY) {
    console.log('[rekey] dry-run：存在重复组，正式执行需加 --merge');
    return;
  }

  // 2) 合并重复组（保留最优行，删除其余）
  const deleteIds = [];
  if (dupGroups.length && MERGE && !DRY) {
    for (const g of dupGroups) {
      const rank = (x) => [Number(x.greeted || 0), x.score == null ? -1 : Number(x.score), new Date(x.scanned_at || 0).getTime()];
      const sorted = g.slice().sort((a, b) => {
        const ra = rank(a); const rb = rank(b);
        for (let i = 0; i < ra.length; i++) { if (rb[i] !== ra[i]) return rb[i] - ra[i]; }
        return b.id - a.id;
      });
      const keep = sorted[0];
      const rest = sorted.slice(1);
      const anyGreeted = g.some((x) => Number(x.greeted) === 1);
      const anyScore = g.map((x) => (x.score == null ? null : Number(x.score))).filter((v) => v != null);
      const anyOpen = g.some((x) => String(x.status || '') !== 'closed');
      await query(
        `UPDATE boss_jobs SET greeted = ?, score = ?, status = ?, availability = ?, manual_excluded = ? WHERE id = ?`,
        [
          anyGreeted ? 1 : 0,
          anyScore.length ? Math.max(...anyScore) : null,
          anyOpen ? '' : 'closed',
          anyOpen ? 'unknown' : 'closed',
          g.every((x) => Number(x.manual_excluded) === 1) ? 1 : 0,
          keep.id,
        ],
      );
      deleteIds.push(...rest.map((x) => x.id));
    }
    for (const id of deleteIds) await query('DELETE FROM boss_jobs WHERE id = ?', [id]);
    console.log(`[rekey] 已合并 ${dupGroups.length} 组，删除 ${deleteIds.length} 条重复行`);
  }

  // 3) 重算 key_hash（先临时值避免 UNIQUE 冲突）
  const [fresh] = await query('SELECT id, key_hash, company, title, city, url FROM boss_jobs ORDER BY id');
  const plan = [];
  for (const r of fresh) {
    const h = hashOf(r);
    if (h !== r.key_hash) plan.push({ id: r.id, hash: h });
  }
  console.log(`[rekey] 需要更新 key_hash 的行：${plan.length}`);
  if (!DRY && plan.length) {
    const conn = await getConnection();
    try {
      await conn.beginTransaction();
      for (const p of plan) {
        await conn.query('UPDATE boss_jobs SET key_hash = ? WHERE id = ?', [`tmp:${p.id}`.padEnd(64, '_'), p.id]);
      }
      for (const p of plan) {
        await conn.query('UPDATE boss_jobs SET key_hash = ? WHERE id = ?', [p.hash, p.id]);
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  // 4) 同步 boss_queue（列 + payload.key_hash）
  const [qrows] = await query('SELECT id, key_hash, payload FROM boss_queue');
  let qChanged = 0;
  for (const q of qrows) {
    const p = typeof q.payload === 'string' ? JSON.parse(q.payload) : q.payload;
    const h = hashOf(p);
    if (q.key_hash !== h || p.key_hash !== h) {
      qChanged++;
      if (!DRY) {
        p.key_hash = h;
        await query('UPDATE boss_queue SET key_hash = ?, payload = ? WHERE id = ?', [h, JSON.stringify(p), q.id]);
      }
    }
  }
  console.log(`[rekey] boss_queue 需同步行：${qChanged}`);

  const [cnt] = await query('SELECT COUNT(*)::int n FROM boss_jobs');
  console.log(JSON.stringify({ done: !DRY, boss_jobs: cnt[0].n, keyUpdated: plan.length, queueUpdated: qChanged }, null, 2));
}

main()
  .catch((err) => { console.error('[rekey] failed:', err.message); process.exitCode = 1; })
  .finally(closePool);
