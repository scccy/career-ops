#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import {
  BOSS_CITY_CODES,
  CANDIDATES_PATH,
  QUEUE_PATH,
  includesAny,
  list,
  loadProfile,
  loadSentPlacementKeys,
  loadSentKeys,
  parseArgs,
  salaryScore,
  todayIso,
  uniqueCompanyKey,
  uniqueCompanyPlacementKey,
  uniqueJobKey,
  uniqueJobKeyLegacy,
  writeJson,
  readJson,
  isCandidatesPath,
  loadCandidates,
  persistJobScores,
} from './boss-common.mjs';
import { loadBossControl } from './boss-config-db.mjs';
import { DEFAULT_RISK_KEYWORDS, matchRejectHits } from './skip-rules.mjs';

// 评分阈值统一来自数据库（控制台 boss_city_control）；DB 不可用时退化到 profile.yml 默认值。
const BOSS_CONTROL = await loadBossControl().catch(() => ({}));

// 评分阶段风险词（2026-10-14 统一到控制台）：DB boss_config.risk_keywords 为唯一来源，
// 缺省/DB 不可用时回落内置默认；这里按**纯子串**匹配（用户写什么就匹配什么，不必懂正则）。
const RISK_KEYWORDS = Array.isArray(BOSS_CONTROL.risk_keywords)
  ? BOSS_CONTROL.risk_keywords
  : DEFAULT_RISK_KEYWORDS;
const GENERIC_JD_PATTERNS = ['抗压能力强', '服从安排', '吃苦耐劳', '有梦想', '狼性'];
const VAGUE_SALARY_PATTERNS = ['薪资面议', '面议', '上不封顶', '底薪+提成', '底薪加提成'];
const UNREALISTIC_PATTERNS = ['月入', '躺赚', '轻松赚钱', '零经验', '小白', '无责高薪', '快速上手'];
const VAGUE_COMPANY_PATTERNS = ['某公司', '某科技', '某集团', '代招', '合作方'];
const JD_DETAIL_HEADINGS = /岗位职责|工作职责|职位描述|岗位描述|职责描述|任职要求|职位要求|岗位要求|工作内容/;
const JD_FOCUS_TERMS = [
  '合同管理', '合同审核', '合同审查', '法律文书', '法律事务', '公司法务',
  '数据合规', '隐私合规', '个人信息保护', '企业征信', '公共数据',
  '劳动仲裁', '劳动争议', '诉讼', '非诉',
  '风控', '风险控制', '反洗钱', '虚开发票',
  '尽职调查', '投融资', '股权架构', '股权激励', '董秘',
  '战略规划', '行业研究',
];
const RECENT_COMPANY_DEDUPE_DAYS = 30;

function clamp(n, min = 1, max = 5) {
  return Math.max(min, Math.min(max, Number(n.toFixed(2))));
}

function scoreByMatches(matchCount, total) {
  if (total <= 0) return 3;
  const ratio = matchCount / total;
  if (ratio >= 0.8) return 5;
  if (ratio >= 0.55) return 4;
  if (ratio >= 0.3) return 3;
  if (ratio > 0) return 2;
  return 1;
}

function scoreRoleMatches(matchCount, text) {
  if (matchCount >= 3) return 5;
  if (matchCount === 2) return 4.5;
  if (matchCount === 1) return 4;
  if (/法务|合规|风控|法律/.test(text)) return 3.5;
  return 2;
}

function scoreSkillMatches(matchCount) {
  if (matchCount >= 5) return 5;
  if (matchCount >= 3) return 4.5;
  if (matchCount >= 2) return 4;
  if (matchCount === 1) return 3;
  return 2;
}

