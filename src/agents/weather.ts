import { PORTS } from '../config.js';
import { makeWorkerExecutor, type AgentDefinition } from './base.js';

const CITIES: Record<string, string> = {
  tokyo: 'Tokyo',
  東京: 'Tokyo',
  osaka: 'Osaka',
  大阪: 'Osaka',
  kyoto: 'Kyoto',
  京都: 'Kyoto',
  sapporo: 'Sapporo',
  札幌: 'Sapporo',
  fukuoka: 'Fukuoka',
  福岡: 'Fukuoka',
  naha: 'Naha',
  那覇: 'Naha',
  london: 'London',
  ロンドン: 'London',
  paris: 'Paris',
  パリ: 'Paris',
  'new york': 'New York',
  ニューヨーク: 'New York',
};

const CONDITIONS = ['☀️ Sunny', '⛅ Partly cloudy', '☁️ Cloudy', '🌧️ Rain', '⛈️ Thunderstorm', '🌫️ Fog'];

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
      `unsupported city. Available: ${[...new Set(Object.values(CITIES))].join(', ')}`
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
  return `Weather in ${city} (${date}): ${condition} / ${temp}°C / humidity ${humidity}%`;
}

export const weatherAgent: AgentDefinition = {
  name: 'Weather Agent',
  slug: 'weather',
  description: 'Mock weather agent returning deterministic forecasts per city and date',
  port: PORTS.weather,
  discoveryQueries: [
    'weather forecast temperature for a city',
    'get today weather humidity in tokyo',
  ],
  skills: [
    {
      id: 'forecast',
      name: 'Weather Forecast',
      description: 'Return a mock same-day forecast (condition, temperature, humidity) for supported cities',
      tags: ['weather', 'forecast'],
      examples: ['weather in Tokyo', '東京の天気'],
    },
  ],
  executor: makeWorkerExecutor({
    workingNote: 'Fetching observation data...',
    delayMs: [600, 1300],
    handle: (input) => ({ text: forecast(input), artifactName: 'forecast.txt' }),
  }),
};
