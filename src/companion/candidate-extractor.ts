import {
  COMPANION_ONTOLOGY_VERSION,
  CompanionCandidate,
  DiscourseState,
  EntityMention,
  SourceSpan,
  canonicalPredicate,
  stableCandidateId,
  stableHash
} from './ontology.js';
import type { CompanionMessage, CompanionSession } from './engine.js';

export interface CandidateExtractionResult {
  candidates: CompanionCandidate[];
  rejected: Array<{ item: string; reason: string; evidenceIds: string[] }>;
  /** True when a semantic decision stage intentionally emitted no candidates. */
  authoritative?: boolean;
}

interface CandidateInput {
  layer: CompanionCandidate['layer'];
  subject: string;
  predicate: string;
  value: unknown;
  span?: SourceSpan;
  supportingSources?: SourceSpan[];
  polarity?: CompanionCandidate['polarity'];
  modality?: CompanionCandidate['modality'];
  scope?: CompanionCandidate['scope'];
  temporalStatus?: CompanionCandidate['temporalStatus'];
  confidence?: number;
  entityMentions?: EntityMention[];
  correctionTargets?: string[];
  eventTime?: string;
  validUntil?: string;
  discourseKey?: string;
  reason: string;
}

function any(text: string, terms: string[]): boolean {
  return terms.some(term => text.includes(term));
}

function all(text: string, terms: string[]): boolean {
  return terms.every(term => text.includes(term));
}

function spanFor(message: CompanionMessage, session: CompanionSession, matched?: string, from = 0): SourceSpan {
  const text = matched ?? message.content;
  const start = matched ? message.content.indexOf(matched, from) : 0;
  return {
    messageId: message.id,
    sessionId: session.session_id,
    sessionDate: session.date,
    role: message.role,
    start: Math.max(0, start),
    end: Math.max(0, start) + text.length,
    text
  };
}

function mention(
  surface: string,
  entityType: EntityMention['entityType'],
  source: SourceSpan,
  relation?: string,
  qualifiers?: EntityMention['qualifiers']
): EntityMention {
  return {
    mentionId: `mention-${stableHash(`${source.messageId}|${surface}|${relation ?? ''}|${JSON.stringify(qualifiers ?? {})}`)}`,
    surface,
    entityType,
    relation,
    qualifiers,
    source
  };
}

function makeCandidate(input: CandidateInput, ordinal: number): CompanionCandidate {
  const source = input.span!;
  return {
    candidateId: stableCandidateId(source.messageId, input.subject, input.predicate, ordinal),
    ontologyVersion: COMPANION_ONTOLOGY_VERSION,
    layer: input.layer,
    subject: input.subject,
    predicate: input.predicate,
    value: input.value,
    source,
    supportingSources: input.supportingSources ?? [source],
    polarity: input.polarity ?? 'positive',
    modality: input.modality ?? 'asserted',
    scope: input.scope ?? 'durable',
    temporalStatus: input.temporalStatus ?? 'active',
    confidence: input.confidence ?? 0.9,
    entityMentions: input.entityMentions ?? [],
    correctionTargets: input.correctionTargets ?? [],
    eventTime: input.eventTime,
    validUntil: input.validUntil,
    discourseKey: input.discourseKey,
    reason: input.reason
  };
}

function taskOnly(text: string): boolean {
  return /(?:帮我|请)(?:只)?(?:帮我)?(?:改|写|算|检查|润色|生成|提取|调整)/.test(text)
    && /(?:句话|句子|文本|格式|错别字|正则|费用|文案|措辞|代码|标题|通知)/.test(text)
    && any(text, ['只改', '只帮我', '不要提取', '临时', '任务']);
}

function thirdPartyQuote(text: string): boolean {
  return any(text, ['原话', '转述', '她说', '他说']) && any(text, ['不是我', '别把', '不代表我', '算成我的']);
}

function sarcasm(text: string): boolean {
  return any(text, ['讽刺', '反话', '显然不是', '可太', '最喜欢的安排'])
    && any(text, ['不是真', '不是在申报', '没有', '通宵', '凌晨', '加班', '折腾']);
}

function normalizeDate(sessionDate: string, month: string, day: string): string {
  const year = sessionDate.slice(0, 4);
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function chineseNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return map[value];
}

function pushCandidate(candidates: CompanionCandidate[], input: CandidateInput): void {
  candidates.push(makeCandidate(input, candidates.length));
}

function explicitName(text: string): RegExpMatchArray | null {
  return text.match(/(?:我叫|我的名字(?:是|叫)|名字是)\s*([^，,。；;\s]{1,12})/);
}

function explicitOccupation(text: string): RegExpMatchArray | null {
  return text.match(/(?:(?:我的)?(?:工作|职业)是|我(?:目前|现在)?(?:从事|做))([^，,。；;]{2,30})/);
}

function personSubject(name: string, relation: string, discriminator = ''): string {
  return `people.relation.${stableHash(`${name}|${relation}|${discriminator}`)}`;
}