export function evaluateJob(job, profile) {
  const targetRoles = list(profile?.target?.roles);
  const coreSkills = list(profile?.skills?.core);
  const reject = list(profile?.preferences?.reject);
  const targetCities = list(profile?.target?.cities);
  const weights = profile?.weights || {};

  const titleAndDesc = `${job.title || ''}\n${job.desc || job.description || ''}\n${list(job.tags).join(' ')}`;
  const rejectSplit = matchRejectHits({
    reject,
    cityWords: Object.keys(BOSS_CITY_CODES),
    titleAndDesc,
    city: job.city || job.location || '',
  });
  const jdCheck = checkDetailedJd(job);
  const roleHits = matchAliases(titleAndDesc, targetRoles, roleAliases);
  const skillHits = matchAliases(titleAndDesc, coreSkills, skillAliases);
  const responsibilityMatches = roleHits.length;
  const skillMatches = skillHits.length;

  const responsibility = scoreRoleMatches(responsibilityMatches, titleAndDesc);
  const skill = scoreSkillMatches(skillMatches);
  const salary = salaryScore(job.salary, profile?.target?.expected_salary, profile?.target?.minimum_salary);
  const city = targetCities.length === 0 || includesAny(job.city || job.location || '', targetCities) ? 5 : 2.5;
  const hrActivity = /周|月|年/.test(job.hr_active || '') ? 1.5
    : /刚刚|今日|今天|小时|分钟|活跃/.test(job.hr_active || '') ? 5
    : /日内|天内|3日|本周/.test(job.hr_active || '') ? 4
    : 3;

  const riskHits = [...new Set([
    ...RISK_KEYWORDS.filter((kw) => includesAny(titleAndDesc, [kw])),
    // preferences.reject 拆两类：城市名按岗位所在城市匹配，其余仍按标题+正文匹配
    // （2026-10-14 用户确认：之前「北京/深圳/广州」当正文词，误伤了提到这些城市的杭州岗位）
    ...rejectSplit.textHits,
    ...rejectSplit.cityHits,
  ])];
  const genericHits = GENERIC_JD_PATTERNS.filter((kw) => includesAny(titleAndDesc, [kw]));
  const legitimacy = assessOpportunityLegitimacy(job, jdCheck, genericHits, list(profile?.boss?.jd_focus_terms));
  const companyQuality = legitimacy.score;
  const salaryClear = hasClearSalary(job.salary);
  const riskPenalty = Math.min(1, (riskHits.length * 0.25) + (genericHits.length * 0.1));

  const dimensionWeights = {
    responsibility,
    skill,
    salary,
    city,
    companyQuality,
    hrActivity,
  };
  const weighted = [
    [responsibility, Number(weights.responsibility_match ?? 25)],
    [skill, Number(weights.skill_match ?? 25)],
    [salary, Number(weights.salary_match ?? 15)],
    [city, Number(weights.city_commute ?? 10)],
    [companyQuality, Number(weights.company_quality ?? 10)],
    [hrActivity, Number(weights.hr_activity ?? 10)],
  ];
  const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  const beforePenalty = weighted.reduce((sum, [score, weight]) => sum + score * weight, 0) / totalWeight;
  const total = clamp(beforePenalty - riskPenalty);

  // 2026-09-22 用户指令「只要带数据就投递，不管其他的」：移除内部 total>=4.0 硬门槛，
  // 分数线统一由 --threshold 参数控制（jdCheck/riskHits/可疑机会/面议 等保护性闸门保留）
  // 2026-10-14：JD 完整性闸门由 BOSS_REQUIRE_FULL_JD=true（控制台「JD完整性过滤」勾选）开启，
  // 默认关闭——JD 不完整的岗位也照常评分入队，jd_detail 继续如实记录原始判定供人工审阅。
  const requireFullJd = process.env.BOSS_REQUIRE_FULL_JD === 'true'
    || String(process.env.BOSS_REQUIRE_FULL_JD).toLowerCase() === 'true';
  const eligible = (!requireFullJd || jdCheck.ok) && riskHits.length === 0
    && job.can_chat !== false && job.already_contacted !== true
    && legitimacy.tier !== 'Suspicious' && salaryClear;
  const recommendation = requireFullJd && !jdCheck.ok ? `缺少完整JD，不能评分入队：${jdCheck.reason}`
    : legitimacy.tier === 'Suspicious' ? '机会可信度较低，不自动发送'
    : !salaryClear ? '薪资不明确，只记录不自动发送'
    : total >= 4.5 ? '强烈推荐，优先发送'
    : total >= 4 ? '推荐，进入批量发送'
    : total >= 3.5 ? '一般，只记录不自动发送'
    : '不建议投递';

  const greetingContext = buildGreetingContext(job, profile, titleAndDesc);

  return {
    ...job,
    score: total,
    score_detail: dimensionWeights,
    jd_detail: jdCheck,
    opportunity_legitimacy: legitimacy,
    risk_hits: riskHits,
    generic_hits: genericHits,
    risk_penalty: Number(riskPenalty.toFixed(2)),
    recommendation,
    eligible,
    greeting: buildGreeting(job, profile, { total, skillMatches, responsibilityMatches, greetingContext }),
    greeting_basis: greetingContext,
    scored_at: new Date().toISOString(),
  };
}

