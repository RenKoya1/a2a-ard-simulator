import { PORTS } from '../config.js';
import { makeWorkerExecutor, type AgentDefinition } from './base.js';

const EN_TO_JA: Record<string, string> = {
  hello: 'こんにちは',
  world: '世界',
  good: '良い',
  morning: '朝',
  night: '夜',
  thanks: 'ありがとう',
  'thank you': 'ありがとうございます',
  cat: '猫',
  dog: '犬',
  weather: '天気',
  agent: 'エージェント',
  protocol: 'プロトコル',
  simulation: 'シミュレーション',
  friend: '友達',
  water: '水',
  fire: '火',
  love: '愛',
  peace: '平和',
};

const JA_TO_EN: Record<string, string> = Object.fromEntries(
  Object.entries(EN_TO_JA).map(([en, ja]) => [ja, en])
);

function translate(raw: string): string {
  // Strip routing keywords the orchestrator may leave in.
  const input = raw
    .replace(/^(翻訳|translate)[::\s]*/i, '')
    .replace(/[「」]/g, '')
    .trim();
  if (!input) throw new Error('no text to translate');

  const hasJapanese = /[぀-ヿ一-鿿]/.test(input);
  if (hasJapanese) {
    const words = Object.keys(JA_TO_EN).filter((ja) => input.includes(ja));
    const out = words.length
      ? words.reduce((acc, ja) => acc.replace(new RegExp(ja, 'g'), ` ${JA_TO_EN[ja]} `), input)
      : `[no dictionary match] ${input}`;
    return `JA→EN: 「${input}」 → "${out.replace(/\s+/g, ' ').trim()}"`;
  }

  const out = input
    .toLowerCase()
    .split(/\s+/)
    .map((w) => EN_TO_JA[w.replace(/[^a-z']/g, '')] ?? `[${w}]`)
    .join(' ');
  return `EN→JA: "${input}" → 「${out}」`;
}

export const translatorAgent: AgentDefinition = {
  name: 'Translator Agent',
  slug: 'translator',
  description: 'Mock dictionary-based Japanese/English translator agent',
  port: PORTS.translator,
  discoveryQueries: [
    'translate text between japanese and english',
    'translate hello world to japanese',
  ],
  skills: [
    {
      id: 'translate',
      name: 'Translate',
      description: 'Translate text between Japanese and English (unknown words shown as [word])',
      tags: ['translation', 'ja', 'en'],
      examples: ['translate hello world', '「こんにちは 世界」を翻訳'],
    },
  ],
  executor: makeWorkerExecutor({
    workingNote: 'Looking up dictionary and translating...',
    delayMs: [400, 900],
    handle: (input) => ({ text: translate(input), artifactName: 'translation.txt' }),
  }),
};
