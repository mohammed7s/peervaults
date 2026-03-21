import 'dotenv/config';

import { Zkp2pClient } from '@zkp2p/sdk';
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  parseEventLogs,
  parseUnits,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const RATE_MANAGER_CREATED_ABI = parseAbi([
  'event RateManagerCreated(bytes32 indexed rateManagerId, address indexed manager, address indexed feeRecipient, uint256 maxFee, uint256 fee, string name, string uri)',
]);

const USDC_DECIMALS = 6;
const WAD_DECIMALS = 18;

type CliArgs = {
  broadcast: boolean;
  help?: boolean;
  name?: string;
  uri?: string;
  manager?: Address;
  feeRecipient?: Address;
  feePercent?: string;
  maxFeePercent?: string;
  minLiquidityUsdc?: string;
  runtimeEnv?: 'production' | 'preproduction' | 'staging' | string;
};

function printHelp() {
  console.log(`
Create a Peer vault with @zkp2p/sdk.

Usage:
  npm run create:vault -- [--dry-run] [--broadcast] [--name "My Vault"] [--uri "https://..."]
    [--manager 0x...] [--fee-recipient 0x...] [--fee-percent 0.10]
    [--max-fee-percent 2.00] [--min-liquidity-usdc 1000]
    [--runtime-env production]

Notes:
  - Dry run is the default. It prepares the transaction and estimates gas.
  - Use --broadcast only after reviewing the preflight summary.
  - FEE_PERCENT and MAX_FEE_PERCENT are human percentages.
  - MIN_LIQUIDITY_USDC is a human USDC amount.
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { broadcast: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--broadcast') {
      args.broadcast = true;
      continue;
    }

    if (arg === '--dry-run') {
      args.broadcast = false;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split('=');
    const key = rawKey
      .split('-')
      .map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1)))
      .join('') as keyof CliArgs;

    const value = inlineValue ?? argv[i + 1];

    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    args[key] = value as never;

    if (inlineValue == null) {
      i += 1;
    }
  }

  return args;
}

function requireValue(name: string, value: string | undefined): string {
  if (value == null || value === '') {
    throw new Error(`Missing required value: ${name}`);
  }

  return value;
}

function percentToWad(percent: string): bigint {
  return parseUnits(percent, WAD_DECIMALS) / 100n;
}

function usdcToBaseUnits(amount: string): bigint {
  return parseUnits(amount, USDC_DECIMALS);
}

function formatPercentFromWad(value: bigint): string {
  return `${formatUnits(value * 100n, WAD_DECIMALS)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const rpcUrl = requireValue('BASE_RPC_URL', process.env.BASE_RPC_URL);
  const privateKey = requireValue('PRIVATE_KEY', process.env.PRIVATE_KEY);
  const runtimeEnv = (args.runtimeEnv ?? process.env.RUNTIME_ENV ?? 'production') as
    | 'production'
    | 'preproduction'
    | 'staging';

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const manager = (args.manager ?? process.env.MANAGER_ADDRESS ?? account.address) as Address;
  const feeRecipient = (args.feeRecipient ?? process.env.FEE_RECIPIENT ?? manager) as Address;
  const feePercentInput = args.feePercent ?? process.env.FEE_PERCENT ?? '0';
  const maxFeePercentInput = args.maxFeePercent ?? process.env.MAX_FEE_PERCENT ?? '0';
  const name = requireValue('VAULT_NAME or --name', args.name ?? process.env.VAULT_NAME);
  const uri = requireValue('VAULT_URI or --uri', args.uri ?? process.env.VAULT_URI);
  const minLiquidityUsdc = args.minLiquidityUsdc ?? process.env.MIN_LIQUIDITY_USDC ?? '0';

  const fee = percentToWad(feePercentInput);
  const maxFee = percentToWad(maxFeePercentInput);
  const minLiquidity = usdcToBaseUnits(minLiquidityUsdc);

  if (fee > maxFee) {
    throw new Error(`FEE_PERCENT (${feePercentInput}%) cannot be greater than MAX_FEE_PERCENT (${maxFeePercentInput}%).`);
  }

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  const client = new Zkp2pClient({
    walletClient,
    chainId: base.id,
    runtimeEnv,
  });

  const params = {
    config: {
      manager,
      feeRecipient,
      maxFee,
      fee,
      minLiquidity,
      name,
      uri,
    },
  };

  const prepared = await client.createRateManager.prepare(params);
  const gasEstimate = await publicClient.estimateGas({
    account: account.address,
    to: prepared.to,
    data: prepared.data,
    value: prepared.value ?? 0n,
  });

  console.log('Preflight Summary');
  console.log(`- caller: ${account.address}`);
  console.log(`- manager: ${manager}`);
  console.log(`- fee recipient: ${feeRecipient}`);
  console.log(`- fee: ${formatPercentFromWad(fee)} (${fee})`);
  console.log(`- max fee: ${formatPercentFromWad(maxFee)} (${maxFee})`);
  console.log(`- min liquidity: ${formatUnits(minLiquidity, USDC_DECIMALS)} USDC (${minLiquidity})`);
  console.log(`- name: ${name}`);
  console.log(`- uri: ${uri}`);
  console.log(`- runtime env: ${runtimeEnv}`);
  console.log(`- mode: ${args.broadcast ? 'broadcast' : 'dry run'}`);
  console.log('');
  console.log('Prepared transaction');
  console.log(`- to: ${prepared.to}`);
  console.log(`- chainId: ${prepared.chainId}`);
  console.log(`- estimated gas: ${gasEstimate}`);
  console.log(`- data: ${prepared.data}`);
  console.log('');

  if (!args.broadcast) {
    console.log('Dry run complete. Re-run with --broadcast to create the vault.');
    return;
  }

  console.log('Broadcast requested. Sending the transaction using the preflight config above.');
  const hash = await client.createRateManager(params);
  console.log(`Transaction sent: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const events = parseEventLogs({
    abi: RATE_MANAGER_CREATED_ABI,
    eventName: 'RateManagerCreated',
    logs: receipt.logs,
    strict: false,
  });

  console.log(`Transaction confirmed in block ${receipt.blockNumber}.`);

  const createdEvent = events[0];

  if (createdEvent?.args.rateManagerId) {
    console.log(`Vault created. rateManagerId: ${createdEvent.args.rateManagerId}`);
  } else {
    console.log('Vault created, but rateManagerId was not parsed from the receipt logs.');
  }
}

main().catch((error) => {
  console.error('');
  console.error('Vault creation failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