function checkDetailedJd(job) {
  const desc = String(job.desc || job.description || '').replace(/\s+/g, '');
  const hasResponsibility = /岗位职责|工作职责|职位描述|岗位描述|职责描述|工作内容/.test(desc);
  const hasRequirement = /任职要求|职位要求|岗位要求/.test(desc);
  if (desc.length < 80) {
    return { ok: false, reason: '岗位描述过短，疑似只读取了左侧岗位卡片' };
  }
  if (!JD_DETAIL_HEADINGS.test(desc)) {
    return { ok: false, reason: '未识别到岗位职责/任职要求等详情结构' };
  }
  if (desc.length < 120 && !(hasResponsibility && hasRequirement)) {
    return { ok: false, reason: '岗位描述偏短，且职责/要求结构不完整' };
  }
  return { ok: true, reason: '已包含右侧完整岗位详情' };
}

function assessOpportunityLegitimacy(job, jdCheck, genericHits = [], focusTerms = null) {
  const desc = String(job.desc || job.description || '');
  const compactDesc = desc.replace(/\s+/g, '');
  const text = `${job.company || ''}\n${job.title || ''}\n${desc}\n${list(job.tags).join(' ')}`;
  const salaryClear = hasClearSalary(job.salary);
  const hrRecent = /刚刚|今日|今天|小时|分钟|活跃/.test(job.hr_active || '');
  const signals = [];
  let score = 3;

  const addSignal = (signal, finding, weight) => {
    signals.push({ signal, finding, weight });
    score += weight;
  };

  if (jdCheck.ok) addSignal('JD 完整度', '已读取右侧完整岗位详情', 0.8);
  else addSignal('JD 完整度', jdCheck.reason || '缺少完整岗位详情', -1.2);

  if (compactDesc.length >= 260) addSignal('JD 信息量', '岗位描述较充分', 0.4);
  else if (compactDesc.length >= 120) addSignal('JD 信息量', '岗位描述基本完整', 0.2);
  else addSignal('JD 信息量', '岗位描述偏短，可能只读到岗位卡片或信息不足', -0.6);

  if (/岗位职责|工作职责|职位描述|岗位描述|职责描述/.test(compactDesc) && /任职要求|职位要求|岗位要求/.test(compactDesc)) {
    addSignal('JD 结构', '同时包含职责和要求，岗位边界较清楚', 0.4);
  } else if (JD_DETAIL_HEADINGS.test(compactDesc)) {
    addSignal('JD 结构', '有岗位详情结构，但职责/要求不够完整', 0.1);
  } else {
    addSignal('JD 结构', '缺少职责或任职要求结构', -0.4);
  }

  const focusHits = (focusTerms?.length ? focusTerms : JD_FOCUS_TERMS).filter((term) => includesAny(text, [term]));
  if (focusHits.length >= 3) addSignal('岗位具体度', `识别到具体业务/能力关键词：${focusHits.slice(0, 4).join('、')}`, 0.5);
  else if (focusHits.length > 0) addSignal('岗位具体度', `有少量具体关键词：${focusHits.join('、')}`, 0.2);
  else addSignal('岗位具体度', '未识别到明确业务、工具或专业关键词', -0.3);

  if (salaryClear) {
    addSignal('薪资透明度', `薪资区间明确：${job.salary}`, 0.3);
  } else {
    addSignal('薪资透明度', '薪资不明确或表达偏泛', -0.3);
  }

  if (/周|月|年/.test(job.hr_active || '')) addSignal('招聘活跃度', `HR 活跃时间偏久：${job.hr_active}`, -0.7);
  else if (/刚刚|今日|今天|小时|分钟|活跃/.test(job.hr_active || '')) addSignal('招聘活跃度', `HR 近期活跃：${job.hr_active}`, 0.5);
  else if (/日内|天内|3日|本周/.test(job.hr_active || '')) addSignal('招聘活跃度', `HR 仍在近期活跃：${job.hr_active}`, 0.2);
  else addSignal('招聘活跃度', 'HR 活跃时间不明确', 0);

  if (job.can_chat === false) addSignal('沟通入口', '未发现立即沟通入口', -1);
  else addSignal('沟通入口', '存在可沟通入口或未发现不可沟通信号', 0.2);

  if (job.already_contacted === true) addSignal('重复沟通', '该岗位已经沟通过', -1);
  if (genericHits.length) addSignal('JD 泛化信号', `出现模板化表达：${genericHits.join('、')}`, -Math.min(0.6, genericHits.length * 0.2));

  const vagueCompanyHits = VAGUE_COMPANY_PATTERNS.filter((kw) => includesAny(text, [kw]));
  if (vagueCompanyHits.length) addSignal('公司主体清晰度', `出现主体不清晰或代招信号：${vagueCompanyHits.join('、')}`, -0.5);

  const unrealisticHits = UNREALISTIC_PATTERNS.filter((kw) => includesAny(text, [kw]));
  if (unrealisticHits.length) addSignal('异常吸引信号', `出现偏营销化招聘表达：${unrealisticHits.join('、')}`, -0.5);

  if (Number(job.repost_count || job.scan_seen_count || 0) >= 3) {
    addSignal('重复发布', '该岗位在历史扫描中多次出现，疑似长期挂岗', -0.6);
  }

  const finalScore = clamp(score);
  const highConfidenceReady = jdCheck.ok && salaryClear && hrRecent && job.can_chat !== false;
  const tier = finalScore >= 4 && highConfidenceReady ? 'High Confidence'
    : finalScore >= 2.8 ? 'Proceed with Caution'
    : 'Suspicious';
  const label = tier === 'High Confidence' ? '高可信'
    : tier === 'Proceed with Caution' ? '谨慎推进'
    : '可疑机会';

  return {
    tier,
    label,
    score: finalScore,
    signals,
  };
}