function addPersonCandidate(
  candidates: CompanionCandidate[],
  message: CompanionMessage,
  session: CompanionSession,
  name: string,
  relation: string,
  sourceText: string,
  qualifiers: Record<string, string | number | boolean> = {},
  modality: CompanionCandidate['modality'] = 'asserted'
): void {
  const source = Object.keys(qualifiers).length > 0 ? spanFor(message, session, message.content) : spanFor(message, session, sourceText);
  const discriminator = `${relation}|${String(qualifiers.location ?? qualifiers.organization ?? qualifiers.occupation ?? '')}`;
  const entity = mention(name, 'person', source, relation, qualifiers);
  pushCandidate(candidates, {
    layer: 'USER_MODEL',
    subject: personSubject(name, relation, discriminator),
    predicate: 'relation',
    value: { name, relation, ...qualifiers },
    span: source,
    modality,
    entityMentions: [entity],
    reason: 'Explicit person identity and relationship'
  });
}

function extractIdentity(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession): void {
  const text = message.content;
  const surname = text.match(/我姓\s*([^，,。；;\s]{1,2})/);
  if (surname) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'profile.identity.surname', predicate: 'surname', value: surname[1], span: spanFor(message, session, surname[0]), reason: 'Explicit surname'
  });

  const name = explicitName(text);
  if (name) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'profile.identity.full_name', predicate: 'fullName', value: name[1], span: spanFor(message, session, name[0]), reason: 'Explicit full name'
  });

  const age = text.match(/(?:我)?(?:今年)?(\d{1,3})岁|(?:生日|过完生日)[^\d]{0,6}(\d{1,3})岁/);
  if (age) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'profile.identity.age', predicate: 'age', value: Number(age[1] ?? age[2]), span: spanFor(message, session, age[0]), modality: text.includes('生日') ? 'corrective' : 'asserted', reason: 'Explicit age'
  });

  const residence = [...text.matchAll(/(?:我(?:现在|目前|仍然|还是)?|现在|目前)(?:常住|住在|居住在)\s*([^，,。；;\s]{1,12}?)(?=从事|做|，|,|。|；|;|$)/g)]
    .find(match => !/(?:不是|并非)\s*$/.test(text.slice(0, match.index)));
  if (residence) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'profile.residence.current', predicate: 'currentResidence', value: residence[1], span: spanFor(message, session, residence[0]), reason: 'Explicit current residence'
  });

  const combinedWork = text.match(/我叫[^，,。；;]{1,12}[，,][^。；;]{0,16}(?:住在|在)([^，,。；;\s]{1,12}?)(?:从事|做)([^，,。；;]{2,30})/)
    ?? text.match(/我(?:现在|目前)?(?:住在|在)([^，,。；;\s]{1,12}?)(?:从事|做)([^，,。；;]{2,30})/);
  if (!residence && combinedWork) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'profile.residence.current', predicate: 'currentResidence', value: combinedWork[1], span: spanFor(message, session, combinedWork[0]), reason: 'User-attributed residence in occupation clause'
  });
  const occupation = explicitOccupation(text);
  if (occupation && !/(?:做决定|做选择|做不到)/.test(occupation[0])) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'profile.occupation.current', predicate: 'occupation', value: occupation[1].replace(/^(?:给)/, '').trim(), span: spanFor(message, session, occupation[0]), reason: 'Explicit current occupation'
  });
  if (!occupation && combinedWork) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'profile.occupation.current', predicate: 'occupation', value: combinedWork[2].trim(), span: spanFor(message, session, combinedWork[0]), reason: 'User-attributed occupation in residence clause'
  });
}

function extractOriginCorrection(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession): void {
  const text = message.content;
  const contrast = text.match(/不是在([^，,。；;\s]{1,12})长大[^，,。；;]*[，,。；;]?[^，,。；;]*(?:童年|小时候)[^，,。；;]*(?:在|是)([^，,。；;\s]{1,12})/);
  if (contrast) {
    pushCandidate(candidates, {
      layer: 'USER_MODEL', subject: 'profile.childhood_place.current', predicate: 'childhoodPlace', value: contrast[1], span: spanFor(message, session, contrast[0]), polarity: 'negative', modality: 'asserted', reason: 'Explicitly negated childhood place'
    });
    pushCandidate(candidates, {
      layer: 'USER_MODEL', subject: 'profile.childhood_place.current', predicate: 'childhoodPlace', value: contrast[2], span: spanFor(message, session, contrast[0]), reason: 'Explicit positive childhood place after contrast'
    });
  }

  const correction = text.match(/(?:更正|以这条为准)[^：:]*[：:]?[^。；;]*(?:我)?是在([^，,。；;\s]{1,12})长大/);
  if (correction) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'profile.childhood_place.current', predicate: 'childhoodPlace', value: correction[1], span: spanFor(message, session, correction[0]), modality: 'corrective', correctionTargets: ['profile.childhood_place.current'], reason: 'Explicit correction of childhood place'
  });

  const parentPlace = text.match(/([^，,。；;\s]{1,12})是我(父亲|母亲|爸爸|妈妈)(?:从小生活|长大|童年)[^，,。；;]*(?:的地方|在)?/);
  if (parentPlace) {
    const relation = /母亲|妈妈/.test(parentPlace[2]) ? '母亲' : '父亲';
    addPersonCandidate(candidates, message, session, relation, relation, parentPlace[0], { childhoodPlace: parentPlace[1] }, 'corrective');
  }

  if (!contrast && !correction) {
    const origin = text.match(/(?:我)?(?:一直)?在([^，,。；;\s]{1,12})(?:长大|土生土长)/);
    if (origin && !/(?:父亲|母亲|爸爸|妈妈)[^。；;]{0,12}$/.test(text.slice(0, origin.index ?? 0))) pushCandidate(candidates, {
      layer: 'USER_MODEL', subject: 'profile.childhood_place.current', predicate: 'childhoodPlace', value: origin[1], span: spanFor(message, session, origin[0]), reason: 'Explicit childhood place'
    });
  }
}

