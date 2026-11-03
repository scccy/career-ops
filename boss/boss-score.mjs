#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import {
  BOSS_CITY_CODES,
  CANDIDATES_PATH,
  includesAny,
  list,
  loadProfile,
  loadSentKeys,
  parseArgs,
  salaryScore,
  todayIso,
  uniqueCompanyPlacementKey,
  uniqueJobKey,
  urlPathname,
  readJson,
  isCandidatesPath,
  loadCandidates,
  persistJobScores,
  saveJobAnalysis,
  saveQueue,
} from './boss-common.mjs';
import { loadBossControl } from './boss-config-db.mjs';
import { DEFAULT_RISK_KEYWORDS, matchRejectHits } from './skip-rules.mjs';
import { withJobIdentity } from './boss-llm-schema.mjs';
import { selectSendableJobs, readSendHistory } from './boss-send-eligibility.mjs';
import {
  analyzeJobsChunked,
  selectLlmTargets,
  llmReadiness,
  resolveLlmConfig,
} from './boss-llm.mjs';

// 阈值/配额统一来自 PostgreSQL（boss_config.boss_city_control，唯一配置基准）；连库失败直接抛错，不回落 profile.yml。
const BOSS_CONTROL = await loadBossControl();

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
const RECENT_ROLE_DEDUPE_DAYS = 30;

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
  // 模板文案先算好：它既是 LLM 的兜底，也是 LLM 未启用时的最终文案（2026-10-30）。
  const templateGreeting = buildGreeting(job, profile, { total, skillMatches, responsibilityMatches, greetingContext });

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
    greeting: templateGreeting,
    greeting_template: templateGreeting,
    greeting_source: 'template',
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
  writeFileSync(path, `# BOSS 岗位评估：${job.company || ''} - ${job.title || ''}\n\n**Date:** ${todayIso()}\n**URL:** ${job.url || ''}\n**Score:** ${job.score}/5\n**Recommendation:** ${job.recommendation}\n\n## 岗位摘要\n\n- 公司：${job.company || ''}\n- 岗位：${job.title || ''}\n- 薪资：${job.salary || ''}\n- 城市：${job.city || job.location || ''}\n- HR 活跃：${job.hr_active || ''}\n\n## 分项评分\n\n| 维度 | 分数 |\n|---|---:|\n${rows}\n\n## 机会可信度\n\n- 结论：${legitimacy.label || legitimacy.tier || '未评估'}\n- 等级：${legitimacy.tier || '未评估'}\n- 分数：${legitimacy.score || '-'} / 5\n\n| 信号 | 发现 | 权重 |\n|---|---|---:|\n${formatLegitimacySignals(legitimacy.signals)}\n\n## 风险点\n\n${job.risk_hits?.length ? job.risk_hits.map((r) => `- ${r}`).join('\n') : '- 暂未识别硬性风险'}\n\n## JD 完整性\n\n- ${jdStatus}\n\n## 打招呼生成依据\n\n- JD 关注点：${job.greeting_basis?.jd_focus?.length ? job.greeting_basis.jd_focus.join('、') : '未识别到明确关键词'}\n- 画像匹配技能：${job.greeting_basis?.skills?.length ? job.greeting_basis.skills.join('、') : '使用默认核心技能'}\n- 画像匹配经历：${job.greeting_basis?.evidence?.length ? job.greeting_basis.evidence.join('；') : '未匹配到具体经历亮点'}\n\n## 推荐打招呼文案\n\n${greetingSourceLine(job)}\n${job.greeting}\n`, 'utf-8');
  return path;
}

// 报告里如实标注文案来源：LLM 写的 / 模板兜底的（附失败原因），别让人以为两者一样。
function greetingSourceLine(job) {
  if (job.greeting_source === 'llm') {
    return `_来源：LLM（${job.greeting_model || '已配置模型'}）_`;
  }
  const reason = job.greeting_llm_error ? `；LLM 未生效：${job.greeting_llm_error}` : '';
  return `_来源：内置模板（未启用 LLM 或调用失败${reason}）_`;
}