function hasClearSalary(salary) {
  const text = String(salary || '');
  if (!text || !/\d/.test(text)) return false;
  return !includesAny(text, VAGUE_SALARY_PATTERNS);
}

function buildGreeting(job, profile, meta) {
  const style = profile?.boss?.greeting_style || '稳重专业';
  const context = meta?.greetingContext || buildGreetingContext(job, profile);
  const skills = context.skills.slice(0, 3).join('、') || list(profile?.skills?.core).slice(0, 3).join('、') || '相关岗位';
  const focus = context.jd_focus.slice(0, 2).join('、');
  const evidence = context.evidence.slice(0, 1)[0] || '';
  const current = profile?.candidate?.current_title || '相关岗位候选人';
  const target = list(profile?.target?.roles)[0] || job.title || '这个岗位';
  const base = `您好，我目前关注${target}机会，过往有${skills}相关经验，和这个岗位要求比较匹配。看了岗位描述比较感兴趣，方便的话想进一步沟通一下。`;
  if (style === '简洁直接') return `您好，我是${current}，有${skills}经验，想了解一下这个${job.title || '岗位'}机会，方便沟通吗？`;
  if (style === '偏岗位匹配') {
    return pickGreeting([
      focus && evidence ? `您好，我关注到岗位主要涉及${focus}。我过往做过${skills}，经历里也包括${evidence}，和岗位要求比较贴近，方便进一步沟通吗？` : '',
      focus ? `您好，我关注到岗位主要涉及${focus}。我过往做过${skills}，和这个${job.title || '岗位'}要求比较贴近，方便进一步沟通吗？` : '',
      `您好，我目前关注${target}方向机会。过往做过${skills}，和这个${job.title || '岗位'}要求比较贴近，方便进一步沟通吗？`,
    ]);
  }
  if (style === '积极主动') return `您好，我关注到这个${job.title || '岗位'}，我的${skills}经历和岗位要求比较贴合，也愿意进一步了解团队和职责，方便沟通一下吗？`;
  if (style === '偏技术细节') return `您好，我做过${skills}相关工作，看到岗位职责和我的经历匹配度较高，想进一步了解具体业务和团队要求，方便沟通吗？`;
  if (style === '偏业务价值') return `您好，我过往主要积累在${skills}方向，比较关注岗位能解决的实际业务问题。这个机会和我的经历较匹配，方便进一步沟通吗？`;
  return base;
}