function extractPeople(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession, state: DiscourseState): void {
  const text = message.content;
  const patterns: Array<{ regex: RegExp; relation: (match: RegExpMatchArray) => string; name: (match: RegExpMatchArray) => string }> = [
    { regex: /我(表姐|表哥|堂姐|堂哥|妹妹|姐姐|弟弟|哥哥|姑妈|舅舅|姨妈)叫([^，,。；;\s]{1,10})/, relation: match => match[1], name: match => match[2] },
    { regex: /([^，,。；;\s]{1,10})是我(?:的)?(姑妈|舅舅|姨妈|朋友|同事|大学同学|表姐|表哥|妹妹|姐姐|弟弟|哥哥)/, relation: match => match[2], name: match => match[1] }
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (!match) continue;
    const location = text.match(/(?:在|住在)([^，,。；;\s]{1,12})(?:做|从事|执业)/)?.[1];
    const occupation = text.match(/(?:做|从事)([^，,。；;]{2,20})/)?.[1];
    addPersonCandidate(candidates, message, session, pattern.name(match), pattern.relation(match), match[0], {
      ...(location ? { location } : {}),
      ...(occupation ? { occupation } : {})
    });
  }
  const locatedPerson = text.match(/([^，,。；;\s]{1,10})(?:现在|目前)?住在([^，,。；;\s]{1,12})/);
  if (locatedPerson && !['我', '本人'].includes(locatedPerson[1])) {
    const priorMention = [...state.candidates].reverse()
      .flatMap(candidate => candidate.entityMentions)
      .find(mention => mention.entityType === 'person' && mention.surface === locatedPerson[1]);
    if (priorMention) pushCandidate(candidates, {
      layer: 'USER_MODEL',
      subject: personSubject(priorMention.surface, priorMention.relation ?? '', 'location'),
      predicate: 'currentResidence',
      value: locatedPerson[2],
      span: spanFor(message, session, locatedPerson[0]),
      entityMentions: [mention(priorMention.surface, 'person', spanFor(message, session, locatedPerson[0]), priorMention.relation, { location: locatedPerson[2] })],
      reason: 'Explicit location owned by a previously identified person'
    });
  }

  const professional = text.match(/(?:医生|牙医|律师|教练)(?:也)?叫([^，,。；;\s]{1,10})/);
  if (professional) {
    const relation = text.includes('牙医') ? '牙医' : text.includes('医生') ? '医生' : text.includes('律师') ? '律师' : '教练';
    const location = text.match(/在([^，,。；;\s]{1,12})(?:执业|工作)/)?.[1];
    addPersonCandidate(candidates, message, session, professional[1], relation, professional[0], {
      ...(location ? { location } : {}),
      isRelative: !any(text, ['没有亲属', '不是亲属', '无亲属'])
    });
  }

  const emergency = text.match(/([^，,。；;\s]{1,10})是我([^，,。；;\s]{1,8})[^。；;]*(?:唯一指定|唯一的)紧急联系人/);
  if (emergency) {
    addPersonCandidate(candidates, message, session, emergency[1], emergency[2], emergency[0], { emergencyContact: true });
    const condition = text.match(/(?:只有|仅)(?:在)?([^，,。；;]+?)(?:时|才)\s*(?:才)?联系/);
    if (condition) pushCandidate(candidates, {
      layer: 'CURRENT_CONTEXT', subject: 'context.emergency_contact.protocol', predicate: 'contactCondition',
      value: { contact: emergency[1], condition: condition[1], exclusivity: 'only' }, span: spanFor(message, session, text),
      entityMentions: [mention(emergency[1], 'person', spanFor(message, session, emergency[0]), emergency[2], { emergencyContact: true })],
      reason: 'Explicit conditional emergency-contact protocol'
    });
  }
}
function extractPreferences(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession, state: DiscourseState): void {
  const text = message.content;
  const historicalReading = text.match(/(?:过去|大学那几年|以前)[^。；;]*(?:长篇|书)[^。；;]*(纸质版|纸书)/);
  if (historicalReading && any(text, ['过去', '不代表现在', '以前'])) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'preference.reading.long_form', predicate: 'longFormMedium', value: historicalReading[0], span: spanFor(message, session, historicalReading[0]), scope: 'historical', temporalStatus: 'historical', reason: 'Explicit historical reading preference'
  });

  const currentReading = text.match(/(?:现在|如今)[^。；;]*(?:长篇|阅读)[^。；;]*(?:只选|只用|偏好)([^，,。；;]+)/);
  if (currentReading) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'preference.reading.long_form', predicate: 'longFormMedium', value: currentReading[1].trim(), span: spanFor(message, session, currentReading[0]), modality: any(text, ['作废', '到此', '不再']) ? 'corrective' : 'asserted', correctionTargets: ['preference.reading.long_form'], reason: 'Explicit current reading preference'
  });

  if (all(text, ['不喜欢', '徒步'])) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'preference.activity.long_distance_hiking', predicate: 'preference', value: '不喜欢', span: spanFor(message, session, text.match(/不喜欢[^，,。；;]*徒步/)?.[0]), reason: 'Explicit negative activity preference'
  });
  if (all(text, ['不常买', '户外装备'])) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'preference.shopping.outdoor_equipment', predicate: 'frequency', value: '不常买', span: spanFor(message, session, text.match(/不常买[^，,。；;]*户外装备/)?.[0]), reason: 'Explicit shopping-frequency preference'
  });

  if (text.includes('咖啡') && any(text, ['低因', '无咖啡因', '燕麦奶', '非冰', '温热'])) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'preference.beverage.coffee', predicate: 'preference', value: {
      caffeine: text.includes('无咖啡因') ? 'none' : text.includes('低因') ? 'low' : undefined,
      milk: text.includes('燕麦奶') ? 'oat' : undefined,
      temperature: any(text, ['非冰', '温热']) ? 'not_iced' : undefined
    }, span: spanFor(message, session, text), modality: any(text, ['以前', '旧', '作废']) ? 'corrective' : 'asserted', correctionTargets: ['preference.beverage.coffee'], reason: 'Explicit scoped beverage preference'
  });

  if (text.includes('语音') && any(text, ['工作群', '私人', '朋友', '冗长', '长语音'])) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'preference.communication.voice_message', predicate: 'preference', value: text, span: spanFor(message, session, text), reason: 'Context-scoped voice-message preference'
  });
  if (text.includes('自动化') && any(text, ['可解释', '可撤销', '可审计'])) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'preference.automation.control', predicate: 'preference', value: text, span: spanFor(message, session, text), modality: 'corrective', correctionTargets: ['preference.automation.control'], reason: 'Explicit automation governance preference'
  });
  const medium = text.match(/(?:目前|现在|当前)(仍然)?首选([^，,。；;]{2,24})/);
  if (medium) {
    const prior = [...state.candidates].reverse().find(item => canonicalPredicate(item.predicate) === 'preference.medium');
    const changed = Boolean(prior && !medium[1] && String(prior.value) !== medium[2].trim());
    pushCandidate(candidates, {
      layer: 'USER_MODEL', subject: 'preference.medium.current', predicate: 'preference.medium', value: medium[2].trim(),
      span: spanFor(message, session, medium[0]), modality: changed ? 'corrective' : 'asserted',
      correctionTargets: changed && prior ? [prior.subject] : [], reason: changed ? 'Explicit medium preference update' : 'Explicit current medium preference'
    });
  }
}