// ===== LLM 评估：一个批次 = 一次请求（匹配结构 + 招呼语一起返回）=====
// 用户 2026-10-30 定的口径：不再分「深解析」「招呼语」两趟，也不要三个上限。
// 只有一个数量参数「每批岗位数」，批次数 = ⌈待处理岗位数 ÷ 每批岗位数⌉，脚本自己算。
// 花钱闸只有三条，都不需要额外参数：
//   1) 已发送 / 已联系过的岗位永久跳过（消息都发出去了，评估没有意义）；
//   2) 已有 LLM 结果的岗位增量跳过（`--llm-force` 才重跑）；
//   3) 整批失败 / 模型漏项 → 对半拆重试；仍失败的条目回落模板文案。
// 权威边界：**不改 score 列**，LLM 匹配分只写 llm_score 作参考（规则分仍是发送资格的唯一依据）。

// cv.md 是评估的唯一简历来源；读不到就不跑（绝不拿 profile.yml 的摘要冒充简历原文）
function readCvForAnalysis() {
  try {
    if (!existsSync('cv.md')) return '';
    const text = readFileSync('cv.md', 'utf-8').trim();
    return text.length >= 200 ? text : '';
  } catch {
    return '';
  }
}

// 一趟流：待处理岗位按「每批岗位数」切片，每片一次请求，返回每个岗位的匹配结构 + 招呼语。
async function applyLlmPass(jobs, profile, { args = {}, env = process.env } = {}) {
  const cfg = resolveLlmConfig(BOSS_CONTROL, env);
  const summary = {
    attempted: 0, ok: 0, failed: 0, template: 0, reused: 0,
    skippedExisting: 0, skippedContacted: 0, capped: 0,
    batches: 0, requests: 0, splits: 0, credits: 0, skipped: '',
  };

  // 已有 LLM 结果的岗位：文案直接沿用（不花钱、不调 API），计入 reused
  for (const job of jobs) {
    if (!job.llm?.match) continue;
    summary.reused += 1;
    const text = job.llm.greeting?.text;
    if (!text) continue;
    job.greeting = text;
    // 统一流程里「匹配结构 + 文案」本来就是同一趟产物，所以来源就是 llm；
    // llm_analysis 只是历史标签（老数据还在，仍被识别为「已完成」，但不再新写）
    job.greeting_source = 'llm';
    job.greeting_model = job.llm.model || cfg.model || '';
    job.greeting_llm_error = '';
  }

  const off = args['no-llm'] === true || args['no-llm'] === 'true';
  if (off) {
    summary.skipped = '--no-llm';
    console.error('[boss-llm] 已按 --no-llm 跳过：本次全部使用内置模板文案');
    return summary;
  }
  if (!cfg.analyzeEnabled) {
    summary.skipped = '控制台已关闭 LLM 评估';
    return summary;
  }
  const ready = llmReadiness(cfg);
  if (!ready.ok) {
    summary.skipped = ready.reason;
    if (cfg.enabled) console.error(`[boss-llm] LLM 未就绪，使用模板文案：${ready.reason}`);
    return summary;
  }

  const force = args['llm-force'] === true || args['llm-force'] === 'true';
  // cap 只给测试 / 补跑用（--limit N）；正常流程不设，待处理多少跑多少
  const cap = Math.max(0, Math.trunc(Number(args.limit) || 0));
  // 单城扫描时只评估本城（控制台点某个城市的「扫描」会带 --analyze-city）
  const city = String(args['analyze-city'] || '').trim();
  // 人工排除（manual_excluded=1）= 用户明确「任何情况都不需要」，评估阶段也一律跳过
  const { targets: picked, skippedExisting, skippedContacted, skippedOtherCity, skippedExcluded, capped } = selectLlmTargets(jobs, { force, cap, city });

  // 评估范围（2026-10-30 用户要求）：默认只评估**真正可发送**的岗位 —— 十道发送闸门全过那批。
  // 理由：待处理里有 2/3 是「分数不达标 / 评分判定不可发 / 已关闭」，短期发不出去，
  // 提前买文案等于白花钱（实测 720 条里只有 108 条可发）。`--llm-scope=all` 可恢复全量。
  const llmScope = String(args['llm-scope'] || 'sendable').toLowerCase();
  let skippedNotSendable = 0;
  let targets = picked;
  if (llmScope !== 'all') {
    const cityLimits = BOSS_CONTROL.daily_limit_per_city || {};
    // 城市配额按「城市前缀」统计（与控制台一致）：原始城市串是「上海·浦东新区·陆家嘴」
    const urlCity = new Map(jobs.map((job) => [urlPathname(job.url), String(job.city || '').split('·')[0]]));
    const history = await readSendHistory(urlCity);
    const sendableKeys = new Set();
    for (const cityName of Object.keys(cityLimits)) {
      const cityRows = jobs.filter((job) => String(job.city || '').split('·')[0] === cityName);
      if (!cityRows.length) continue;
      const selected = selectSendableJobs(cityRows, {
        threshold: Number(BOSS_CONTROL.send_threshold ?? 3),
        cityLimits,
        platformLimit: BOSS_CONTROL.platform_daily_limit || 0,
        titleExclude: BOSS_CONTROL.title_exclude,
        staleHrActiveExclude: BOSS_CONTROL.stale_hr_active_exclude !== false,
        history,
      });
      for (const job of selected.jobs) sendableKeys.add(job.key_hash);
    }
    targets = picked.filter((job) => sendableKeys.has(job.key_hash));
    skippedNotSendable = picked.length - targets.length;
  }
  summary.skippedNotSendable = skippedNotSendable;
  summary.scope = llmScope;
  summary.skippedExisting = skippedExisting;
  summary.skippedContacted = skippedContacted;
  summary.skippedExcluded = skippedExcluded;
  summary.capped = capped;
  summary.attempted = targets.length;

  const batchSize = Math.max(1, Math.min(Number(cfg.batchSize) || 25, 100));
  const batches = Math.ceil(targets.length / batchSize);
  summary.batches = batches;

  if (skippedContacted) {
    console.error(`[boss-llm] 跳过 ${skippedContacted} 条已发送/已联系的岗位（文案已经发过了，不需要再评估）`);
  }
  if (skippedExcluded) {
    console.error(`[boss-llm] 跳过 ${skippedExcluded} 条人工排除的岗位（你标了「不发送」，任何路径都不再处理：不评估、不进队列、不发）`);
  }
  if (skippedOtherCity) {
    console.error(`[boss-llm] 跳过 ${skippedOtherCity} 条其他城市的岗位（本次只评估 ${city}）`);
  }
  if (skippedExisting) {
    console.error(`[boss-llm] 跳过 ${skippedExisting} 条已有 LLM 结果的岗位（增量；要重跑加 --llm-force）`);
  }
  if (skippedNotSendable) {
    console.error(`[boss-llm] 跳过 ${skippedNotSendable} 条当前不可发送的岗位（分数不达标/评分判不可发/已关闭/HR不活跃/去重/配额；要全量评估加 --llm-scope=all）`);
  }
  if (capped) {
    console.error(`[boss-llm] 本次只处理前 ${targets.length} 条（--limit ${cap}，测试/补跑用），剩余 ${capped} 条留到下次`);
  }

  // dry-run 默认不花钱：只把「几批、几次请求」算给你看
  const dryRunOnly = args['dry-run'] && args.llm !== true && args.llm !== 'true';
  if (dryRunOnly) {
    summary.skipped = 'dry-run';
    console.error(`[boss-llm] dry-run 不调用模型：待处理 ${targets.length} 条 ÷ 每批 ${batchSize} = ${batches} 次请求（一次请求 = 一次模型调用）；要真跑加 --llm`);
    return summary;
  }
  if (!targets.length) return summary;

  const cv = readCvForAnalysis();
  if (!cv) {
    summary.skipped = '缺少 cv.md';
    console.error('[boss-llm] 找不到 cv.md 或内容过短：LLM 评估必须基于简历原文，本次跳过（全部用模板文案）');
    return summary;
  }

  console.error(`[boss-llm] LLM 评估：${cfg.protocol} · ${cfg.model} · 待处理 ${targets.length} 条 ÷ 每批 ${batchSize} = ${batches} 次请求`);
  const byKey = new Map(targets.map((job) => [job.key_hash, job]));
  const done = new Set();
  cfg.onBatch = (passed, all) => {
    console.error(`[boss-llm] 批 ${Math.ceil(passed / batchSize)}/${batches} 完成（${passed}/${all} 条 · 成功 ${done.size} · 失败 ${summary.failed}）`);
  };

  const result = await analyzeJobsChunked({
    jobs: targets,
    cv,
    cfg,
    onItem: async ({ key_hash, analysis }) => {
      const job = byKey.get(key_hash);
      if (!job) return;
      const full = withJobIdentity(analysis, job);
      job.llm = full;
      job.llm_score = full.match.score;
      job.greeting = full.greeting.text;
      job.greeting_source = 'llm';
      job.greeting_model = cfg.model;
      job.greeting_llm_error = '';
      done.add(key_hash);
      let stored = true;
      if (!args['dry-run']) {
        stored = false;
        try {
          const affected = await saveJobAnalysis(key_hash, full, { model: cfg.model, protocol: cfg.protocol, latencyMs: null, usage: null });
          // 0 行命中 = 库里没有这个 key_hash（池子被重写过 / 不是本次池子的岗位）：必须算失败，不能当成功
          if (affected) stored = true;
          else console.error(`[boss-llm] ✗ 落库未命中 key_hash（库里没有这一行）：${job.company} / ${job.title}`);
        } catch (err) {
          console.error(`[boss-llm] 落库失败 ${job.company}：${err.message}`);
        }
      }
      // 只有真的写进库（或 dry-run）才算成功；otherwise 计入失败，避免「日志说成功、库里没数据」
      if (stored) summary.ok += 1;
      else summary.failed += 1;
      console.error(`[boss-llm] ${stored ? '✓' : '✗'} ${job.company} / ${job.title} → LLM ${full.match.score} 分（${full.match.level}） 规则 ${job.score} 分`);
    },
  });

  summary.credits = Number(result.usage.credit || 0);
  summary.requests = result.requests;
  summary.splits = result.fallbackSplits;
  summary.repaired = result.repaired || 0;
  summary.retries = result.retries || 0;
  summary.failed += result.failed.length;
  for (const item of result.failed) {
    const job = byKey.get(item.job.key_hash);
    summary.template += 1;
    if (job) {
      job.greeting = job.greeting_template || job.greeting;
      job.greeting_source = 'template';
      job.greeting_llm_error = item.error;
    }
    console.error(`[boss-llm] ✗ ${item.job.company} / ${item.job.title}：${item.error}（文案回落模板）`);
  }
  console.error(`[boss-llm] LLM 评估完成：成功 ${summary.ok} / 失败 ${summary.failed} · 回落模板 ${summary.template} · 请求 ${summary.requests} 次（拆批 ${summary.splits} · 截断修复 ${summary.repaired} · 补发 ${summary.retries}）· 花费 ≈${summary.credits.toFixed(2)} credit`);
  return summary;
}


