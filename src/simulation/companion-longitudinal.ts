import fs from 'node:fs';
import path from 'node:path';

export const LONGITUDINAL_CORPUS_VERSION = 'companion-longitudinal/v2';

export interface SimulatedTruthEvent {
  sessionId: string;
  date: string;
  action: 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'CLOSE';
  predicate: string;
  value: string;
  temporalStatus: 'active' | 'proposed' | 'temporary' | 'historical' | 'closed';
}

export interface SimulatedUserTruth {
  userId: string;
  name: string;
  sessions: string[];
  events: SimulatedTruthEvent[];
  finalActive: Array<{ predicate: string; value: string }>;
}

export interface LongitudinalCorpusManifest {
  version: typeof LONGITUDINAL_CORPUS_VERSION;
  agentPersona: { name: string; style: string };
  generatedSessionCount: number;
  generatedMessageCount: number;
  users: SimulatedUserTruth[];
}

interface Persona {
  id: string;
  name: string;
  city: string;
  occupation: string;
  relationName: string;
  relation: string;
  relationCity: string;
  oldMedium: string;
  newMedium: string;
  destination: string;
  activity: string;
  trigger: string;
  ritual: string;
  planOutcome: 'cancel' | 'confirm';
  resolveStress: boolean;
  changeMedium: boolean;
  hasProtocol: boolean;
  hasRitual: boolean;
  assistantMisunderstands: boolean;
}

const AGENT = {
  name: '澄灯',
  style: '温暖、简洁、不抢夺用户主体性；不确定时明确询问，不把临时状态固化为人格。'
};

const PERSONAS: Persona[] = [
  { id: 'user-lin', name: '林澈', city: '杭州', occupation: '古建修复师', relationName: '林岚', relation: '姐姐', relationCity: '南京', oldMedium: '可搜索网页长文', newMedium: '装订纸册', destination: '泉州', activity: '木偶修复课', trigger: '慢灯检查', ritual: '雨窗清单', planOutcome: 'cancel', resolveStress: true, changeMedium: true, hasProtocol: true, hasRitual: true, assistantMisunderstands: false },
  { id: 'user-zhou', name: '周遥', city: '成都', occupation: '声音设计师', relationName: '宋野', relation: '大学同学', relationCity: '重庆', oldMedium: '带章节的电子书', newMedium: '纸质活页册', destination: '大理', activity: '田野录音营', trigger: '回声检查', ritual: '月末听记', planOutcome: 'confirm', resolveStress: false, changeMedium: false, hasProtocol: true, hasRitual: false, assistantMisunderstands: false },
  { id: 'user-shen', name: '沈禾', city: '苏州', occupation: '植物标本师', relationName: '顾青', relation: '表姐', relationCity: '宁波', oldMedium: '可批注PDF', newMedium: '线装笔记本', destination: '景德镇', activity: '植物釉色工作坊', trigger: '叶脉检查', ritual: '双周拾叶', planOutcome: 'cancel', resolveStress: false, changeMedium: true, hasProtocol: false, hasRitual: true, assistantMisunderstands: true },
  { id: 'user-chen', name: '陈屿', city: '青岛', occupation: '产品设计师', relationName: '陈帆', relation: '弟弟', relationCity: '天津', oldMedium: '网页长文', newMedium: '离线电子书', destination: '厦门', activity: '海图绘制课', trigger: '潮线检查', ritual: '周日潮汐复盘', planOutcome: 'confirm', resolveStress: true, changeMedium: true, hasProtocol: false, hasRitual: true, assistantMisunderstands: false }
];

const DAY_OFFSETS = [0, 8, 29, 61, 74, 103, 121, 158, 171, 206, 244, 319];

function isoAt(base: Date, dayOffset: number, messageOffset: number): string {
  return new Date(base.getTime() + dayOffset * 86_400_000 + messageOffset * 600_000).toISOString();
}

