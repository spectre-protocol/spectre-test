# GrimSwap Test

End-to-end test scripts for the GrimSwap privacy system.

## Production Test: Full ZK Swap with Relayer

`src/fullZKSwapWithRelayer.ts` - Complete production flow:

1. Create deposit note (Poseidon commitment) - local
2. Deposit ETH to GrimPool - on-chain
3. Build Poseidon Merkle tree - local
4. Add Merkle root to GrimPool - on-chain (testnet only)
5. Generate stealth address - local
6. Generate Groth16 ZK proof - local (snarkjs)
7. Send proof to relayer -> GrimSwapRouter -> Uniswap v4 swap
8. Verify privacy + token receipt at stealth address

### Running

```bash
# Start relayer first
cd ../grimswap-relayer && npm run dev

# Run test
PRIVATE_KEY=0x... npm run test:relayer
```

### Configuration

The test uses these contract addresses (edit in `fullZKSwapWithRelayer.ts`):

| Contract | Address |
|----------|---------|
| GrimPool | `0xEAB5E7B4e715A22E8c114B7476eeC15770B582bb` |
| GrimSwapZK | `0xeB72E2495640a4B83EBfc4618FD91cc9beB640c4` |
| GrimSwapRouter | `0xC13a6a504da21aD23c748f08d3E991621D42DA4F` |

### Pool Key

Update `POOL_KEY` in the test file to match your pool:

```typescript
const POOL_KEY = {
  currency0: "0x0000000000000000000000000000000000000000", // ETH
  currency1: "<token_address>",
  fee: 500,        // or 3000
  tickSpacing: 10, // or 60
  hooks: CONTRACTS.grimSwapZK,
};
```

## Test Results

### ETH/TokenA (Successful)
- TX: `0xca2fa2b55af5a94f9d1ea3712aa08c847154a4327172172a4f1bfa861d0e4461`
- Input: 0.001 ETH -> Output: 0.000983 TokenA at stealth address
- Gas: 499,760
- Total time: 26.6 seconds
- All privacy guarantees verified

## Other Scripts

| Script | Description |
|--------|-------------|
| `checkBalances.ts` | Check ETH/token balances |
| `fullZKSwap.ts` | Direct ZK swap (no relayer) |

## License

MIT