function buildGreetingContext(job, profile, text = null) {
  const jdText = text || `${job.title || ''}\n${job.desc || job.description || ''}\n${list(job.tags).join(' ')}`;
  const focusTerms = list(profile?.boss?.jd_focus_terms);
  const jdFocus = (focusTerms.length ? focusTerms : JD_FOCUS_TERMS).filter((term) => includesAny(jdText, [term]));
  const skills = list(profile?.skills?.core)
    .filter((skill) => skillAliases(skill).some((kw) => includesAny(jdText, [kw]) || jdFocus.some((term) => includesAny(skill, [term]) || includesAny(term, [kw]))));
  const evidence = [...list(profile?.highlights?.projects), ...list(profile?.highlights?.experience)]
    .filter((item) => [...jdFocus, ...skills].some((kw) => includesAny(item, [kw]) || skillAliases(kw).some((alias) => includesAny(item, [alias]))))
    .map(cleanEvidence);
  return {
    jd_focus: unique(jdFocus).slice(0, 4),
    skills: unique(skills).slice(0, 4),
    evidence: unique(evidence).slice(0, 2),
  };
}

function matchAliases(text, values, aliasFn) {
  const matched = list(values).filter((value) => aliasFn(value).some((kw) => includesAny(text, [kw])));
  return unique(matched);
}

function roleAliases(role) {
  const value = String(role || '');
  const aliases = [value];
  if (/法务/.test(value)) aliases.push('法务', '法务经理', '法务主管', '法务专家', '法务BP', '公司法务', '企业法务', '法律事务');
  if (/合规/.test(value)) aliases.push('合规', '合规经理', '合规管理', '合规体系', '风险控制', '风控');
  if (/风控|风险/.test(value)) aliases.push('风控', '风险控制', '风险管理', '风控体系', '反舞弊', '内审');
  if (/主管|经理|负责人/.test(value)) aliases.push('经理', '主管', '专家', '负责人', 'BP');
  return unique(aliases.filter(Boolean));
}

function skillAliases(skill) {
  const value = String(skill || '');
  const aliases = [value];
  if (/合同/.test(value)) aliases.push('合同', '合同管理', '合同审核', '合同审查', '合同全流程');
  if (/法律文书|法律事务|企业法务|公司法务/.test(value)) aliases.push('法律文书', '法律事务', '企业法务', '公司法务');
  if (/个人信息|数据合规|隐私/.test(value)) aliases.push('个人信息', '个人信息保护', '数据合规', '隐私合规');
  if (/企业征信|公共数据|数据/.test(value)) aliases.push('企业征信', '公共数据', '数据运营', '数据采购');
  if (/劳动|诉讼|仲裁|非诉/.test(value)) aliases.push('劳动仲裁', '劳动争议', '诉讼', '非诉', '纠纷');
  if (/风控|风险|反洗钱|虚开发票/.test(value)) aliases.push('风控', '风险控制', '反洗钱', '虚开发票');
  if (/尽职调查|投资|股权|投融资|董秘/.test(value)) aliases.push('尽职调查', '投融资', '股权架构', '股权激励', '董秘');
  if (/战略|行业研究/.test(value)) aliases.push('战略规划', '行业研究', '战略研讨');
  return unique(aliases.filter(Boolean));
}