async function main() {
  const args = parseArgs();
  const input = args.input || CANDIDATES_PATH;
  const allowUnconfirmed = Boolean(args['allow-unconfirmed']);
  if (args.help) {
    console.log([
      'Usage: node boss-score.mjs --input data/boss-candidates.json --threshold 4.0 [--dry-run]',
      '',
      'LLM 评估（一次请求 = 一批岗位，返回每个岗位的匹配结构 + 问候语）：',
      '  配置在控制台「LLM」面板（PostgreSQL boss_config）；数量参数只有一个「每批岗位数」，',
      '  批次数 = ⌈待处理岗位数 ÷ 每批岗位数⌉，输出预算与超时按每批条数自动推算。',
      '  失败/未配置自动回落内置模板文案，绝不发空文案。',
      '  --no-llm             本次不调用模型，全部用模板',
      '  --llm                dry-run 时也真的调用模型（默认 dry-run 不花钱）',
      '  --llm-force          重跑已有 LLM 结果的岗位（默认增量跳过）',
      '  --limit N            本次最多处理 N 条（测试/补跑用，默认 0 = 全部待处理岗位）',
      '  --llm-scope=sendable 只评估「发送预检全过」的岗位（默认，≈可发送数）',
      '  --llm-scope=all      评估全部待处理岗位（含暂时发不出去的，更费钱）',
    ].join('\n'));
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
  // 日常评分阈值统一来自 PostgreSQL（boss_config.boss_city_control.send_threshold，唯一配置基准）；--threshold 可临时覆盖
  const threshold = Number(args.threshold ?? BOSS_CONTROL.send_threshold ?? 4.0);
  const sentJobs = await loadSentKeys({ lookbackDays: RECENT_ROLE_DEDUPE_DAYS });
  const jobs = isCandidatesPath(input) ? await loadCandidates() : readJson(input, []);
  const scored = jobs.map((job) => {
    const result = evaluateJob(job, profile);
    // 评分规则的原始判定（发送日志 30 天去重覆盖前）——决定是否回写数据库
    result.db_eligible = Boolean(result.eligible);
    if (sentJobs.has(uniqueJobKey(result))) result.eligible = false;
    if (result.score < threshold) result.eligible = false;
    return result;
  });
  // ③.4 LLM 评估（cv.md + JD → 匹配结构 + 招呼语，一个批次一次请求）：
  //      待处理岗位 ÷ 每批岗位数 = 请求次数，点一次「扫描」就全做完。
  //      报告放在这一步之后写，报告里的文案与来源才和真正发出去的文案一致。
  const llmSummary = await applyLlmPass(scored, profile, { args });
  if (!args['dry-run']) {
    for (const job of scored) job.report = writeReport(job);
  }
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
  // 队列（= 本批次）内一家公司只留最高分那一条；同公司其他岗位下一轮还能进队。
  // 这是批次上限，不是 30 天公司去重（后者已于 2026-10-23 取消）。
  const queue = scored
    .filter((job) => job.eligible)
    .sort((a, b) => b.score - a.score)
    .filter((job) => {
      const key = uniqueCompanyPlacementKey(job);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!args['dry-run']) await saveQueue('all', queue);
  console.log(JSON.stringify({
    input,
    total: scored.length,
    queued: queue.length,
    threshold,
    dryRun: Boolean(args['dry-run']),
    // LLM 评估（匹配结构 + 招呼语，一个批次一次请求）：来源 llm = 本次生成 / llm_analysis = 历史解析复用 / template = 模板兜底
    llm: {
      attempted: llmSummary.attempted,
      ok: llmSummary.ok,
      failed: llmSummary.failed,
      template: llmSummary.template,
      reused: llmSummary.reused,
      skippedExisting: llmSummary.skippedExisting || 0,
      skippedContacted: llmSummary.skippedContacted || 0,
      skippedExcluded: llmSummary.skippedExcluded || 0,
      capped: llmSummary.capped || 0,
      batches: llmSummary.batches || 0,
      requests: llmSummary.requests || 0,
      splits: llmSummary.splits || 0,
      repaired: llmSummary.repaired || 0,
      retries: llmSummary.retries || 0,
      credits: Number((llmSummary.credits || 0).toFixed(2)),
      skipped: llmSummary.skipped || null,
    },
    output: args['dry-run'] ? null : 'PG boss_queue:all',
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 不要在这里 process.exit()：stdout/stderr 是管道时，退出会把还没 flush 的报错掐掉，
  // 表现成「日志停在半截、什么也没说」（2026-10-30 两次静默 exit 1 就是这么来的）。
  main()
    .then(() => { process.exitCode = 0; })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}







