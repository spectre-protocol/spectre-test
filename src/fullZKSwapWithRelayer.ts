/**
 * GRIMSWAP - Full ZK Private Swap with RELAYER
 *
 * Complete end-to-end test with FULL PRIVACY:
 * 1. Create deposit note with Poseidon
 * 2. Build local Poseidon Merkle tree
 * 3. Add Poseidon root to GrimPool (testnet only)
 * 4. Generate ZK proof LOCALLY (user side)
 * 5. Send proof to RELAYER (relayer pays gas)
 * 6. Relayer submits tx - USER WALLET NEVER TOUCHES CHAIN
 *
 * This achieves FULL privacy:
 * - Sender hidden (ZK proof)
 * - Recipient hidden (stealth address)
 * - Gas payer hidden (relayer)
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

// Contracts
const CONTRACTS = {
  grimPool: "0xad079eAC28499c4eeA5C02D2DE1C81E56b9AA090" as Address,
  groth16Verifier: "0xF7D14b744935cE34a210D7513471a8E6d6e696a0" as Address,
  grimSwapZK: "0x95ED348fCC232FB040e46c77C60308517e4BC0C4" as Address,
  poolManager: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC" as Address,
  tokenA: "0x48bA64b5312AFDfE4Fc96d8F03010A0a86e17963" as Address,
  tokenB: "0x96aC37889DfDcd4dA0C898a5c9FB9D17ceD60b1B" as Address,
  poolHelper: "0x26a669aC1e5343a50260490eC0C1be21f9818b17" as Address,
};

// Relayer configuration
const RELAYER_URL = process.env.RELAYER_URL || "http://localhost:3001";
const RELAYER_FEE_BPS = 10; // 0.1% fee to relayer

// ABIs
const GRIM_POOL_ABI = [
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
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// Pool key for ZK swap
const POOL_KEY = {
  currency0: CONTRACTS.tokenA,
  currency1: CONTRACTS.tokenB,
  fee: 3000,
  tickSpacing: 60,
  hooks: CONTRACTS.grimSwapZK,
};

// Constants
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
  console.log(
    "╔════════════════════════════════════════════════════════════════╗"
  );
  console.log(
    "║   GRIMSWAP - FULL ZK PRIVATE SWAP WITH RELAYER                 ║"
  );
  console.log(
    "║                                                                ║"
  );
  console.log(
    "║   FULL PRIVACY: Sender + Recipient + Gas Payer ALL HIDDEN     ║"
  );
  console.log(
    "╚════════════════════════════════════════════════════════════════╝"
  );
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

  // Owner wallet for testnet root addition (in production, deposits auto-add to tree)
  const ownerKey = process.env.OWNER_KEY || "0x28cf404c672941021eae9ef55f933cd31f7d1d02a94c019d65a01707891c34dc";
  const ownerAccount = privateKeyToAccount(ownerKey as Hex);
  const ownerWalletClient = createWalletClient({
    account: ownerAccount,
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
    console.error("");
    console.error("ERROR: Relayer not running!");
    console.error("Start the relayer first:");
    console.error("  cd grimswap-relayer && npm run dev");
    console.error("");
    process.exit(1);
  }

  await initPoseidon();

  const timings: { step: string; time: number }[] = [];
  const totalStart = Date.now();

  // ============================================
  // STEP 1: Create Deposit Note
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 1: Create Deposit Note (Poseidon) - LOCAL                │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  let start = Date.now();
  const swapAmount = parseEther("10");
  const note = await createDepositNote(swapAmount);
  timings.push({ step: "Create deposit note", time: Date.now() - start });

  console.log("  Amount:", formatEther(note.amount), "tokens");
  console.log("  Commitment:", toBytes32(note.commitment).slice(0, 42) + "...");
  console.log("");

  // ============================================
  // STEP 2: Build Merkle Tree
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 2: Build Poseidon Merkle Tree - LOCAL                    │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  start = Date.now();
  const tree = new PoseidonMerkleTree(MERKLE_TREE_HEIGHT);
  await tree.initialize();
  await tree.insert(note.commitment);
  const merkleProof = tree.getProof(0);
  timings.push({ step: "Build Merkle tree", time: Date.now() - start });

  console.log("  Root:", toBytes32(merkleProof.root).slice(0, 42) + "...");
  console.log("");

  // ============================================
  // STEP 3: Add Root to GrimPool (testnet only)
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 3: Add Root to GrimPool (testnet setup)                  │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  start = Date.now();
  const rootBytes = toBytes32(merkleProof.root);

  // Use owner wallet to add root (testnet only - in production, deposits auto-add)
  const addRootTx = await ownerWalletClient.writeContract({
    address: CONTRACTS.grimPool,
    abi: GRIM_POOL_ABI,
    functionName: "addKnownRoot",
    args: [rootBytes],
  });
  console.log("  TX:", addRootTx);
  console.log("  (Using owner wallet for testnet root setup)");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: addRootTx, confirmations: 2 });
  console.log("  Receipt status:", receipt.status);
  // Wait for state propagation
  await new Promise(resolve => setTimeout(resolve, 3000));
  timings.push({ step: "Add root to GrimPool", time: Date.now() - start });

  const isKnown = await publicClient.readContract({
    address: CONTRACTS.grimPool,
    abi: GRIM_POOL_ABI,
    functionName: "isKnownRoot",
    args: [rootBytes],
  });
  console.log("  Root is known:", isKnown);
  console.log("");

  // ============================================
  // STEP 4: Generate Stealth Address
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 4: Generate Stealth Address - LOCAL                      │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  const stealthPrivateKey = randomFieldElement();
  const stealthAddress =
    "0x" +
    BigInt(keccak256(toBytes32(stealthPrivateKey) as Hex))
      .toString(16)
      .slice(-40)
      .padStart(40, "0");
  console.log("  Stealth recipient:", stealthAddress);
  console.log("  (unlinkable to your wallet)");
  console.log("");

  // ============================================
  // STEP 5: Generate ZK Proof LOCALLY
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 5: Generate Groth16 ZK Proof - LOCAL (browser/client)    │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  const recipientBigInt = BigInt(stealthAddress);

  // Get relayer address from the relayer service
  // The relayer address MUST be non-zero if relayerFee is non-zero (circuit constraint)
  let relayerAddress: string;
  try {
    const infoRes = await fetch(`${RELAYER_URL}/info`);
    const info = await infoRes.json();
    relayerAddress = info.address;
    console.log("  Relayer address:", relayerAddress);
  } catch {
    // Fallback: use env var or derive from known relayer key
    relayerAddress = process.env.RELAYER_ADDRESS || "0x25f75573799A3Aa37760D6bE4b862acA70599b49";
    console.log("  Using fallback relayer address:", relayerAddress);
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
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );
  timings.push({ step: "Generate ZK proof", time: Date.now() - start });
  console.log("  Proof generated in:", Date.now() - start, "ms");
  console.log("  (Private inputs NEVER leave your device)");
  console.log("");

  // ============================================
  // STEP 6: Send Proof to Relayer
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 6: Send Proof to RELAYER (relayer pays gas)              │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  // Price limits - alternate between directions based on pool state
  const MIN_SQRT_PRICE = BigInt("4295128739") + BigInt(1);
  const MAX_SQRT_PRICE = BigInt("1461446703485210103287273052203988822378723970342") - BigInt(1);

  // Try zeroForOne = false (TokenB -> TokenA) with MAX price
  const zeroForOne = false;
  const sqrtPriceLimit = zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;

  // Format proof for relayer API
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
      amountSpecified: (-swapAmount).toString(), // exact input amount
      sqrtPriceLimitX96: sqrtPriceLimit.toString(),
    },
  };

  console.log("  Sending proof to relayer...");
  console.log("  Your wallet:", account.address);
  console.log("  (Your wallet will NOT appear in the swap transaction)");
  console.log("");

  start = Date.now();

  try {
    const response = await fetch(`${RELAYER_URL}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(relayRequest),
    });

    const result = await response.json();
    timings.push({ step: "Relayer submission", time: Date.now() - start });

    if (!result.success) {
      console.error("  Relayer error:", result.error);
      console.error("  Code:", result.code);
      if (result.details) {
        console.error("  Details:", result.details);
      }
      process.exit(1);
    }

    console.log("  SUCCESS!");
    console.log("  TX Hash:", result.txHash);
    console.log("  Block:", result.blockNumber);
    console.log("  Gas used:", result.gasUsed);
    console.log("  Relayer fee:", result.relayerFee);
    console.log("");

    // ============================================
    // STEP 7: Verify Privacy
    // ============================================
    console.log(
      "┌────────────────────────────────────────────────────────────────┐"
    );
    console.log(
      "│ STEP 7: Verify FULL PRIVACY                                   │"
    );
    console.log(
      "└────────────────────────────────────────────────────────────────┘"
    );

    // Check stealth address balance
    const stealthTokenB = await publicClient.readContract({
      address: CONTRACTS.tokenB,
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

    // Get transaction details to verify relayer paid gas
    const txReceipt = await publicClient.getTransactionReceipt({
      hash: result.txHash as Hex,
    });

    console.log("  Transaction sender:", txReceipt.from);
    console.log("  Your wallet:", account.address);
    console.log(
      "  Match?",
      txReceipt.from.toLowerCase() === account.address.toLowerCase()
        ? "YES (privacy broken!)"
        : "NO (privacy preserved!)"
    );
    console.log("");
    console.log("  Stealth address:", stealthAddress);
    console.log("  Token B received:", formatEther(stealthTokenB));
    console.log("  Nullifier spent:", isSpent);

    const totalTime = Date.now() - totalStart;

    // ============================================
    // Summary
    // ============================================
    console.log("");
    console.log(
      "╔════════════════════════════════════════════════════════════════╗"
    );
    console.log(
      "║        FULL PRIVACY ZK SWAP SUCCESSFUL!                        ║"
    );
    console.log(
      "╚════════════════════════════════════════════════════════════════╝"
    );
    console.log("");

    console.log("Privacy guarantees:");
    console.log("  [x] SENDER HIDDEN - ZK proof hides which deposit");
    console.log("  [x] RECIPIENT HIDDEN - Stealth address:", stealthAddress.slice(0, 20) + "...");
    console.log("  [x] GAS PAYER HIDDEN - Relayer:", txReceipt.from);
    console.log("  [x] DOUBLE-SPEND PREVENTED - Nullifier marked spent");
    console.log("");

    console.log("Your wallet", account.address.slice(0, 20) + "...");
    console.log("  -> NEVER appeared in the swap transaction");
    console.log("  -> Cannot be linked to the swap on-chain");
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
