const env = (key: string, fallback: number): number =>
  process.env[key] ? Number(process.env[key]) : fallback;

export const PORTS = {
  gateway: env('SIM_GATEWAY_PORT', 4600),
  evm: env('SIM_EVM_PORT', 41237),
  chain: env('SIM_CHAIN_PORT', 41238),
  registry: env('SIM_REGISTRY_PORT', 41239),
  orchestrator: env('SIM_ORCHESTRATOR_PORT', 41240),
  translator: env('SIM_TRANSLATOR_PORT', 41241),
  calculator: env('SIM_CALCULATOR_PORT', 41242),
  weather: env('SIM_WEATHER_PORT', 41243),
} as const;

export const agentUrl = (port: number): string => `http://localhost:${port}`;