function cleanEvidence(text) {
  return String(text || '')
    .replace(/[。；;]\s*$/g, '')
    .slice(0, 42);
}

function trimGreeting(text) {
  const normalized = normalizeGreeting(text);
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 116)}。`;
}

function pickGreeting(candidates) {
  const cleaned = candidates.map(normalizeGreeting).filter(Boolean);
  return cleaned.find((item) => item.length <= 120) || cleaned[0] || '';
}

function normalizeGreeting(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/\s+([，。；、？])/g, '$1').trim();
}

function unique(items) {
  return [...new Set(list(items).map((item) => String(item).trim()).filter(Boolean))];
}

function formatLegitimacySignals(signals = []) {
  if (!signals.length) return '| - | 未生成机会可信度信号 | 0 |';
  return signals
    .map((item) => `| ${item.signal} | ${item.finding} | ${item.weight > 0 ? '+' : ''}${item.weight} |`)
    .join('\n');
}

function writeReport(job) {
  mkdirSync('reports', { recursive: true });
  const safeCompany = String(job.company || 'unknown').replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/g, '') || 'company';
  const safeTitle = String(job.title || 'job').replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/g, '') || 'job';
  const fingerprint = createHash('sha1')
    .update(`${job.url || ''}\n${job.company || ''}\n${job.title || ''}\n${job.desc || ''}`)
    .digest('hex')
    .slice(0, 8);
  const path = `reports/boss-${safeCompany}-${safeTitle}-${fingerprint}-${todayIso()}.md`;
  const rows = Object.entries(job.score_detail || {})
    .map(([k, v]) => `| ${k} | ${v}/5 |`)
    .join('\n');
  const jdStatus = job.jd_detail?.ok ? '已读取右侧完整 JD' : `未读取完整 JD：${job.jd_detail?.reason || '未知原因'}`;
  const legitimacy = job.opportunity_legitimacy || {};
  writeFileSync(path, `# BOSS 岗位评估：${job.company || ''} - ${job.title || ''}\n\n**Date:** ${todayIso()}\n**URL:** ${job.url || ''}\n**Score:** ${job.score}/5\n**Recommendation:** ${job.recommendation}\n\n## 岗位摘要\n\n- 公司：${job.company || ''}\n- 岗位：${job.title || ''}\n- 薪资：${job.salary || ''}\n- 城市：${job.city || job.location || ''}\n- HR 活跃：${job.hr_active || ''}\n\n## 分项评分\n\n| 维度 | 分数 |\n|---|---:|\n${rows}\n\n## 机会可信度\n\n- 结论：${legitimacy.label || legitimacy.tier || '未评估'}\n- 等级：${legitimacy.tier || '未评估'}\n- 分数：${legitimacy.score || '-'} / 5\n\n| 信号 | 发现 | 权重 |\n|---|---|---:|\n${formatLegitimacySignals(legitimacy.signals)}\n\n## 风险点\n\n${job.risk_hits?.length ? job.risk_hits.map((r) => `- ${r}`).join('\n') : '- 暂未识别硬性风险'}\n\n## JD 完整性\n\n- ${jdStatus}\n\n## 打招呼生成依据\n\n- JD 关注点：${job.greeting_basis?.jd_focus?.length ? job.greeting_basis.jd_focus.join('、') : '未识别到明确关键词'}\n- 画像匹配技能：${job.greeting_basis?.skills?.length ? job.greeting_basis.skills.join('、') : '使用默认核心技能'}\n- 画像匹配经历：${job.greeting_basis?.evidence?.length ? job.greeting_basis.evidence.join('；') : '未匹配到具体经历亮点'}\n\n## 推荐打招呼文案\n\n${job.greeting}\n`, 'utf-8');
  return path;
}

