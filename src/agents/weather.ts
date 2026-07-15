import { PORTS } from '../config.js';
import { makeWorkerExecutor, type AgentDefinition } from './base.js';

const CITIES: Record<string, string> = {
  tokyo: '東京',
  東京: '東京',
  osaka: '大阪',
  大阪: '大阪',
  kyoto: '京都',
  京都: '京都',
  sapporo: '札幌',
  札幌: '札幌',
  fukuoka: '福岡',
  福岡: '福岡',
  naha: '那覇',
  那覇: '那覇',
  london: 'ロンドン',
  ロンドン: 'ロンドン',
  paris: 'パリ',
  パリ: 'パリ',
  'new york': 'ニューヨーク',
  ニューヨーク: 'ニューヨーク',
};

const CONDITIONS = ['☀️ 晴れ', '⛅ 晴れ時々くもり', '☁️ くもり', '🌧️ 雨', '⛈️ 雷雨', '🌫️ 霧'];

// Deterministic per city+date so repeated queries agree within a day.
function pseudoRandom(seed: string): number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

function forecast(raw: string): string {
  const input = raw.toLowerCase();
  const key = Object.keys(CITIES).find((c) => input.includes(c));
  if (!key) {
    throw new Error(
      `対応していない都市です。利用可能: ${[...new Set(Object.values(CITIES))].join(', ')}`
    );
  }
  const city = CITIES[key];
  const date = new Date().toISOString().slice(0, 10);
  const r1 = pseudoRandom(`${city}:${date}:cond`);
  const r2 = pseudoRandom(`${city}:${date}:temp`);
  const r3 = pseudoRandom(`${city}:${date}:hum`);
  const condition = CONDITIONS[Math.floor(r1 * CONDITIONS.length)];
  const temp = Math.round(12 + r2 * 20);
  const humidity = Math.round(35 + r3 * 55);
  return `${city}の天気 (${date}): ${condition} / 気温 ${temp}℃ / 湿度 ${humidity}%`;
}

export const weatherAgent: AgentDefinition = {
  name: 'Weather Agent',
  description: '都市名から模擬天気予報を返すエージェント(決定的な擬似乱数)',
  port: PORTS.weather,
  skills: [
    {
      id: 'forecast',
      name: 'Weather Forecast',
      description: '対応都市の当日の模擬天気(天候・気温・湿度)を返す',
      tags: ['weather', 'forecast'],
      examples: ['東京の天気', 'weather in London'],
    },
  ],
  executor: makeWorkerExecutor({
    workingNote: '観測データを取得中...',
    delayMs: [600, 1300],
    handle: (input) => ({ text: forecast(input), artifactName: 'forecast.txt' }),
  }),
};
