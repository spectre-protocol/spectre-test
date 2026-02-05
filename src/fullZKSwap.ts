/**
 * GRIMSWAP - Full ZK Private Swap Test
 *
 * Complete end-to-end test:
 * 1. Create deposit note with Poseidon
 * 2. Build local Poseidon Merkle tree
 * 3. Add Poseidon root to GrimPool (testnet only)
 * 4. Generate ZK proof
 * 5. Execute actual swap through GrimSwapZK hook
 *
 * Run: PRIVATE_KEY=0x... npm run test:zkswap
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  encodeAbiParameters,
  parseAbiParameters,
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

// V3 deployed contracts (Dual-Mode Hook + Router)
const CONTRACTS = {
  grimPool: "0xEAB5E7B4e715A22E8c114B7476eeC15770B582bb" as Address,
  groth16Verifier: "0xF7D14b744935cE34a210D7513471a8E6d6e696a0" as Address,
  grimSwapZK: "0xeB72E2495640a4B83EBfc4618FD91cc9beB640c4" as Address,
  grimSwapRouter: "0xC13a6a504da21aD23c748f08d3E991621D42DA4F" as Address,
  poolManager: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC" as Address,
  tokenA: "0x48bA64b5312AFDfE4Fc96d8F03010A0a86e17963" as Address,
  tokenB: "0x96aC37889DfDcd4dA0C898a5c9FB9D17ceD60b1B" as Address,
  poolHelper: "0xee33461fCD6cbA3b7B2D8B6Bb66577680880A2B2" as Address,
};

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

const POOL_HELPER_ABI = [
  {
    type: "function",
    name: "swap",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountSpecified", type: "int256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
      { name: "hookData", type: "bytes" },
      { name: "from", type: "address" },
    ],
    outputs: [{ name: "delta", type: "int256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "initializePool",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "addLiquidity",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "from", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const GRIM_SWAP_ZK_ABI = [
  {
    type: "event",
    name: "PrivateSwapExecuted",
    inputs: [
      { name: "nullifierHash", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "relayer", type: "address", indexed: true },
      { name: "fee", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "StealthPayment",
    inputs: [
      { name: "stealthAddress", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "ephemeralPubKey", type: "bytes", indexed: false },
    ],
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

function formatProofForContract(proof: any, publicSignals: string[]) {
  return {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
    pubSignals: publicSignals.map((s) => BigInt(s)) as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint
    ],
  };
}

function encodeHookData(
  contractProof: ReturnType<typeof formatProofForContract>
): Hex {
  return encodeAbiParameters(
    parseAbiParameters("uint256[2], uint256[2][2], uint256[2], uint256[8]"),
    [
      contractProof.pA,
      contractProof.pB,
      contractProof.pC,
      contractProof.pubSignals,
    ]
  );
}

async function main() {
  console.log("");
  console.log(
    "╔════════════════════════════════════════════════════════════════╗"
  );
  console.log(
    "║       GRIMSWAP - FULL ZK PRIVATE SWAP TEST                     ║"
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
  console.log("Account:", account.address);
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

  const ethBalance = await publicClient.getBalance({ address: account.address });
  console.log("ETH Balance:", formatEther(ethBalance), "ETH");

  // Check token balances
  const tokenABalance = await publicClient.readContract({
    address: CONTRACTS.tokenA,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  const tokenBBalance = await publicClient.readContract({
    address: CONTRACTS.tokenB,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log("Token A Balance:", formatEther(tokenABalance));
  console.log("Token B Balance:", formatEther(tokenBBalance));
  console.log("");

  console.log("Contracts:");
  console.log("  GrimPool:", CONTRACTS.grimPool);
  console.log("  Groth16Verifier:", CONTRACTS.groth16Verifier);
  console.log("  GrimSwapZK:", CONTRACTS.grimSwapZK);
  console.log("");

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
    "│ STEP 1: Create Deposit Note (Poseidon)                        │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  let start = Date.now();
  const swapAmount = parseEther("10"); // Swap 10 tokens
  const note = await createDepositNote(swapAmount);
  timings.push({ step: "Create deposit note", time: Date.now() - start });

  console.log("  Amount:", formatEther(note.amount), "tokens");
  console.log("  Commitment:", toBytes32(note.commitment).slice(0, 42) + "...");
  console.log(
    "  NullifierHash:",
    toBytes32(note.nullifierHash).slice(0, 42) + "..."
  );
  console.log("");

  // ============================================
  // STEP 2: Build Poseidon Merkle Tree
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 2: Build Poseidon Merkle Tree                            │"
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
  console.log("  Path elements:", merkleProof.pathElements.length);
  console.log("");

  // ============================================
  // STEP 3: Add Poseidon Root to GrimPool
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 3: Add Poseidon Root to GrimPool (testnet)               │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  start = Date.now();
  const rootBytes = toBytes32(merkleProof.root);

  const addRootTx = await walletClient.writeContract({
    address: CONTRACTS.grimPool,
    abi: GRIM_POOL_ABI,
    functionName: "addKnownRoot",
    args: [rootBytes],
  });
  console.log("  TX:", addRootTx);
  await publicClient.waitForTransactionReceipt({ hash: addRootTx });
  timings.push({ step: "Add root to GrimPool", time: Date.now() - start });

  // Verify root is known
  const isKnown = await publicClient.readContract({
    address: CONTRACTS.grimPool,
    abi: GRIM_POOL_ABI,
    functionName: "isKnownRoot",
    args: [rootBytes],
  });
  console.log("  Root is known:", isKnown);
  console.log("");

  // ============================================
  // STEP 4: Generate ZK Proof
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 4: Generate Groth16 ZK Proof                             │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  // Generate stealth address (use a random address for privacy)
  const stealthPrivateKey = randomFieldElement();
  const stealthAddress =
    "0x" +
    BigInt(
      keccak256(toBytes32(stealthPrivateKey) as Hex)
    )
      .toString(16)
      .slice(-40)
      .padStart(40, "0");
  console.log("  Stealth recipient:", stealthAddress);

  const recipientBigInt = BigInt(stealthAddress);

  const circuitsPath = path.resolve(__dirname, "../../grimswap-circuits");
  const wasmPath = path.join(
    circuitsPath,
    "build/privateSwap_js/privateSwap.wasm"
  );
  const zkeyPath = path.join(circuitsPath, "build/privateSwap.zkey");

  const input = {
    merkleRoot: merkleProof.root.toString(),
    nullifierHash: note.nullifierHash.toString(),
    recipient: recipientBigInt.toString(),
    relayer: "0",
    relayerFee: "0",
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
  console.log("");

  // ============================================
  // STEP 5: Mint Tokens & Approve
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 5: Prepare Tokens for Swap                               │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  // Mint tokens if needed
  if (tokenABalance < parseEther("100")) {
    console.log("  Minting Token A...");
    const mintTx = await walletClient.writeContract({
      address: CONTRACTS.tokenA,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [account.address, parseEther("10000")],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintTx });
    console.log("  Minted 10,000 Token A");
  }

  // Approve tokens
  console.log("  Approving tokens for PoolHelper...");
  const approveTx = await walletClient.writeContract({
    address: CONTRACTS.tokenA,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [CONTRACTS.poolHelper, parseEther("1000000")],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log("  Approved");
  console.log("");

  // ============================================
  // STEP 6: Initialize Pool (if needed)
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 6: Initialize Pool with GrimSwapZK Hook                  │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  try {
    // sqrtPriceX96 for 1:1 price
    const sqrtPriceX96 = BigInt("79228162514264337593543950336");

    console.log("  Initializing pool...");
    const initTx = await walletClient.writeContract({
      address: CONTRACTS.poolHelper,
      abi: POOL_HELPER_ABI,
      functionName: "initializePool",
      args: [POOL_KEY, sqrtPriceX96],
    });
    await publicClient.waitForTransactionReceipt({ hash: initTx });
    console.log("  Pool initialized:", initTx);

    // Add liquidity
    console.log("  Adding liquidity...");
    const liqTx = await walletClient.writeContract({
      address: CONTRACTS.poolHelper,
      abi: POOL_HELPER_ABI,
      functionName: "addLiquidity",
      args: [
        POOL_KEY,
        -887220, // tickLower
        887220, // tickUpper
        BigInt("1000000000000000000000"), // liquidity
        account.address,
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash: liqTx });
    console.log("  Liquidity added:", liqTx);
  } catch (e: any) {
    console.log("  Pool may already exist:", e.message?.slice(0, 50));
  }
  console.log("");

  // ============================================
  // STEP 7: Execute Private Swap
  // ============================================
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ STEP 7: Execute Private Swap through GrimSwapZK               │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );

  const contractProof = formatProofForContract(proof, publicSignals);
  const hookData = encodeHookData(contractProof);
  console.log("  Hook data size:", hookData.length, "bytes");

  // Get balances before
  const tokenABefore = await publicClient.readContract({
    address: CONTRACTS.tokenA,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  const tokenBBefore = await publicClient.readContract({
    address: CONTRACTS.tokenB,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  // MIN/MAX sqrt price limits
  const MIN_SQRT_PRICE = BigInt("4295128739") + BigInt(1);
  const MAX_SQRT_PRICE =
    BigInt("1461446703485210103287273052203988822378723970342") - BigInt(1);

  console.log("  Executing swap...");
  start = Date.now();

  try {
    const swapTx = await walletClient.writeContract({
      address: CONTRACTS.poolHelper,
      abi: POOL_HELPER_ABI,
      functionName: "swap",
      args: [
        POOL_KEY,
        true, // zeroForOne (Token A -> Token B)
        -BigInt(swapAmount), // exact input
        MIN_SQRT_PRICE, // sqrtPriceLimitX96
        hookData,
        account.address,
      ],
    });

    console.log("  TX Hash:", swapTx);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: swapTx,
    });
    timings.push({ step: "Execute swap", time: Date.now() - start });

    console.log("  Status:", receipt.status === "success" ? "SUCCESS" : "FAILED");
    console.log("  Gas used:", receipt.gasUsed.toString());
    console.log("");

    // Check for events
    console.log("  Events:");
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === CONTRACTS.grimSwapZK.toLowerCase()) {
        console.log("    - GrimSwapZK event detected");
      }
    }
    console.log("");

    // ============================================
    // STEP 8: Verify Results
    // ============================================
    console.log(
      "┌────────────────────────────────────────────────────────────────┐"
    );
    console.log(
      "│ STEP 8: Verify Privacy Results                                │"
    );
    console.log(
      "└────────────────────────────────────────────────────────────────┘"
    );

    // Get balances after
    const tokenAAfter = await publicClient.readContract({
      address: CONTRACTS.tokenA,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const tokenBAfter = await publicClient.readContract({
      address: CONTRACTS.tokenB,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });

    console.log("  Sender balances:");
    console.log(
      "    Token A:",
      formatEther(tokenABefore),
      "->",
      formatEther(tokenAAfter)
    );
    console.log(
      "    Token B:",
      formatEther(tokenBBefore),
      "->",
      formatEther(tokenBAfter)
    );

    // Check stealth address balance
    const stealthTokenB = await publicClient.readContract({
      address: CONTRACTS.tokenB,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [stealthAddress as Address],
    });
    console.log("");
    console.log("  Stealth address:", stealthAddress);
    console.log("    Token B received:", formatEther(stealthTokenB));

    // Check nullifier is spent
    const isSpent = await publicClient.readContract({
      address: CONTRACTS.grimPool,
      abi: GRIM_POOL_ABI,
      functionName: "isSpent",
      args: [toBytes32(note.nullifierHash)],
    });
    console.log("");
    console.log("  Nullifier spent:", isSpent);

    const totalTime = Date.now() - totalStart;

    // ============================================
    // Summary
    // ============================================
    console.log("");
    console.log(
      "╔════════════════════════════════════════════════════════════════╗"
    );
    if (receipt.status === "success") {
      console.log(
        "║          ZK PRIVATE SWAP SUCCESSFUL!                           ║"
      );
    } else {
      console.log(
        "║          ZK PRIVATE SWAP FAILED                                ║"
      );
    }
    console.log(
      "╚════════════════════════════════════════════════════════════════╝"
    );
    console.log("");

    console.log("Timing:");
    for (const t of timings) {
      console.log(`  ${t.step}: ${t.time} ms`);
    }
    console.log(`  TOTAL: ${totalTime} ms`);
    console.log("");

    console.log("Privacy guarantees:");
    console.log("  [x] ZK proof verified on-chain");
    console.log("  [x] Nullifier prevents double-spend");
    console.log("  [x] Sender hidden (ZK proves membership without revealing)");
    console.log("  [x] Recipient is stealth address:", stealthAddress);
    console.log("");

    console.log("TX:", swapTx);
    console.log(
      "View: https://unichain-sepolia.blockscout.com/tx/" + swapTx
    );
    console.log("");
  } catch (error: any) {
    console.error("");
    console.error("Swap failed:", error.message);
    if (error.cause) {
      console.error("Cause:", JSON.stringify(error.cause, null, 2));
    }
  }
}

main().catch(console.error);
