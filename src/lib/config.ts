import type { Address, Hex } from 'viem';

const DEFAULT_RATE_MANAGER_ADDRESS = '0xeEd7Db23e724aC4590D6dB6F78fDa6DB203535F3';

export const appConfig = {
  appName: import.meta.env.VITE_APP_NAME || 'Peer Vaults',
  rpcUrl: import.meta.env.VITE_BASE_RPC_URL || 'https://mainnet.base.org',
  runtimeEnv: (import.meta.env.VITE_PEER_RUNTIME_ENV || 'production') as
    | 'production'
    | 'preproduction'
    | 'staging',
  rateManagerAddress: (import.meta.env.VITE_PEER_RATE_MANAGER_ADDRESS ||
    DEFAULT_RATE_MANAGER_ADDRESS) as Address,
  vaultId: (import.meta.env.VITE_PEER_VAULT_ID || '') as Hex | '',
  basescanUrl: 'https://basescan.org',
};