function extractTemporaryState(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession, state: DiscourseState): void {
  const text = message.content;
  if (any(text, ['睡得很差', '睡眠很差', '临时失眠']) && any(text, ['临时', '这周', '连续', '交付期', '最近'])) pushCandidate(candidates, {
    layer: 'CURRENT_CONTEXT', subject: 'context.temporary.sleep_disruption', predicate: 'sleepDisruption', value: text, span: spanFor(message, session, text), scope: 'temporary', temporalStatus: 'temporary', reason: 'Explicit temporary sleep disruption'
  });
  if (any(text, ['睡眠已经恢复', '睡眠恢复', '临时失眠明确结束', '睡得正常']) && any(text, ['恢复', '结束', '正常'])) pushCandidate(candidates, {
    layer: 'CURRENT_CONTEXT', subject: 'context.temporary.sleep_disruption', predicate: 'sleepDisruption', value: text, span: spanFor(message, session, text), modality: 'corrective', scope: 'historical', temporalStatus: 'closed', correctionTargets: ['context.temporary.sleep_disruption'], reason: 'Explicit closure of temporary sleep disruption'
  });
  if (any(text, ['发烧', '发热']) && !any(text, ['好了', '恢复', '结束'])) pushCandidate(candidates, {
    layer: 'CURRENT_CONTEXT', subject: 'context.temporary.fever', predicate: 'healthState', value: text, span: spanFor(message, session, text), scope: 'temporary', temporalStatus: 'temporary', reason: 'Explicit acute health state'
  });
  if (any(text, ['退烧', '发烧好了', '发热结束'])) pushCandidate(candidates, {
    layer: 'CURRENT_CONTEXT', subject: 'context.temporary.fever', predicate: 'healthState', value: text, span: spanFor(message, session, text), modality: 'corrective', scope: 'historical', temporalStatus: 'closed', correctionTargets: ['context.temporary.fever'], reason: 'Explicit closure of acute health state'
  });
  const temporaryStress = text.match(/(?:这周|本周|临时|短期)[^。；;]{0,28}(?:发怵|紧张|焦虑|压力)/);
  if (temporaryStress && !any(text, ['关闭', '结束', '恢复'])) pushCandidate(candidates, {
    layer: 'CURRENT_CONTEXT', subject: 'context.stress.current', predicate: 'context.stress_state', value: temporaryStress[0],
    span: spanFor(message, session, temporaryStress[0]), scope: 'temporary', temporalStatus: 'temporary', reason: 'Explicit temporary stress state'
  });
  const closedStress = text.match(/(?:把|将)[^。；;]{0,20}(?:临时)?(?:发怵|紧张|焦虑|压力)[^。；;]{0,12}(?:关闭|结束)/);
  if (closedStress) pushCandidate(candidates, {
    layer: 'CURRENT_CONTEXT', subject: 'context.stress.current', predicate: 'context.stress_state', value: closedStress[0],
    span: spanFor(message, session, closedStress[0]), modality: 'corrective', scope: 'historical', temporalStatus: 'closed',
    correctionTargets: ['context.stress.current'], reason: 'Explicit closure of temporary stress state'
  });
  const continuingStress = text.match(/(?:那段)?(?:紧张|焦虑|压力|发怵)[^。；;]{0,12}(?:还没有结束|仍未结束|还在继续)/);
  if (continuingStress) {
    const prior = [...state.candidates].reverse().find(item => canonicalPredicate(item.predicate) === 'context.stress_state');
    if (prior) pushCandidate(candidates, {
      layer: 'CURRENT_CONTEXT', subject: prior.subject, predicate: 'context.stress_state', value: prior.value,
      span: spanFor(message, session, continuingStress[0]), supportingSources: [prior.source, spanFor(message, session, continuingStress[0])],
      scope: 'temporary', temporalStatus: 'temporary', reason: 'Explicit continuation of a prior temporary stress state'
    });
  }
}

