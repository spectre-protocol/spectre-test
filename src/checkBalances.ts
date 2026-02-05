import { createPublicClient, createWalletClient, http, formatEther, parseEther, maxUint256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const unichainSepolia = {
  id: 1301,
  name: 'Unichain Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia.unichain.org'] } },
} as const;

const client = createPublicClient({ transport: http('https://sepolia.unichain.org'), chain: unichainSepolia });

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allowance', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
] as const;

async function main() {
  const privateKey = process.env.PRIVATE_KEY as Hex;
  if (!privateKey) { console.error('Set PRIVATE_KEY'); process.exit(1); }

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain: unichainSepolia, transport: http('https://sepolia.unichain.org') });

  const relayer = account.address;
  const tokenA = '0x48bA64b5312AFDfE4Fc96d8F03010A0a86e17963' as const;
  const tokenB = '0x96aC37889DfDcd4dA0C898a5c9FB9D17ceD60b1B' as const;
  const poolSwapTest = '0x9140a78c1A137c7fF1c151EC8231272aF78a99A4' as const;

  const balA = await client.readContract({ address: tokenA, abi: ERC20_ABI, functionName: 'balanceOf', args: [relayer] });
  const balB = await client.readContract({ address: tokenB, abi: ERC20_ABI, functionName: 'balanceOf', args: [relayer] });
  const allowA = await client.readContract({ address: tokenA, abi: ERC20_ABI, functionName: 'allowance', args: [relayer, poolSwapTest] });
  const allowB = await client.readContract({ address: tokenB, abi: ERC20_ABI, functionName: 'allowance', args: [relayer, poolSwapTest] });

  console.log('Relayer:', relayer);
  console.log('Relayer Token A balance:', formatEther(balA));
  console.log('Relayer Token B balance:', formatEther(balB));
  console.log('Token A allowance (PoolSwapTest):', formatEther(allowA));
  console.log('Token B allowance (PoolSwapTest):', formatEther(allowB));

  // Approve PoolSwapTest if needed
  if (allowA === 0n) {
    console.log('\nApproving Token A for PoolSwapTest...');
    const tx = await walletClient.writeContract({ address: tokenA, abi: ERC20_ABI, functionName: 'approve', args: [poolSwapTest, maxUint256] });
    console.log('TX:', tx);
    await client.waitForTransactionReceipt({ hash: tx, confirmations: 1 });
    console.log('Token A approved!');
  }

  if (allowB === 0n) {
    console.log('\nApproving Token B for PoolSwapTest...');
    const tx = await walletClient.writeContract({ address: tokenB, abi: ERC20_ABI, functionName: 'approve', args: [poolSwapTest, maxUint256] });
    console.log('TX:', tx);
    await client.waitForTransactionReceipt({ hash: tx, confirmations: 1 });
    console.log('Token B approved!');
  }

  console.log('\nDone!');
}

main().catch(console.error);
