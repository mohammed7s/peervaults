# PeerVaults

This repo now contains two things:

- a script-first vault creation flow in [`scripts/create-vault.ts`](/home/ubuntu/Dropbox/WEB/peer.xyz/scripts/create-vault.ts)
- a small React manager dashboard for day-to-day vault operations

## Commands

Install dependencies:

```bash
pnpm install
```

Run the manager app locally:

```bash
pnpm dev
```

Build the manager app:

```bash
pnpm build
```

Dry-run vault creation:

```bash
pnpm create:vault
```

Broadcast vault creation:

```bash
pnpm create:vault -- --broadcast
```

## Frontend env

Add these to your local `.env`:

```env
VITE_APP_NAME=PeerVaults
VITE_BASE_RPC_URL=https://mainnet.base.org
VITE_PEER_RUNTIME_ENV=production
VITE_PEER_RATE_MANAGER_ADDRESS=0xeEd7Db23e724aC4590D6dB6F78fDa6DB203535F3

# Optional fallback only
VITE_PEER_VAULT_ID=
```

Notes:

- only `VITE_` variables are exposed to the browser
- the manager dashboard looks up vaults for the connected wallet and auto-selects one
- `VITE_PEER_VAULT_ID` is now only a fallback override
- reads come from the vault contract directly
- writes go through `@zkp2p/sdk`

## Current scope

The manager app currently supports:

- wallet connect on Base
- live vault config display
- single rate updates
- batched rate updates through a multi-line editor
- Coinbase-backed USDC market-rate import with optional spread in basis points
- indexed existing-rate table with quick reload into the editor
- disabling a pair by setting rate to `0`
- fee updates
- vault metadata/config updates
