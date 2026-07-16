import type { HardhatUserConfig } from 'hardhat/config';
import hardhatToolboxMochaEthers from '@nomicfoundation/hardhat-toolbox-mocha-ethers';

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: '0.8.36',
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  paths: {
    tests: { mocha: './test/contracts' },
  },
};

export default config;
