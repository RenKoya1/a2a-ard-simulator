import { PORTS } from '../config.js';
import { makeWorkerExecutor, type AgentDefinition } from './base.js';

function calculate(raw: string): string {
  const expr = (raw.match(/[-\d(][\d+\-*/().%\s]*/)?.[0] ?? '').trim();
  if (!expr || !/\d/.test(expr)) throw new Error(`no arithmetic expression found in: "${raw}"`);
  if (!/^[\d+\-*/().%\s]+$/.test(expr)) throw new Error(`expression contains invalid characters: "${expr}"`);

  let result: unknown;
  try {
    result = new Function(`"use strict"; return (${expr});`)();
  } catch {
    throw new Error(`cannot evaluate expression: "${expr}"`);
  }
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error(`result is not a finite number: "${expr}"`);
  }
  return `${expr} = ${result}`;
}

export const calculatorAgent: AgentDefinition = {
  name: 'Calculator Agent',
  slug: 'calculator',
  description: 'Arithmetic agent that evaluates basic math expressions',
  port: PORTS.calculator,
  discoveryQueries: [
    'evaluate arithmetic expression calculator math',
    'calculate a math formula with parentheses',
  ],
  skills: [
    {
      id: 'calculate',
      name: 'Calculate',
      description: 'Evaluate arithmetic expressions (+ - * / % and parentheses)',
      tags: ['math', 'calculator'],
      examples: ['calc (2+3)*4', 'calculate 100/8'],
    },
  ],
  executor: makeWorkerExecutor({
    workingNote: 'Parsing and evaluating expression...',
    delayMs: [300, 700],
    handle: (input) => ({ text: calculate(input), artifactName: 'calculation.txt' }),
  }),
};