function dialogue(userTurns: string[], agentTurns: string[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return userTurns.flatMap((content, index) => [
    { role: 'user' as const, content },
    { role: 'assistant' as const, content: agentTurns[index] ?? '我听见了。' }
  ]);
}

function scenarios(persona: Persona): Array<{ user: string[]; agent: string[]; truth: Omit<SimulatedTruthEvent, 'sessionId' | 'date'>[] }> {
  return [
    {
      user: [`先正式认识一下，我叫${persona.name}。`, `我现在住在${persona.city}，已经两年了。`, `工作是${persona.occupation}，最近项目有点密。`, '这些是我的基本资料，以后相关时可以记得。'],
      agent: [`你好，${persona.name}，我是${AGENT.name}。`, `记住了，你目前在${persona.city}。`, `忙的时候我们可以把事情拆小一点。`, '好，我只在相关场景使用这些信息。'],
      truth: [
        { action: 'ADD', predicate: 'identity.full_name', value: persona.name, temporalStatus: 'active' },
        { action: 'ADD', predicate: 'entity.current_location', value: persona.city, temporalStatus: 'active' },
        { action: 'ADD', predicate: 'entity.occupation', value: persona.occupation, temporalStatus: 'active' }
      ]
    },
    {
      user: [
        `${persona.relationName}是我的${persona.relation}，我们刚聊完。`,
        `${persona.relationName}住在${persona.relationCity}，那是${persona.relationName}的所在地，不是我的。`,
        persona.assistantMisunderstands ? `不是我住在${persona.relationCity}，我仍然住在${persona.city}。` : '我们偶尔会交换近况，但不用把对方的经历算到我身上。',
        '今天只是随口提到，关系本身可以记住。'
      ],
      agent: [
        `明白，${persona.relationName}是你的${persona.relation}。`,
        persona.assistantMisunderstands ? `所以你现在住在${persona.relationCity}，对吗？` : `会区分：${persona.relationCity}属于${persona.relationName}。`,
        persona.assistantMisunderstands ? `抱歉，我刚才归属错了：你住${persona.city}，${persona.relationName}住${persona.relationCity}。` : '我会保持人物归属清楚。',
        '好。'
      ],
      truth: [
        { action: 'ADD', predicate: 'entity.relation', value: `${persona.relationName}:${persona.relation}`, temporalStatus: 'active' },
        { action: 'ADD', predicate: 'entity.current_location', value: `${persona.relationName}:${persona.relationCity}`, temporalStatus: 'active' }
      ]
    },
    {
      user: ['接收长篇资料时，我比较在意以后能不能快速查找。', `目前首选${persona.oldMedium}。`, '短消息就无所谓，不要把这个扩大成所有阅读场景。', '这是当前偏好，之后变了我会再说。'],
      agent: ['理解，这是长篇资料的媒介偏好。', `当前首选${persona.oldMedium}。`, '我会保留适用范围。', '以后以你的新说明为准。'],
      truth: [{ action: 'ADD', predicate: 'preference.medium', value: persona.oldMedium, temporalStatus: 'active' }]
    },
    {
      user: ['帮我把下面一句话润色得自然一点。', '“今天的风把窗边纸片吹乱了。”', '这只是文字任务，不是我的生活事件。', '也不用从这句话推断我的住处或心情。'],
      agent: ['可以。', '“风从窗边经过，把散放的纸片轻轻吹乱了。”', '明白，不作为你的经历记录。', '不会据此推断。'],
      truth: []
    },
    {
      user: [`我在考虑下个月去${persona.destination}参加${persona.activity}。`, '目前只是候选，车票和名额都没订。', '如果工作排不开就不去。', '先保留成备选计划，不要说成已经决定。'],
      agent: [`记作候选计划：${persona.destination}的${persona.activity}。`, '状态是未预订。', '是否成行以后再更新。', '不会当成确定行程。'],
      truth: [{ action: 'ADD', predicate: 'decision.plan', value: `${persona.destination}:${persona.activity}`, temporalStatus: 'proposed' }]
    },
    {
      user: [`刚才${persona.relationName}又发来一张${persona.relationCity}的街景。`, '我觉得很好看，但我没有搬过去。', `我还是住在${persona.city}。`, '有时聊天会反复提到别人住的地方，你要继续区分。'],
      agent: [`那是${persona.relationName}所在城市的街景。`, '不会把欣赏误写成搬家。', `你的当前所在地仍是${persona.city}。`, '我会按人物分别归属。'],
      truth: []
    },
    persona.planOutcome === 'cancel' ? {
      user: [`之前考虑的${persona.destination}${persona.activity}不去了。`, '项目排期冲突，候选计划正式取消。', '不会改日期，也不会换地点。', '请关闭那个计划，只保留变化历史。'],
      agent: ['收到。', '该候选计划已取消。', '不创建替代计划。', '只保留为历史变化。'],
      truth: [{ action: 'CLOSE', predicate: 'decision.plan', value: `${persona.destination}:${persona.activity}`, temporalStatus: 'closed' }]
    } : {
      user: [`之前考虑的${persona.destination}${persona.activity}确定要去了。`, '名额和车票已经订好。', '这不再是候选，请更新成当前计划。', '如果之后再变我会明确告诉你。'],
      agent: ['收到。', '该计划已经确认。', '会从候选更新为当前安排。', '之后按新变化继续更新。'],
      truth: [{ action: 'SUPERSEDE', predicate: 'decision.plan', value: `${persona.destination}:${persona.activity}`, temporalStatus: 'active' }]
    },
    {
      user: ['这周交付前我有点临时发怵。', '这是短期状态，不是长期性格。', '等周五交付结束就应该到期。', '现在陪我把最小一步说清楚就好。'],
      agent: ['我会把它当成这周的临时状态。', '不会固化成人格标签。', '周五后应关闭或复核。', '最小一步是先列出今天唯一要确认的风险。'],
      truth: [{ action: 'ADD', predicate: 'context.stress_state', value: '交付前临时发怵', temporalStatus: 'temporary' }]
    },
    persona.resolveStress ? {
      user: ['周五的交付已经顺利结束。', '我也恢复从容了。', '请把之前那段临时发怵关闭。', '它可以留作过去记录，但不要继续显示成当前状态。'],
      agent: ['太好了。', '现在状态已恢复。', '会关闭那段临时状态。', '当前视图不再展示它。'],
      truth: [{ action: 'CLOSE', predicate: 'context.stress_state', value: '交付前临时发怵', temporalStatus: 'closed' }]
    } : {
      user: ['交付推迟了，那段紧张还没有结束。', '它仍然只是临时状态。', '下周完成后再关闭，现在不要提前写成已恢复。', '今天先继续按短期状态处理。'],
      agent: ['明白，交付延期。', '不会固化为长期性格。', '目前保持临时状态，不提前关闭。', '等你确认完成后再更新。'],
      truth: [{ action: 'UPDATE', predicate: 'context.stress_state', value: '交付前临时发怵', temporalStatus: 'temporary' }]
    },
    persona.hasProtocol ? {
      user: [`我们建立一个长期规则，触发词是“${persona.trigger}”。`, '触发后第一步说目标，第二步列不可逆风险，第三步给最小试探。', '顺序固定，不要插入额外步骤。', '没有触发时，只给一句普通判断。'],
      agent: [`记住“${persona.trigger}”这个触发词。`, '目标、不可逆风险、最小试探。', '会保持三步顺序。', '未触发时不展开协议。'],
      truth: [{ action: 'ADD', predicate: 'relationship.ordered_protocol', value: persona.trigger, temporalStatus: 'active' }]
    } : {
      user: [`我只是举例：“${persona.trigger}”也许可以做触发词。`, '先别建立规则，我还没决定。', '后面的三步也只是草稿。', '这段讨论不要进入长期协议。'],
      agent: ['明白，只是假设。', '不会创建触发规则。', '草稿不作为正式步骤。', '不写入长期协议。'],
      truth: []
    },
    persona.hasRitual ? {
      user: [`我们设一个长期重复的小仪式，叫“${persona.ritual}”。`, '每个月最后一个周日晚上做一次。', '我说一件想守住的事和一件愿意松手的事。', '你只分别标记，不分析原因。'],
      agent: [`好，仪式叫“${persona.ritual}”。`, '时间是每月最后一个周日晚上。', '你提供“守住”和“松手”各一项。', '我只标记，不分析。'],
      truth: [{ action: 'ADD', predicate: 'relationship.ritual', value: persona.ritual, temporalStatus: 'active' }]
    } : {
      user: [`“${persona.ritual}”这个名字挺好听。`, '但我不想把它设成重复仪式。', '今天只是聊到一个名字。', '不要建立周期或固定步骤。'],
      agent: ['名字确实很有画面。', '明白，不建立仪式。', '只作为当下闲聊。', '不会创建周期规则。'],
      truth: []
    },
    {
      user: [
        persona.changeMedium ? '长篇资料的媒介偏好变了。' : '长篇资料的媒介偏好没有变化。',
        persona.changeMedium ? `现在首选${persona.newMedium}。` : `当前仍然首选${persona.oldMedium}。`,
        persona.changeMedium ? `${persona.oldMedium}只算过去的偏好，请保留变化历史。` : '这只是再次确认，不要制造一次偏好变更。',
        persona.hasRitual ? `另外，这次${persona.ritual}里我想守住规律散步，愿意松手的是囤积旧票据。` : '另外，今天写下想守住规律散步，但这不是固定仪式的一次发生。'
      ],
      agent: [
        persona.changeMedium ? '收到偏好更新。' : '收到，偏好保持不变。',
        persona.changeMedium ? `当前改为${persona.newMedium}。` : `当前仍是${persona.oldMedium}。`,
        persona.changeMedium ? `旧的${persona.oldMedium}只保留为历史。` : '不会制造虚假的变化历史。',
        persona.hasRitual ? '这次记录为：守住规律散步，松手囤积旧票据；长期仪式规则不变。' : '只作为今天的普通记录，不关联长期仪式。'
      ],
      truth: [
        { action: persona.changeMedium ? 'SUPERSEDE' : 'UPDATE', predicate: 'preference.medium', value: persona.changeMedium ? persona.newMedium : persona.oldMedium, temporalStatus: 'active' },
        ...(persona.hasRitual ? [{ action: 'ADD' as const, predicate: 'episode.ritual_occurrence', value: `${persona.ritual}:守住规律散步:松手囤积旧票据`, temporalStatus: 'historical' as const }] : [])
      ]
    }
  ];
}

export function generateLongitudinalCompanionCorpus(rootDir: string): LongitudinalCorpusManifest {
  if (fs.existsSync(rootDir) && fs.readdirSync(rootDir).length > 0) throw new Error(`Refusing to overwrite non-empty corpus directory: ${rootDir}`);
  fs.mkdirSync(rootDir, { recursive: true });
  const manifestPath = path.join(rootDir, 'truth-ledger.json');

  const base = new Date('2030-01-06T09:00:00.000Z');
  const users: SimulatedUserTruth[] = [];
  let generatedMessageCount = 0;

  PERSONAS.forEach((persona, personaIndex) => {
    const userDir = path.join(rootDir, persona.id);
    fs.mkdirSync(userDir, { recursive: true });
    const sessions: string[] = [];
    const events: SimulatedTruthEvent[] = [];

    scenarios(persona).forEach((scenario, scenarioIndex) => {
      const sessionId = `${persona.id}-s${String(scenarioIndex + 1).padStart(2, '0')}`;
      const dayOffset = personaIndex * 3 + DAY_OFFSETS[scenarioIndex];
      const date = isoAt(base, dayOffset, 0).slice(0, 10);
      const withFiller = (personaIndex + scenarioIndex) % 3 === 0;
      const messages = dialogue(
        withFiller ? [...scenario.user, '先聊到这里，晚点有新情况我再告诉你。'] : scenario.user,
        withFiller ? [...scenario.agent, '好，我不会替你补全还没发生的部分。'] : scenario.agent
      );
      const filePath = path.join(userDir, `${sessionId}.jsonl`);
      const lines = messages.map((message, messageIndex) => JSON.stringify({
        id: `${sessionId}-m${String(messageIndex + 1).padStart(2, '0')}`,
        session_id: sessionId,
        timestamp: isoAt(base, dayOffset, messageIndex),
        cwd: `/simulated-companion/${persona.id}`,
        role: message.role,
        content: message.content
      }));
      fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
      generatedMessageCount += messages.length;
      sessions.push(sessionId);
      events.push(...scenario.truth.map(item => ({ ...item, sessionId, date })));
    });

    users.push({
      userId: persona.id,
      name: persona.name,
      sessions,
      events,
      finalActive: [
        { predicate: 'identity.full_name', value: persona.name },
        { predicate: 'entity.current_location', value: persona.city },
        { predicate: 'entity.occupation', value: persona.occupation },
        { predicate: 'entity.relation', value: `${persona.relationName}:${persona.relation}` },
        { predicate: 'preference.medium', value: persona.changeMedium ? persona.newMedium : persona.oldMedium },
        ...(persona.hasProtocol ? [{ predicate: 'relationship.ordered_protocol', value: persona.trigger }] : []),
        ...(persona.hasRitual ? [{ predicate: 'relationship.ritual', value: persona.ritual }] : []),
        ...(persona.planOutcome === 'confirm' ? [{ predicate: 'decision.plan', value: `${persona.destination}:${persona.activity}` }] : []),
        ...(!persona.resolveStress ? [{ predicate: 'context.stress_state', value: '交付前临时发怵' }] : [])
      ]
    });
  });

  const manifest: LongitudinalCorpusManifest = {
    version: LONGITUDINAL_CORPUS_VERSION,
    agentPersona: AGENT,
    generatedSessionCount: users.reduce((sum, user) => sum + user.sessions.length, 0),
    generatedMessageCount,
    users
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}