function extractDecision(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession, state: DiscourseState): void {
  const text = message.content;
  const candidate = text.match(/(?:考虑|候选|可能)[^。；;]{0,16}(?:搬去|迁往|搬到)([^，,。；;\s]{1,14})/);
  if (candidate && any(text, ['候选', '还没有', '未决定', '考虑'])) pushCandidate(candidates, {
    layer: 'CURRENT_CONTEXT', subject: 'decision.relocation.candidate', predicate: 'relocationPlan', value: { destination: candidate[1], status: 'candidate' }, span: spanFor(message, session, candidate[0]), modality: 'candidate', scope: 'temporary', temporalStatus: 'proposed', reason: 'Explicitly modal relocation candidate'
  });
  const activityPlan = text.match(/(?:我)?(?:在)?考虑[^。；;]{0,16}去([^，,。；;\s]{1,14})参加([^，,。；;]{2,30})/);
  if (activityPlan && any(text, ['考虑', '候选', '备选', '没订', '未订'])) pushCandidate(candidates, {
    layer: 'CURRENT_CONTEXT', subject: `decision.plan.${stableHash(`${activityPlan[1]}|${activityPlan[2]}`)}`,
    predicate: 'decision.plan', value: activityPlan[0], span: spanFor(message, session, activityPlan[0]),
    modality: 'candidate', scope: 'temporary', temporalStatus: 'proposed', discourseKey: 'decision.activity.current', reason: 'Explicit candidate activity plan'
  });
  const canceledActivity = text.match(/之前考虑的([^，,。；;]{2,36})不去了/);
  if (canceledActivity) {
    const prior = [...state.candidates].reverse().find(item => canonicalPredicate(item.predicate) === 'decision.plan');
    pushCandidate(candidates, {
      layer: 'CURRENT_CONTEXT', subject: prior?.subject ?? `decision.plan.${stableHash(canceledActivity[1])}`,
      predicate: 'decision.plan', value: canceledActivity[0], span: spanFor(message, session, canceledActivity[0]),
      modality: 'corrective', scope: 'historical', temporalStatus: 'closed', correctionTargets: prior ? [prior.subject] : [],
      discourseKey: prior?.discourseKey ?? 'decision.activity.current', reason: 'Explicit candidate activity-plan cancellation'
    });
  }
  const confirmedActivity = text.match(/之前考虑的([^，,。；;]{2,36})确定要去了/);
  if (confirmedActivity) {
    const prior = [...state.candidates].reverse().find(item => canonicalPredicate(item.predicate) === 'decision.plan');
    pushCandidate(candidates, {
      layer: 'CURRENT_CONTEXT', subject: prior?.subject ?? `decision.plan.${stableHash(confirmedActivity[1])}`,
      predicate: 'decision.plan', value: confirmedActivity[0], span: spanFor(message, session, confirmedActivity[0]),
      modality: 'corrective', scope: 'durable', temporalStatus: 'active', correctionTargets: prior ? [prior.subject] : [],
      discourseKey: prior?.discourseKey ?? 'decision.activity.current', reason: 'Explicit confirmation of a candidate activity plan'
    });
  }


  const canceled = text.match(/(?:搬去|迁往|搬到)([^，,。；;\s]{1,14})(?:的)?(?:方案|计划)?(?:已经)?(?:取消|作废|不再有效|不去了)/)
    ?? text.match(/([^，,。；;\s]{1,14})不去了[^。；;]*(?:计划|方案)(?:已经)?(?:取消|作废)/);
  if (canceled) pushCandidate(candidates, {
    layer: 'CURRENT_CONTEXT', subject: 'decision.relocation.candidate', predicate: 'relocationPlan', value: { destination: canceled[1], status: 'canceled' }, span: spanFor(message, session, canceled[0]), modality: 'corrective', scope: 'historical', temporalStatus: 'closed', correctionTargets: ['decision.relocation.candidate'], reason: 'Explicit candidate-plan cancellation'
  });
  const completed = text.match(/(?:已经|正式|完成)?(?:搬到|搬进|住进)([^，,。；;]{1,20})(?:新家|房子)?/);
  if (completed && !any(text, ['考虑', '候选', '取消', '未决定'])) pushCandidate(candidates, {
    layer: 'EPISODIC_MEMORY', subject: 'episode.event.relocation', predicate: 'relocation', value: { eventType: 'relocation', destination: completed[1], description: completed[0] }, span: spanFor(message, session, completed[0]), scope: 'historical', temporalStatus: 'historical', eventTime: session.date, reason: 'Explicitly completed relocation event'
  });
}

