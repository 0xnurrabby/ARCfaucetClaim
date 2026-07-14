# Arc Faucet Claim

Local tool for Arc Testnet builders:

- Import many wallet private keys
- Claim Circle testnet USDC with CapSolver (reCAPTCHA)
- Run up to **30 parallel Chrome browsers**
- Skip wallets that already claimed in the last **2 hours** (Alchemy / RPC history)
- Auto-drain USDC to your vault wallet

## Requirements

- Node.js 18+
- Google Chrome (recommended) or Playwright Chromium
- [CapSolver](https://dashboard.capsolver.com/) API key
- Optional: [Alchemy](https://www.alchemy.com/) Arc Testnet RPC for better 2h history checks

## Quick start

```bash
git clone https://github.com/0xnurrabby/ARCfaucetClaim.git
cd ARCfaucetClaim
npm install
npm run dev
```

Open **http://localhost:5173**

`npm run dev` starts:

1. Web UI (Vite)
2. Local bot API on `http://127.0.0.1:8787`

## First-time setup in the UI

1. Paste **CapSolver API key**
2. Paste **Alchemy / Arc RPC URL** (optional but recommended)
3. Set **Destination vault** address
4. Set **Parallel browsers** (1-30)
5. Click **Save settings**

Settings are stored in:

- Browser `localStorage` (UI)
- Project `.env` (bot process)

## Usage

1. Paste private keys (one per line) → **Import**
2. Click **Run queue**
3. Flow per wallet:
   - Drain existing USDC (if any)
   - Check 2h rate limit
   - Claim faucet (CapSolver solves captcha)
   - Wait for balance
   - Drain to vault

Rate-limited wallets are marked **skipped** and the queue continues.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | UI + bot together |
| `npm run web` | UI only |
| `npm run bot` | Bot only |
| `npm run build` | Production build |

## Environment variables

Copy `.env.example` to `.env` if you prefer file-based config:

```env
CAPSOLVER_API_KEY=CAP-xxxxxxxx
ARC_RPC_URL=https://arc-testnet.g.alchemy.com/v2/YOUR_KEY
```

You can also set these from the website **Settings** panel.

## Security

- Use **throwaway testnet keys only**
- Never commit `.env` or real secrets
- Keys in the UI stay in your browser session / localStorage
- Bot only listens on localhost (`127.0.0.1:8787`)

## Notes

- Circle faucet limit: about **20 USDC per address per network every 2 hours**
- On Arc, **USDC is gas**. Transfers keep a small reserve so txs do not revert
- Captcha solving is the slow step; CapSolver balance is required

## License

MIT