async function main() {
  const args = parseArgs();
  const input = args.input || CANDIDATES_PATH;
  const allowUnconfirmed = Boolean(args['allow-unconfirmed']);
  if (args.help) {
    console.log('Usage: node boss-score.mjs --input data/boss-candidates.json --threshold 4.0 [--dry-run]');
    return;
  }
  if (args['self-test']) {
    const profile = {
      profile: { confirmed: true },
      candidate: { current_title: '法务专员' },
      target: { roles: ['法务专员'], cities: ['北京'], expected_salary: '15-20K', minimum_salary: '13K' },
      skills: { core: ['合同审查', '合规支持'] },
      preferences: { reject: ['外包', '派遣'] },
      boss: { greeting_style: '稳重专业' },
    };
    const job = {
      company: '示例公司',
      title: '法务专员',
      salary: '15-20K',
      city: '北京',
      desc: '岗位职责：负责公司合同审查、合同管理、日常法律咨询和合规支持，协助处理诉讼仲裁材料，输出法律文书和风险提示；参与业务流程合规评估，协助建立合同模板和风险台账，定期向业务部门提供法律培训；跟进业务部门提出的合同履约、客户投诉和供应商合作风险，形成可执行的处理建议。任职要求：法学本科及以上学历，具备企业法务或律所经验，熟悉合同全流程管理，有较好的沟通协调和法律写作能力。',
      hr_active: '今日活跃',
      can_chat: true,
    };
    const scored = evaluateJob(job, profile);
    if (scored.score < 4 || !scored.eligible) throw new Error('self-test failed');
    console.log('boss-score self-test OK');
    return;
  }
  if (!isCandidatesPath(input) && !existsSync(input)) throw new Error(`input not found: ${input}`);
  const profile = loadProfile({ allowUnconfirmed });
  // 2026-09-23 用户确认：日常评分阈值标准 3.0，统一由 config/profile.yml boss.send_threshold 控制（--threshold 参数可临时覆盖）
  const threshold = Number(args.threshold ?? BOSS_CONTROL.send_threshold ?? profile?.boss?.send_threshold ?? 4.0);
  const sentJobs = loadSentKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS });
  const recentSentCompanies = loadSentPlacementKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS });
  const jobs = isCandidatesPath(input) ? await loadCandidates() : readJson(input, []);
  const scored = jobs.map((job) => {
    const result = evaluateJob(job, profile);
    // 评分规则的原始判定（发送日志 30 天去重覆盖前）——决定是否回写数据库
    result.db_eligible = Boolean(result.eligible);
    if (sentJobs.has(uniqueJobKey(result)) || sentJobs.has(uniqueJobKeyLegacy(result))) result.eligible = false;
    if (recentSentCompanies.has(uniqueCompanyPlacementKey(result))
      || recentSentCompanies.has(uniqueCompanyKey(result))) result.eligible = false;
    if (result.score < threshold) result.eligible = false;
    if (!args['dry-run']) result.report = writeReport(result);
    return result;
  });
  // 评分结果回写数据库：此前只写队列文件，boss_jobs.score 恒为 NULL，
  // 「发新扫/发送」按 score>=阈值 从库里筛就看不到新扫描岗位
  if (isCandidatesPath(input) && !args['dry-run']) {
    try {
      const updated = await persistJobScores(scored);
      console.error(`[boss-db] 评分已回写 boss_jobs：${updated} 条（其中可发送 ${scored.filter((j) => j.db_eligible).length} 条）`);
    } catch (err) {
      console.error(`[boss-db] 评分回写失败（不影响队列输出）: ${err.message}`);
    }
  }
  const seen = new Set();
  const queue = scored
    .filter((job) => job.eligible)
    .sort((a, b) => b.score - a.score)
    .filter((job) => {
      const key = uniqueCompanyPlacementKey(job);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!args['dry-run']) writeJson(QUEUE_PATH, queue);
  console.log(JSON.stringify({
    input,
    total: scored.length,
    queued: queue.length,
    threshold,
    dryRun: Boolean(args['dry-run']),
    output: args['dry-run'] ? null : QUEUE_PATH,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