function extractProtocols(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession, state: DiscourseState): void {
  const text = message.content;
  const ordered = text.match(/只要我发[‘'“"]([^’'”"]+)[’'”"][^—-]*[—-]{1,2}先([^，,。；;]+)[，,；;]再([^，,。；;]+)[，,；;]最后(?:才)?([^，,。；;]+)/);
  if (ordered) pushCandidate(candidates, {
    layer: 'RELATIONSHIP', subject: 'relationship.protocol.ordered_response', predicate: 'orderedResponseProtocol',
    value: { trigger: ordered[1], orderedSteps: [ordered[2].trim(), ordered[3].trim(), ordered[4].trim()] },
    span: spanFor(message, session, ordered[0]), reason: 'Explicit trigger and ordered response protocol'
  });

  const choice = text.match(/[‘'“"]([^’'”"]+还是[^’'”"]+)[’'”"]/);
  if (choice && any(text, ['问我', '确认', '口令', '开关'])) pushCandidate(candidates, {
    layer: 'RELATIONSHIP', subject: 'relationship.protocol.support_mode', predicate: 'supportMode', value: choice[1], span: spanFor(message, session, choice[0]), reason: 'Explicit support-mode protocol'
  });

  if ((/先.{0,10}(?:听|陪|接住)/.test(text) && /(?:再|之后).{0,10}(?:建议|分析|拆解)/.test(text)) || any(text, ['先被听见', '先听我说'])) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'communication.support.distress', predicate: 'distressMode', value: text, span: spanFor(message, session, text), reason: 'Explicit distress support preference'
  });
  if (any(text, ['工作复盘', '工作反馈']) && any(text, ['直接', '具体', '证据'])) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'communication.feedback.work', predicate: 'workFeedback', value: text, span: spanFor(message, session, text), reason: 'Explicit work-feedback preference'
  });

  if (all(text, ['事实', '假设']) && any(text, ['解释', '区分', '分层', '标出'])) pushCandidate(candidates, {
    layer: 'RELATIONSHIP', subject: 'relationship.protocol.epistemic_layers', predicate: 'epistemicLayers', value: text, span: spanFor(message, session, text), reason: 'Explicit epistemic-layer protocol'
  });
  const trigger = text.match(/(?:建立|设定|创建)一个长期规则[^。；;]*触发词是[“"]([^”"]+)[”"]/);
  if (trigger) pushCandidate(candidates, {
    layer: 'RELATIONSHIP', subject: `relationship.protocol.${stableHash(trigger[1])}`, predicate: 'orderedResponseProtocol',
    value: text, span: spanFor(message, session, text), reason: 'Explicit long-term trigger protocol'
  });

  const ritual = text.match(/(?:设|建立)一个长期重复的?小?仪式[^。；;]*叫[“"]([^”"]+)[”"]/);
  if (ritual) pushCandidate(candidates, {
    layer: 'RELATIONSHIP', subject: `relationship.ritual.${stableHash(ritual[1])}`, predicate: 'ritual',
    value: text, span: spanFor(message, session, text), discourseKey: `ritual.${ritual[1]}`, reason: 'Explicit named recurring ritual'
  });

  const occurrence = text.match(/这次([^，,。；;]{1,16})里[^。；;]*(?:守住|松手)[^。；;]*/);
  if (occurrence) {
    const established = [...state.candidates].reverse().some(item =>
      canonicalPredicate(item.predicate) === 'relationship.ritual' && String(item.value).includes(occurrence[1])
    );
    if (established) pushCandidate(candidates, {
      layer: 'EPISODIC_MEMORY', subject: `episode.event.${stableHash(`${occurrence[1]}|${session.date}`)}`,
      predicate: 'episode.ritual_occurrence', value: occurrence[0], span: spanFor(message, session, occurrence[0]),
      scope: 'historical', temporalStatus: 'historical', eventTime: session.date, discourseKey: `ritual.${occurrence[1]}`,
      reason: 'Explicit occurrence of an established ritual'
    });
  }
}

function extractBoundaries(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession): void {
  const text = message.content;
  if (any(text, ['推测', '猜']) && any(text, ['回忆', '记得', '不确定'])) pushCandidate(candidates, {
    layer: 'COMPANION_IDENTITY', subject: 'identity.boundary.memory_honesty', predicate: 'memoryHonesty', value: text, span: spanFor(message, session, text), reason: 'Explicit epistemic honesty boundary'
  });
  if (any(text, ['心理诊断', '依恋', '人格']) && any(text, ['不要', '别', '未经', '猜'])) pushCandidate(candidates, {
    layer: 'COMPANION_IDENTITY', subject: 'identity.boundary.no_diagnosis', predicate: 'roleBoundary', value: text, span: spanFor(message, session, text), reason: 'Explicit no-diagnosis role boundary'
  });
  if (any(text, ['等你', '想我', '思念', '占有欲']) && any(text, ['不要', '别', '不用', '有负担', '假'])) pushCandidate(candidates, {
    layer: 'COMPANION_IDENTITY', subject: 'identity.boundary.non_possessive', predicate: 'nonPossessiveIntimacy', value: text, span: spanFor(message, session, text), reason: 'Explicit non-possessive intimacy boundary'
  });
  if (any(text, ['不同意', '反驳', '诚实分歧', '回音壁']) && any(text, ['理由', '证据', '直接', '不要', '可以'])) pushCandidate(candidates, {
    layer: 'COMPANION_IDENTITY', subject: 'identity.subjectivity.honest_disagreement', predicate: 'subjectivity', value: text, span: spanFor(message, session, text), reason: 'Explicit request for reasoned disagreement'
  });
  if (any(text, ['选择权', '自主性', '可撤销']) && any(text, ['重要', '担心', '决定', '重视'])) pushCandidate(candidates, {
    layer: 'USER_MODEL', subject: 'value.autonomy.optionality', predicate: 'value', value: text, span: spanFor(message, session, text), reason: 'Explicit autonomy value'
  });
  if ((/我们.{0,4}(?:做到|完成|赢)/.test(text) || any(text, ['共同功劳', '主要是我'])) && any(text, ['别说', '不要', '不该', '见证'])) pushCandidate(candidates, {
    layer: 'RELATIONSHIP', subject: 'relationship.boundary.achievement_attribution', predicate: 'achievementAttribution', value: text, span: spanFor(message, session, text), reason: 'Explicit achievement attribution boundary'
  });
}

function extractCompanionNaming(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession): void {
  const text = message.content;
  const companion = text.match(/(?:叫你|称呼你)[‘'“"]?([^’'”"，,。！？?]{1,12})[’'”"]?/);
  if (companion && any(text, ['名字', '叫你', '称呼'])) pushCandidate(candidates, {
    layer: 'RELATIONSHIP', subject: 'relationship.identity.companion_name', predicate: 'companionName', value: companion[1], span: spanFor(message, session, companion[0]), entityMentions: [mention(companion[1], 'companion', spanFor(message, session, companion[0]))], reason: 'Explicit companion naming'
  });
  const nickname = text.match(/(?:叫我|称呼我)[‘'“"]?([^’'”"，,。！？?]{1,12})[’'”"]?/);
  if (nickname && any(text, ['专属', '只限', '只有你'])) pushCandidate(candidates, {
    layer: 'RELATIONSHIP', subject: 'relationship.identity.user_nickname', predicate: 'userNickname', value: nickname[1], span: spanFor(message, session, nickname[0]), reason: 'Explicit scoped user nickname'
  });
}

function extractTimeline(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession, state: DiscourseState): void {
  const text = message.content;
  const matches = [...text.matchAll(/(\d{1,2})月(\d{1,2})日([^，,。；;]+)/g)];
  if (matches.length === 0) return;
  const discourseKey = any(text, ['漏水', '渗水', '防水']) ? 'event.timeline.property_repair' : `event.timeline.${stableHash(session.topic || 'event')}`;
  const previous = state.pending.get(discourseKey) ?? [];
  matches.forEach((match, index) => {
    const eventDate = normalizeDate(session.date, match[1], match[2]);
    pushCandidate(candidates, {
      layer: 'EPISODIC_MEMORY', subject: discourseKey, predicate: 'step',
      value: { eventType: 'timeline_step', eventDate, description: match[3].trim(), step: previous.length + index + 1 },
      span: spanFor(message, session, match[0], match.index), scope: 'historical', temporalStatus: 'historical', eventTime: eventDate, discourseKey,
      reason: 'Explicit dated timeline step'
    });
  });
  if (any(text, ['结束', '完成', '验收无', '共']) && any(text, ['步', '起事件', '整件事'])) pushCandidate(candidates, {
    layer: 'EPISODIC_MEMORY', subject: discourseKey, predicate: 'timeline',
    value: { status: 'closed', eventCount: previous.length + matches.length, closedAt: matches.at(-1) ? normalizeDate(session.date, matches.at(-1)![1], matches.at(-1)![2]) : session.date },
    span: spanFor(message, session, text), modality: 'corrective', scope: 'historical', temporalStatus: 'closed', correctionTargets: [discourseKey], discourseKey,
    reason: 'Explicit timeline closure'
  });
}

function extractTradition(candidates: CompanionCandidate[], message: CompanionMessage, session: CompanionSession, state: DiscourseState): void {
  const text = message.content;
  const key = 'discourse.recurring_tradition';
  if (/每年[^。；;]*(?:送去|带去|交给)([^，,。；;\s]{1,10})(?:修|整理|维护)/.test(text) && !any(text, ['接上条', '他是', '她是'])) {
    const pending = makeCandidate({
      layer: 'CURRENT_CONTEXT', subject: 'context.recurring_tradition', predicate: 'recurringTradition', value: { firstMessage: text },
      span: spanFor(message, session, text), modality: 'hypothetical', scope: 'durable', temporalStatus: 'active', discourseKey: key,
      reason: 'Pending multi-message recurring tradition awaiting participant disambiguation'
    }, 0);
    state.pending.set(key, [pending]);
    return;
  }
  const pending = state.pending.get(key);
  if (!pending?.length || !any(text, ['接上条', '才完整', '他是', '她是'])) return;
  const relation = text.match(/([^，,。；;\s]{1,10})不是[^，,。；;]+[，,。；;]?他是我([^，,。；;\s]{1,8})/);
  if (!relation) return;
  addPersonCandidate(candidates, message, session, relation[1], relation[2], relation[0]);
  const combinedSource = `${pending[0].source.text} ${text}`;
  const timing = pending[0].source.text.match(/每年([^，,。；;]+)/)?.[1];
  pushCandidate(candidates, {
    layer: 'CURRENT_CONTEXT', subject: 'context.recurring_tradition', predicate: 'recurringTradition',
    value: { participant: relation[1], activity: pending[0].source.text, frequency: 'annual', timing },
    span: spanFor(message, session, text), supportingSources: [pending[0].source, spanFor(message, session, text)],
    entityMentions: [mention(relation[1], 'person', spanFor(message, session, relation[0]), relation[2])],
    discourseKey: key, reason: `Resolved multi-message recurring tradition: ${combinedSource}`
  });
  state.pending.delete(key);
}

export function createDiscourseState(): DiscourseState {
  return { pending: new Map(), entities: [], candidates: [] };
}

export function extractCandidatesFromMessage(
  message: CompanionMessage,
  session: CompanionSession,
  state: DiscourseState
): CandidateExtractionResult {
  const text = message.content.trim();
  const candidates: CompanionCandidate[] = [];
  const rejected: CandidateExtractionResult['rejected'] = [];

  if (message.role !== 'user') return { candidates, rejected };
  if (taskOnly(text)) {
    rejected.push({ item: text, reason: 'Task-only content is not durable memory evidence', evidenceIds: [message.id] });
    return { candidates, rejected };
  }
  if (thirdPartyQuote(text)) {
    rejected.push({ item: text, reason: 'Explicit third-party quote is not the user belief', evidenceIds: [message.id] });
    return { candidates, rejected };
  }
  if (sarcasm(text)) {
    rejected.push({ item: text, reason: 'Explicit sarcasm is not a literal preference', evidenceIds: [message.id] });
    return { candidates, rejected };
  }

  extractIdentity(candidates, message, session);
  extractOriginCorrection(candidates, message, session);
  extractPeople(candidates, message, session, state);
  extractPreferences(candidates, message, session, state);
  extractTemporaryState(candidates, message, session, state);
  extractDecision(candidates, message, session, state);
  extractProtocols(candidates, message, session, state);
  extractBoundaries(candidates, message, session);
  extractCompanionNaming(candidates, message, session);
  extractTimeline(candidates, message, session, state);
  extractTradition(candidates, message, session, state);

  state.candidates.push(...candidates);
  return { candidates, rejected };
}
