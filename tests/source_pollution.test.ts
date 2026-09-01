import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [fullPath] : [];
  });
}

describe('Companion source has no benchmark or known-holdout pollution', () => {
  const sourceRoot = path.join(process.cwd(), 'src', 'companion');
  const files = sourceFiles(sourceRoot);

  const entityAndLocationTokens = [
    '林屿', '阿岚', '小屿', '团子', '周辰', '沈知', '徐锐', '桥灯', '林乔', '阿言',
    '陈澈', '星野', '阿澈', '布丁', '王恺', '陈洵', '陆航', '李慧', '幻境工作室',
    '杭州', '北京', '上海', '成都', '重庆', '广州'
  ];
  const fixtureSpecificPhrases = [
    '抱抱版还是拆解版',
    '顺毛版还是复盘版',
    '山里起雾前的风',
    '夜航飞行员眼中的星海',
    'HR薛定谔邮件',
    '拆迁队长',
    '先把鞋放门口',
    '无休止改图',
    '原画主设',
    '成都高新区',
    '已彻底痊愈',
    '无后遗症',
    '顺利恢复健康',
    '和平分手'
  ];
  const structuralPatterns = [
    { name: 'benchmark session/message ID', regex: /\bS(?:0[1-9]|[12]\d|3[0-2])(?:-U\d{2})?\b/g },
    { name: 'fixed benchmark episode ID', regex: /\bEM-0[1-8]\b/g },
    { name: 'benchmark item dispatch ID', regex: /\b(?:UM|RM|CI|CC)-\d{2}\b/g }
  ];

  it('recursively scans every current and future source file', () => {
    const relative = files.map(file => path.relative(process.cwd(), file));
    for (const required of ['evaluator.ts', 'engine.ts', 'extractor.ts', 'probes.ts', 'reducer.ts', 'renderer.ts', 'schema.ts']) {
      assert.ok(relative.includes(`src/companion/${required}`), `Recursive scan must include src/companion/${required}`);
    }
  });

  for (const file of files) {
    const relative = path.relative(process.cwd(), file);
    it(`${relative} contains no fixture entities, phrases, or structural IDs`, () => {
      const content = fs.readFileSync(file, 'utf8');
      const tokenMatches = [...entityAndLocationTokens, ...fixtureSpecificPhrases].filter(token => content.includes(token));
      const structuralMatches = structuralPatterns.flatMap(pattern => {
        pattern.regex.lastIndex = 0;
        return [...content.matchAll(pattern.regex)].map(match => `${pattern.name}:${match[0]}`);
      });
      assert.deepEqual([...tokenMatches, ...structuralMatches], [], `Pollution found in ${relative}`);
    });
  }
});
