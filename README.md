# GrimSwap Integration Tests

End-to-end integration tests for GrimSwap ZK private swaps on Uniswap v4.

## Latest Test Results

### Full ZK Private Swap with Relayer - PRODUCTION READY

**Date:** February 5, 2026
**Network:** Unichain Sepolia (Chain ID: 1301)
**Status:** ✅ SUCCESS - Tokens transferred to stealth address

| Test | Amount | Received | TX Hash |
|------|--------|----------|---------|
| ZK Swap + Relayer | 50 tokens | **49.68 tokens** | [`0x4d3bab7a...`](https://unichain-sepolia.blockscout.com/tx/0x4d3bab7a47e56caf615fc84e78c7ddfc6712571a5fe27bba798f1b4c079d6876) |

#### Privacy Achieved
- ✅ **Sender Hidden**: ZK proof proves deposit without revealing which one
- ✅ **Recipient Hidden**: Stealth address unlinkable to user
- ✅ **Gas Payer Hidden**: Relayer submits tx (user wallet never appears on-chain)
- ✅ **Double-spend Prevented**: Nullifier marked as spent

#### Performance
| Step | Time |
|------|------|
| Create deposit note | ~1 ms |
| Build Merkle tree | ~5 ms |
| Add root to GrimPool | ~5s |
| **Generate ZK proof** | **~1 second** |
| Relayer submission | ~5s |
| **TOTAL** | **~15-20 seconds** |

---

## Deployed Contracts V2 (Unichain Sepolia)

| Contract | Address | Description |
|----------|---------|-------------|
| **GrimPool V2** | [`0x023F6b2Bb485A9c77F1b3e4009E58064E53414b9`](https://unichain-sepolia.blockscout.com/address/0x023F6b2Bb485A9c77F1b3e4009E58064E53414b9) | Deposit pool with Merkle tree |
| **GrimSwapZK V2** | [`0xc52c297f4f0d0556b1cd69b655F23df2513eC0C4`](https://unichain-sepolia.blockscout.com/address/0xc52c297f4f0d0556b1cd69b655F23df2513eC0C4) | Uniswap v4 hook (production) |
| **Groth16Verifier** | [`0xF7D14b744935cE34a210D7513471a8E6d6e696a0`](https://unichain-sepolia.blockscout.com/address/0xF7D14b744935cE34a210D7513471a8E6d6e696a0) | ZK proof verification |
| **PoolHelper** | [`0x0f8113EfA5527346978534192a76C94a567cae42`](https://unichain-sepolia.blockscout.com/address/0x0f8113EfA5527346978534192a76C94a567cae42) | Swap router |
| PoolManager | [`0x00B036B58a818B1BC34d502D3fE730Db729e62AC`](https://unichain-sepolia.blockscout.com/address/0x00B036B58a818B1BC34d502D3fE730Db729e62AC) | Uniswap v4 PoolManager |

### Test Tokens
| Token | Address |
|-------|---------|
| Token A | `0x48bA64b5312AFDfE4Fc96d8F03010A0a86e17963` |
| Token B | `0x96aC37889DfDcd4dA0C898a5c9FB9D17ceD60b1B` |

---

## Frontend Integration Guide

### Overview

The frontend needs to:
1. Generate proof **locally** (in browser/client) - private inputs never leave the device
2. Send proof to relayer API
3. Relayer submits transaction on-chain

### Step-by-Step Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Frontend Integration Flow                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  BROWSER/CLIENT (all private data stays here)                        │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 1. Create deposit note (Poseidon hash)                      │    │
│  │    commitment = Poseidon(nullifier, secret, amount)         │    │
│  │                                                              │    │
│  │ 2. Build local Merkle tree                                   │    │
│  │    - Insert commitment as leaf                               │    │
│  │    - Generate Merkle proof (path to root)                    │    │
│  │                                                              │    │
│  │ 3. Generate stealth address                                  │    │
│  │    - Random private key → stealth address                    │    │
│  │                                                              │    │
│  │ 4. Generate ZK proof (~1 second)                             │    │
│  │    - Uses snarkjs with WASM prover                           │    │
│  │    - Private inputs: secret, nullifier, Merkle path          │    │
│  │    - Public inputs: root, nullifierHash, recipient, relayer  │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│                              ▼                                       │
│  RELAYER API (only receives proof + public data)                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ POST /relay                                                  │    │
│  │ {                                                            │    │
│  │   proof: { a, b, c },      // ZK proof                       │    │
│  │   publicSignals: [...],     // 8 public values               │    │
│  │   swapParams: { poolKey, zeroForOne, amount, priceLimit }    │    │
│  │ }                                                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│                              ▼                                       │
│  BLOCKCHAIN                                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ GrimSwapZK Hook:                                             │    │
│  │   1. Verify ZK proof on-chain                                │    │
│  │   2. Mark nullifier as spent                                 │    │
│  │   3. Execute swap on Uniswap v4                              │    │
│  │   4. Transfer tokens to stealth address                      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│                              ▼                                       │
│  STEALTH ADDRESS receives tokens (unlinkable to user)                │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Code Example (TypeScript/Browser)

```typescript
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

// 1. Initialize Poseidon
const poseidon = await buildPoseidon();
const F = poseidon.F;

// 2. Create deposit note
const secret = randomFieldElement();
const nullifier = randomFieldElement();
const amount = parseEther("50"); // 50 tokens

const commitment = poseidonHash([nullifier, secret, amount]);
const nullifierHash = poseidonHash([nullifier]);

// 3. Build Merkle tree and get proof
const tree = new PoseidonMerkleTree(20); // 20 levels
await tree.initialize();
await tree.insert(commitment);
const merkleProof = tree.getProof(0);

// 4. Generate stealth address
const stealthPrivateKey = randomFieldElement();
const stealthAddress = deriveAddress(stealthPrivateKey);

// 5. Get relayer info
const relayerInfo = await fetch("http://relayer.grimswap.xyz/info").then(r => r.json());
const relayerAddress = relayerInfo.address;
const relayerFeeBps = 10; // 0.1%

// 6. Generate ZK proof (runs in browser!)
const input = {
  merkleRoot: merkleProof.root.toString(),
  nullifierHash: nullifierHash.toString(),
  recipient: BigInt(stealthAddress).toString(),
  relayer: BigInt(relayerAddress).toString(),
  relayerFee: relayerFeeBps.toString(),
  swapAmountOut: amount.toString(),
  secret: secret.toString(),
  nullifier: nullifier.toString(),
  depositAmount: amount.toString(),
  pathElements: merkleProof.pathElements.map(e => e.toString()),
  pathIndices: merkleProof.pathIndices,
};

const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  input,
  "/circuits/privateSwap.wasm",  // Host these files
  "/circuits/privateSwap.zkey"
);

// 7. Send to relayer
const response = await fetch("http://relayer.grimswap.xyz/relay", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    proof: {
      a: [proof.pi_a[0], proof.pi_a[1]],
      b: [
        [proof.pi_b[0][0], proof.pi_b[0][1]],
        [proof.pi_b[1][0], proof.pi_b[1][1]],
      ],
      c: [proof.pi_c[0], proof.pi_c[1]],
    },
    publicSignals,
    swapParams: {
      poolKey: {
        currency0: "0x48bA64b5312AFDfE4Fc96d8F03010A0a86e17963",
        currency1: "0x96aC37889DfDcd4dA0C898a5c9FB9D17ceD60b1B",
        fee: 3000,
        tickSpacing: 60,
        hooks: "0xc52c297f4f0d0556b1cd69b655F23df2513eC0C4",
      },
      zeroForOne: false, // TokenB -> TokenA
      amountSpecified: (-amount).toString(),
      sqrtPriceLimitX96: MAX_SQRT_PRICE.toString(),
    },
  }),
});

const result = await response.json();
console.log("TX:", result.txHash);
// Stealth address now has tokens!
```

### Relayer API

**Base URL:** `http://localhost:3001` (dev) / `https://relayer.grimswap.xyz` (prod)

#### GET /health
```json
{ "status": "healthy" }
```

#### GET /info
```json
{
  "address": "0x25f75573799A3Aa37760D6bE4b862acA70599b49",
  "chain": "Unichain Sepolia",
  "chainId": 1301,
  "feeBps": 10,
  "balance": "75965991949426348"
}
```

#### POST /relay
```json
// Request
{
  "proof": {
    "a": ["0x...", "0x..."],
    "b": [["0x...", "0x..."], ["0x...", "0x..."]],
    "c": ["0x...", "0x..."]
  },
  "publicSignals": ["...", "...", "...", "...", "...", "...", "...", "..."],
  "swapParams": {
    "poolKey": { "currency0": "0x...", "currency1": "0x...", "fee": 3000, "tickSpacing": 60, "hooks": "0x..." },
    "zeroForOne": false,
    "amountSpecified": "-50000000000000000000",
    "sqrtPriceLimitX96": "1461446703485210103287273052203988822378723970341"
  }
}

// Response
{
  "success": true,
  "txHash": "0x4d3bab7a47e56caf615fc84e78c7ddfc6712571a5fe27bba798f1b4c079d6876",
  "blockNumber": "43383287",
  "gasUsed": "581593"
}
```

### Required Circuit Files

Host these files for browser proof generation:
- `privateSwap.wasm` (~2MB) - WASM prover
- `privateSwap.zkey` (~40MB) - Proving key

Located in: `grimswap-circuits/build/`

### Public Signals Format

The circuit outputs 8 public signals:
```
[0] computedCommitment  - Proof output (commitment verification)
[1] computedNullifierHash - Proof output (nullifier verification)
[2] merkleRoot          - Must be known by GrimPool
[3] nullifierHash       - Prevents double-spend
[4] recipient           - Stealth address (receives tokens)
[5] relayer             - Relayer address (receives fee)
[6] relayerFee          - Fee in basis points (10 = 0.1%)
[7] swapAmountOut       - Expected output amount
```

---

## Running Tests

### Prerequisites
- Node.js 18+
- Private key with Unichain Sepolia ETH
- Running relayer service (for relayer test)

### Install
```bash
npm install
```

### Test Scripts

```bash
# Full ZK Private Swap with Relayer (FULL PRIVACY)
# First start relayer: cd ../grimswap-relayer && npm run dev
PRIVATE_KEY=0x... npm run test:relayer

# Full ZK Private Swap (direct submission - for testing)
PRIVATE_KEY=0x... npm test
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    GrimSwap Privacy System                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ANONYMITY SET (~1M deposits)                                   │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    Merkle Tree                           │   │
│   │                        ┌─┐                               │   │
│   │                       /   \                              │   │
│   │                      /     \                             │   │
│   │                    ┌─┐     ┌─┐                           │   │
│   │                   /   \   /   \                          │   │
│   │                 [C1] [C2] [C3] [C4] ...                   │   │
│   │                  │                                       │   │
│   │                  └── Your deposit (hidden among all)     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│   ZK PROOF: "I know a valid deposit, but not which one"          │
│                              │                                   │
│                              ▼                                   │
│   UNISWAP V4 SWAP ──────► STEALTH ADDRESS                        │
│                              │                                   │
│                              ▼                                   │
│   User controls stealth key, can withdraw anytime                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Privacy Guarantees

| Feature | Status | How It Works |
|---------|--------|--------------|
| Sender Privacy | ✅ | ZK proof hides which deposit is spent |
| Recipient Privacy | ✅ | Stealth address unlinkable to user |
| Gas Payer Privacy | ✅ | Relayer submits tx for user |
| Double-spend Prevention | ✅ | Nullifier marked spent on-chain |
| Anonymity Set | ~1M | All depositors in 20-level Merkle tree |

---

## Related Repositories

- **[grimswap-contracts](../grimswap-contracts)** - Solidity smart contracts (GrimPool, GrimSwapZK, Verifier)
- **[grimswap-circuits](../grimswap-circuits)** - Circom ZK circuits and SDK
- **[grimswap-relayer](../grimswap-relayer)** - Transaction relay service
- **[grimswap-sdk](../grimswap-sdk)** - TypeScript SDK (coming soon)

---

## License

MIT
