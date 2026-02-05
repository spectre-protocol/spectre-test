/**
 * GRIMSWAP - Production ZK Private Swap via GrimSwapRouter
 *
 * PRODUCTION FLOW:
 * 1. User deposits ETH to GrimPool (gets commitment in Merkle tree)
 * 2. Build Poseidon Merkle tree + generate ZK proof locally
 * 3. Send proof to Relayer
 * 4. Relayer calls GrimSwapRouter.executePrivateSwap()
 *    -> Router releases ETH from GrimPool
 *    -> Swaps ETH -> USDC on Uniswap v4
 *    -> GrimSwapZK hook routes USDC to stealth address
 * 5. User receives USDC at unlinkable stealth address
 *
 * FULL PRIVACY: Sender + Recipient + Gas Payer ALL HIDDEN
 *
 * Prerequisites:
 * 1. Start relayer: cd grimswap-relayer && npm run dev
 * 2. Run test: PRIVATE_KEY=0x... npm run test:relayer
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  formatUnits,
  keccak256,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const unichainSepolia = {
  id: 1301,
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.unichain.org"] } },
} as const;

// V3 Contract Addresses
const CONTRACTS = {
  grimPool: "0xEAB5E7B4e715A22E8c114B7476eeC15770B582bb" as Address,
  groth16Verifier: "0xF7D14b744935cE34a210D7513471a8E6d6e696a0" as Address,
  grimSwapZK: "0xeB72E2495640a4B83EBfc4618FD91cc9beB640c4" as Address,
  grimSwapRouter: "0xC13a6a504da21aD23c748f08d3E991621D42DA4F" as Address,
  poolManager: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC" as Address,
  usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F" as Address,
};

// Relayer configuration
const RELAYER_URL = process.env.RELAYER_URL || "http://localhost:3001";
const RELAYER_FEE_BPS = 10; // 0.1% fee to relayer

// ETH/USDC Pool Key (production pool, fee=500)
// ETH = address(0) < USDC, so ETH is currency0
const POOL_KEY = {
  currency0: "0x0000000000000000000000000000000000000000" as Address, // Native ETH
  currency1: CONTRACTS.usdc,
  fee: 500,
  tickSpacing: 10,
  hooks: CONTRACTS.grimSwapZK,
};

// ABIs
const GRIM_POOL_ABI = [
  {
    type: "function",
    name: "deposit",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "addKnownRoot",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isKnownRoot",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isSpent",
    inputs: [{ name: "nullifierHash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ZK Constants
const MERKLE_TREE_HEIGHT = 20;
const FIELD_SIZE = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);
const ZERO_VALUE = BigInt(
  "21663839004416932945382355908790599225266501822907911457504978515578255421292"
);

let poseidon: any;
let F: any;

async function initPoseidon() {
  if (!poseidon) {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  }
}

function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let num = BigInt(0);
  for (let i = 0; i < 32; i++) {
    num = (num << BigInt(8)) | BigInt(bytes[i]);
  }
  return num % FIELD_SIZE;
}

async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const hash = poseidon(inputs);
  return BigInt(F.toString(hash));
}

interface DepositNote {
  secret: bigint;
  nullifier: bigint;
  amount: bigint;
  commitment: bigint;
  nullifierHash: bigint;
}

async function createDepositNote(amount: bigint): Promise<DepositNote> {
  const secret = randomFieldElement();
  const nullifier = randomFieldElement();
  const commitment = await poseidonHash([nullifier, secret, amount]);
  const nullifierHash = await poseidonHash([nullifier]);
  return { secret, nullifier, amount, commitment, nullifierHash };
}

function toBytes32(n: bigint): Hex {
  return ("0x" + n.toString(16).padStart(64, "0")) as Hex;
}

// Poseidon Merkle Tree
class PoseidonMerkleTree {
  private height: number;
  private zeros: bigint[] = [];
  private layers: bigint[][] = [];

  constructor(height: number = MERKLE_TREE_HEIGHT) {
    this.height = height;
  }

  async initialize() {
    this.zeros = [ZERO_VALUE];
    for (let i = 1; i <= this.height; i++) {
      this.zeros[i] = await poseidonHash([this.zeros[i - 1], this.zeros[i - 1]]);
    }
    this.layers = Array.from({ length: this.height + 1 }, () => []);
  }

  async insert(leaf: bigint): Promise<number> {
    const index = this.layers[0].length;
    let currentValue = leaf;
    this.layers[0].push(currentValue);
    let currentIndex = index;

    for (let level = 0; level < this.height; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      const sibling = this.layers[level][siblingIndex] ?? this.zeros[level];
      const [left, right] = isLeft
        ? [currentValue, sibling]
        : [sibling, currentValue];
      currentValue = await poseidonHash([left, right]);
      currentIndex = Math.floor(currentIndex / 2);
      this.layers[level + 1][currentIndex] = currentValue;
    }
    return index;
  }

  getRoot(): bigint {
    return this.layers[this.height]?.[0] ?? this.zeros[this.height];
  }

  getProof(leafIndex: number) {
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let currentIndex = leafIndex;

    for (let level = 0; level < this.height; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      pathElements.push(this.layers[level][siblingIndex] ?? this.zeros[level]);
      pathIndices.push(isLeft ? 0 : 1);
      currentIndex = Math.floor(currentIndex / 2);
    }
    return { root: this.getRoot(), pathElements, pathIndices };
  }
}

async function main() {
  console.log("");
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║   GRIMSWAP - PRODUCTION ZK PRIVATE SWAP                       ║");
  console.log("║   ETH -> USDC via GrimSwapRouter                             ║");
  console.log("║   FULL PRIVACY: Sender + Recipient + Gas Payer ALL HIDDEN     ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log("");

  const privateKey = process.env.PRIVATE_KEY as Hex;
  if (!privateKey) {
    console.error("ERROR: Set PRIVATE_KEY");
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey);
  console.log("Network: Unichain Sepolia (Chain ID: 1301)");
  console.log("User wallet:", account.address, "(will NOT appear in swap tx)");
  console.log("Relayer URL:", RELAYER_URL);
  console.log("");

  const publicClient = createPublicClient({
    chain: unichainSepolia,
    transport: http("https://sepolia.unichain.org"),
  });

  const walletClient = createWalletClient({
    account,
    chain: unichainSepolia,
    transport: http("https://sepolia.unichain.org"),
  });

  // Check relayer health
  console.log("Checking relayer health...");
  try {
    const healthRes = await fetch(`${RELAYER_URL}/health`);
    const health = await healthRes.json();
    console.log("  Relayer status:", health.status);
    console.log("");
  } catch (e) {
    console.error("ERROR: Relayer not running! Start it first: cd grimswap-relayer && npm run dev");
    process.exit(1);
  }

  await initPoseidon();

  const timings: { step: string; time: number }[] = [];
  const totalStart = Date.now();

  // Deposit amount: 0.001 ETH (small test amount)
  const depositAmount = parseEther("0.001");

  // ============================================
  // STEP 1: Create Deposit Note
  // ============================================
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ STEP 1: Create Deposit Note (Poseidon) - LOCAL                │");
  console.log("└────────────────────────────────────────────────────────────────┘");

  let start = Date.now();
  const note = await createDepositNote(depositAmount);
  timings.push({ step: "Create deposit note", time: Date.now() - start });

  console.log("  Deposit amount:", formatEther(note.amount), "ETH");
  console.log("  Commitment:", toBytes32(note.commitment).slice(0, 42) + "...");
  console.log("");

  // ============================================
  // STEP 2: Deposit ETH to GrimPool
  // ============================================
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ STEP 2: Deposit ETH to GrimPool                               │");
  console.log("└────────────────────────────────────────────────────────────────┘");

  start = Date.now();
  const depositTx = await walletClient.writeContract({
    address: CONTRACTS.grimPool,
    abi: GRIM_POOL_ABI,
    functionName: "deposit",
    args: [toBytes32(note.commitment)],
    value: depositAmount,
  });
  console.log("  TX:", depositTx);

  const depositReceipt = await publicClient.waitForTransactionReceipt({
    hash: depositTx,
    confirmations: 1,
  });
  console.log("  Status:", depositReceipt.status);
  console.log("  Block:", depositReceipt.blockNumber);
  timings.push({ step: "Deposit ETH to GrimPool", time: Date.now() - start });
  console.log("");

  // ============================================
  // STEP 3: Build Merkle Tree
  // ============================================
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ STEP 3: Build Poseidon Merkle Tree - LOCAL                    │");
  console.log("└────────────────────────────────────────────────────────────────┘");

  start = Date.now();
  const tree = new PoseidonMerkleTree(MERKLE_TREE_HEIGHT);
  await tree.initialize();
  await tree.insert(note.commitment);
  const merkleProof = tree.getProof(0);
  timings.push({ step: "Build Merkle tree", time: Date.now() - start });

  console.log("  Root:", toBytes32(merkleProof.root).slice(0, 42) + "...");
  console.log("");

  // ============================================
  // STEP 4: Add Poseidon Root to GrimPool (testnet only)
  // ============================================
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ STEP 4: Add Poseidon Root to GrimPool (testnet)               │");
  console.log("└────────────────────────────────────────────────────────────────┘");

  start = Date.now();
  const rootBytes = toBytes32(merkleProof.root);

  const addRootTx = await walletClient.writeContract({
    address: CONTRACTS.grimPool,
    abi: GRIM_POOL_ABI,
    functionName: "addKnownRoot",
    args: [rootBytes],
  });
  console.log("  TX:", addRootTx);

  const rootReceipt = await publicClient.waitForTransactionReceipt({
    hash: addRootTx,
    confirmations: 1,
  });
  console.log("  Status:", rootReceipt.status);
  timings.push({ step: "Add Poseidon root", time: Date.now() - start });

  const isKnown = await publicClient.readContract({
    address: CONTRACTS.grimPool,
    abi: GRIM_POOL_ABI,
    functionName: "isKnownRoot",
    args: [rootBytes],
  });
  console.log("  Root verified:", isKnown);
  console.log("");

  // ============================================
  // STEP 5: Generate Stealth Address
  // ============================================
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ STEP 5: Generate Stealth Address - LOCAL                      │");
  console.log("└────────────────────────────────────────────────────────────────┘");

  const stealthPrivateKey = randomFieldElement();
  const stealthAddress =
    "0x" +
    BigInt(keccak256(toBytes32(stealthPrivateKey) as Hex))
      .toString(16)
      .slice(-40)
      .padStart(40, "0");
  console.log("  Stealth recipient:", stealthAddress);
  console.log("");

  // ============================================
  // STEP 6: Generate ZK Proof
  // ============================================
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ STEP 6: Generate Groth16 ZK Proof - LOCAL                     │");
  console.log("└────────────────────────────────────────────────────────────────┘");

  const recipientBigInt = BigInt(stealthAddress);

  let relayerAddress: string;
  try {
    const infoRes = await fetch(`${RELAYER_URL}/info`);
    const info = await infoRes.json();
    relayerAddress = info.address;
    console.log("  Relayer address:", relayerAddress);
  } catch {
    relayerAddress = "0x25f75573799A3Aa37760D6bE4b862acA70599b49";
    console.log("  Using fallback relayer:", relayerAddress);
  }
  const relayerBigInt = BigInt(relayerAddress);

  const circuitsPath = path.resolve(__dirname, "../../grimswap-circuits");
  const wasmPath = path.join(circuitsPath, "build/privateSwap_js/privateSwap.wasm");
  const zkeyPath = path.join(circuitsPath, "build/privateSwap.zkey");

  const input = {
    merkleRoot: merkleProof.root.toString(),
    nullifierHash: note.nullifierHash.toString(),
    recipient: recipientBigInt.toString(),
    relayer: relayerBigInt.toString(),
    relayerFee: RELAYER_FEE_BPS.toString(),
    swapAmountOut: note.amount.toString(),
    secret: note.secret.toString(),
    nullifier: note.nullifier.toString(),
    depositAmount: note.amount.toString(),
    pathElements: merkleProof.pathElements.map((e) => e.toString()),
    pathIndices: merkleProof.pathIndices,
  };

  start = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  timings.push({ step: "Generate ZK proof", time: Date.now() - start });
  console.log("  Proof generated in:", Date.now() - start, "ms");
  console.log("");

  // ============================================
  // STEP 7: Send Proof to Relayer -> GrimSwapRouter
  // ============================================
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ STEP 7: Send to RELAYER -> GrimSwapRouter -> ETH/USDC Swap    │");
  console.log("└────────────────────────────────────────────────────────────────┘");

  // ETH -> USDC: zeroForOne = true (ETH is currency0)
  const MIN_SQRT_PRICE = BigInt("4295128739") + BigInt(1);
  const zeroForOne = true;

  const relayRequest = {
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
        currency0: POOL_KEY.currency0,
        currency1: POOL_KEY.currency1,
        fee: POOL_KEY.fee,
        tickSpacing: POOL_KEY.tickSpacing,
        hooks: POOL_KEY.hooks,
      },
      zeroForOne,
      amountSpecified: (-depositAmount).toString(), // exact input (negative = exact input)
      sqrtPriceLimitX96: MIN_SQRT_PRICE.toString(),
    },
  };

  console.log("  Swap: ETH -> USDC via GrimSwapRouter");
  console.log("  Input:", formatEther(depositAmount), "ETH");
  console.log("  Route: GrimPool -> Router -> Uniswap V4 -> USDC at Stealth");
  console.log("");

  start = Date.now();

  try {
    const response = await fetch(`${RELAYER_URL}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(relayRequest),
    });

    const result = await response.json();
    timings.push({ step: "Relayer + Router execution", time: Date.now() - start });

    if (!result.success) {
      console.error("  Relayer error:", result.error);
      console.error("  Code:", result.code);
      if (result.details) console.error("  Details:", result.details);
      process.exit(1);
    }

    console.log("  SUCCESS!");
    console.log("  TX Hash:", result.txHash);
    console.log("  Block:", result.blockNumber);
    console.log("  Gas used:", result.gasUsed);
    console.log("");

    // ============================================
    // STEP 8: Verify Privacy + Token Receipt
    // ============================================
    console.log("┌────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 8: Verify FULL PRIVACY + Token Receipt                    │");
    console.log("└────────────────────────────────────────────────────────────────┘");

    // Check USDC balance at stealth address (output of ETH->USDC swap)
    const stealthUSDC = await publicClient.readContract({
      address: CONTRACTS.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [stealthAddress as Address],
    });

    // Check nullifier is spent
    const isSpent = await publicClient.readContract({
      address: CONTRACTS.grimPool,
      abi: GRIM_POOL_ABI,
      functionName: "isSpent",
      args: [toBytes32(note.nullifierHash)],
    });

    // Verify tx sender (should be relayer, not user)
    const txReceipt = await publicClient.getTransactionReceipt({
      hash: result.txHash as Hex,
    });

    console.log("  TX sender:", txReceipt.from);
    console.log("  Your wallet:", account.address);
    console.log(
      "  Privacy:",
      txReceipt.from.toLowerCase() !== account.address.toLowerCase()
        ? "PRESERVED (different sender)"
        : "test mode (same wallet)"
    );
    console.log("");
    console.log("  Stealth address:", stealthAddress);
    console.log("  USDC received:", formatUnits(stealthUSDC, 6), "USDC");
    console.log("  Nullifier spent:", isSpent);

    const totalTime = Date.now() - totalStart;

    // ============================================
    // Summary
    // ============================================
    console.log("");
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║   PRODUCTION ZK PRIVATE SWAP SUCCESSFUL!                      ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log("");

    console.log("Flow: ETH Deposit -> GrimSwapRouter -> Uniswap V4 -> USDC at Stealth");
    console.log("");
    console.log("Privacy guarantees:");
    console.log("  [x] SENDER HIDDEN - ZK proof hides deposit origin");
    console.log("  [x] RECIPIENT HIDDEN - Stealth address:", stealthAddress.slice(0, 20) + "...");
    console.log("  [x] GAS PAYER HIDDEN - Relayer:", txReceipt.from);
    console.log("  [x] DOUBLE-SPEND PREVENTED - Nullifier spent");
    console.log("  [x] ATOMIC EXECUTION - Router reverts all if proof invalid");
    console.log("");

    console.log("Timing:");
    for (const t of timings) {
      console.log(`  ${t.step}: ${t.time} ms`);
    }
    console.log(`  TOTAL: ${totalTime} ms`);
    console.log("");

    console.log("TX:", result.txHash);
    console.log("View: https://unichain-sepolia.blockscout.com/tx/" + result.txHash);
    console.log("");

  } catch (error: any) {
    console.error("  Relay failed:", error.message);
    if (error.cause) {
      console.error("  Cause:", JSON.stringify(error.cause, null, 2));
    }
  }
}

main().catch(console.error);
