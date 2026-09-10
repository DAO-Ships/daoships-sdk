// Opt-in local EVM only: reuse sibling tooling without loading its dotenv/network config.
const path = require('node:path');
const { createRequire } = require('node:module');
const contractsRoot = path.resolve(__dirname, '../../daoships-contracts');
const fromContracts = createRequire(path.join(contractsRoot, 'package.json'));
fromContracts('@nomicfoundation/hardhat-ethers');
module.exports = {
  defaultNetwork: 'hardhat',
  solidity: '0.8.22',
  networks: { hardhat: { chainId: 1337, allowUnlimitedContractSize: false } },
  paths: { sources: path.join(contractsRoot, 'contracts'), artifacts: path.join(contractsRoot, 'artifacts'), cache: path.resolve(__dirname, '../.local-hardhat-cache') },
};
