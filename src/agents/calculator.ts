import { PORTS } from '../config.js';
import { makeWorkerExecutor, type AgentDefinition } from './base.js';

function calculate(raw: string): string {
  const expr = (raw.match(/[-\d(][\d+\-*/().%\s]*/)?.[0] ?? '').trim();
  if (!expr || !/\d/.test(expr)) throw new Error(`数式が見つかりません: "${raw}"`);
  if (!/^[\d+\-*/().%\s]+$/.test(expr)) throw new Error(`不正な文字を含む式です: "${expr}"`);

  let result: unknown;
  try {
    result = new Function(`"use strict"; return (${expr});`)();
  } catch {
    throw new Error(`式を評価できません: "${expr}"`);
  }
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error(`計算結果が数値になりません: "${expr}"`);
  }
  return `${expr} = ${result}`;
}

export const calculatorAgent: AgentDefinition = {
  name: 'Calculator Agent',
  description: '四則演算の式を評価する計算エージェント',
  port: PORTS.calculator,
  skills: [
    {
      id: 'calculate',
      name: 'Calculate',
      description: '四則演算 (+ - * / % 括弧) の式を評価して結果を返す',
      tags: ['math', 'calculator'],
      examples: ['calc (2+3)*4', '計算: 100/8'],
    },
  ],
  executor: makeWorkerExecutor({
    workingNote: '式を解析して計算中...',
    delayMs: [300, 700],
    handle: (input) => ({ text: calculate(input), artifactName: 'calculation.txt' }),
  }),
};
