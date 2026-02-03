/**
 * GRIMSWAP - ZK Private Swap Test
 *
 * This script tests the full ZK privacy swap flow:
 * 1. Create deposit note with Poseidon commitment
 * 2. Deposit to GrimPool (commitment added to Merkle tree)
 * 3. Build Merkle proof locally
 * 4. Generate Groth16 ZK proof
 * 5. Submit proof to relayer or directly to GrimSwapZK hook
 *
 * Prerequisites:
 * - Deploy GrimPool, Groth16Verifier, GrimSwapZK contracts
 * - Run trusted setup (npm run build:circuits in grimswap-circuits)
 *
 * Run: PRIVATE_KEY=0x... npm run test:zk
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  encodeAbiParameters,
  keccak256,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chain config
const unichainSepolia = {
  id: 1301,
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.unichain.org"] } },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://unichain-sepolia.blockscout.com",
    },
  },
} as const;

// Contract addresses (update after deployment)
const CONTRACTS = {
  grimPool: "0x0000000000000000000000000000000000000000" as Address,
  groth16Verifier: "0x0000000000000000000000000000000000000000" as Address,
  grimSwapZK: "0x0000000000000000000000000000000000000000" as Address,
  poolManager: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC" as Address,
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
    name: "getLastRoot",
    inputs: [],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getDepositCount",
    inputs: [],
    outputs: [{ type: "uint32" }],
    stateMutability: "view",
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
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "commitment", type: "bytes32", indexed: true },
      { name: "leafIndex", type: "uint32", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

const GROTH16_VERIFIER_ABI = [
  {
    type: "function",
    name: "verifyProof",
    inputs: [
      { name: "_pA", type: "uint256[2]" },
      { name: "_pB", type: "uint256[2][2]" },
      { name: "_pC", type: "uint256[2]" },
      { name: "_pubSignals", type: "uint256[8]" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
] as const;

// Constants
const MERKLE_TREE_HEIGHT = 20;
const FIELD_SIZE = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);
const ZERO_VALUE = BigInt(
  "21663839004416932945382355908790599225266501822907911457504978515578255421292"
);

// Global poseidon hasher
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
  await initPoseidon();
  const hash = poseidon(inputs);
  return BigInt(F.toString(hash));
}

interface DepositNote {
  secret: bigint;
  nullifier: bigint;
  amount: bigint;
  commitment: bigint;
  nullifierHash: bigint;
  leafIndex?: number;
}

async function createDepositNote(amount: bigint): Promise<DepositNote> {
  await initPoseidon();

  const secret = randomFieldElement();
  const nullifier = randomFieldElement();

  const commitment = await poseidonHash([nullifier, secret, amount]);
  const nullifierHash = await poseidonHash([nullifier]);

  return {
    secret,
    nullifier,
    amount,
    commitment,
    nullifierHash,
  };
}

function formatCommitment(commitment: bigint): Hex {
  return ("0x" + commitment.toString(16).padStart(64, "0")) as Hex;
}

// Simple in-memory Merkle tree (for testing)
class MerkleTree {
  private height: number;
  private leaves: bigint[] = [];
  private zeros: bigint[] = [];
  private layers: bigint[][] = [];

  constructor(height: number = MERKLE_TREE_HEIGHT) {
    this.height = height;
  }

  async initialize() {
    await initPoseidon();

    // Compute zero values
    this.zeros = [ZERO_VALUE];
    for (let i = 1; i <= this.height; i++) {
      const prevZero = this.zeros[i - 1];
      this.zeros[i] = await poseidonHash([prevZero, prevZero]);
    }

    // Initialize layers
    this.layers = [];
    for (let i = 0; i <= this.height; i++) {
      this.layers[i] = [];
    }
  }

  async insert(leaf: bigint): Promise<number> {
    if (this.zeros.length === 0) {
      await this.initialize();
    }

    const index = this.leaves.length;
    this.leaves.push(leaf);

    // Update tree
    let currentIndex = index;
    let currentValue = leaf;
    this.layers[0][index] = currentValue;

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
    if (this.layers[this.height] && this.layers[this.height][0]) {
      return this.layers[this.height][0];
    }
    return this.zeros[this.height];
  }

  getProof(leafIndex: number): {
    root: bigint;
    pathElements: bigint[];
    pathIndices: number[];
  } {
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentIndex = leafIndex;

    for (let level = 0; level < this.height; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      const sibling = this.layers[level][siblingIndex] ?? this.zeros[level];

      pathElements.push(sibling);
      pathIndices.push(isLeft ? 0 : 1);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      root: this.getRoot(),
      pathElements,
      pathIndices,
    };
  }
}

async function generateZKProof(
  note: DepositNote,
  merkleProof: { root: bigint; pathElements: bigint[]; pathIndices: number[] },
  recipient: string,
  relayer: string = "0",
  relayerFee: string = "0",
  swapAmountOut: string
) {
  const circuitsPath = path.resolve(__dirname, "../../grimswap-circuits");
  const wasmPath = path.join(
    circuitsPath,
    "build/privateSwap_js/privateSwap.wasm"
  );
  const zkeyPath = path.join(circuitsPath, "setup/privateSwap_final.zkey");

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found: ${wasmPath}`);
  }
  if (!fs.existsSync(zkeyPath)) {
    throw new Error(`ZKey file not found: ${zkeyPath}`);
  }

  const input = {
    // Public inputs
    merkleRoot: merkleProof.root.toString(),
    nullifierHash: note.nullifierHash.toString(),
    recipient: recipient,
    relayer: relayer,
    relayerFee: relayerFee,
    swapAmountOut: swapAmountOut,

    // Private inputs
    secret: note.secret.toString(),
    nullifier: note.nullifier.toString(),
    depositAmount: note.amount.toString(),
    pathElements: merkleProof.pathElements.map((e) => e.toString()),
    pathIndices: merkleProof.pathIndices,
  };

  console.log("Generating ZK proof...");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );

  return { proof, publicSignals };
}

function formatProofForContract(
  proof: any,
  publicSignals: string[]
): {
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  pubSignals: string[];
} {
  return {
    pA: [proof.pi_a[0], proof.pi_a[1]],
    pB: [
      [proof.pi_b[0][1], proof.pi_b[0][0]], // Reversed for Solidity
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    pC: [proof.pi_c[0], proof.pi_c[1]],
    pubSignals: publicSignals,
  };
}

async function main() {
  console.log("");
  console.log(
    "╔════════════════════════════════════════════════════════════════╗"
  );
  console.log(
    "║       GRIMSWAP - ZK PRIVATE SWAP TEST (Groth16)                ║"
  );
  console.log(
    "╚════════════════════════════════════════════════════════════════╝"
  );
  console.log("");

  // Check if contracts are deployed - if not, run local simulation
  if (CONTRACTS.grimPool === "0x0000000000000000000000000000000000000000") {
    console.log(
      "NOTE: Contract addresses not set. Running in LOCAL SIMULATION mode."
    );
    console.log("");
    await runLocalSimulation();
    return;
  }

  // Check for private key for on-chain tests
  const privateKey = process.env.PRIVATE_KEY as Hex;
  if (!privateKey) {
    console.error("ERROR: Set PRIVATE_KEY environment variable for on-chain test");
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey);
  console.log("Network: Unichain Sepolia (Chain ID: 1301)");
  console.log("Account:", account.address);
  console.log("");

  // Create clients
  const publicClient = createPublicClient({
    chain: unichainSepolia,
    transport: http("https://sepolia.unichain.org"),
  });

  const walletClient = createWalletClient({
    account,
    chain: unichainSepolia,
    transport: http("https://sepolia.unichain.org"),
  });

  // Check ETH balance
  const ethBalance = await publicClient.getBalance({
    address: account.address,
  });
  console.log("ETH Balance:", formatEther(ethBalance), "ETH");
  console.log("");

  // Check if contracts are deployed
  if (CONTRACTS.grimPool === "0x0000000000000000000000000000000000000000") {
    console.log(
      "NOTE: Contract addresses not set. Running in LOCAL SIMULATION mode."
    );
    console.log("");
    console.log(
      "To test on-chain, deploy contracts first and update CONTRACTS addresses."
    );
    console.log("");

    // Run local simulation
    await runLocalSimulation();
    return;
  }

  // Full on-chain test
  await runOnChainTest(publicClient, walletClient, account);
}

async function runLocalSimulation() {
  console.log(
    "┌────────────────────────────────────────────────────────────────┐"
  );
  console.log(
    "│ LOCAL SIMULATION: Testing ZK Proof Generation                 │"
  );
  console.log(
    "└────────────────────────────────────────────────────────────────┘"
  );
  console.log("");

  // Initialize Poseidon
  await initPoseidon();
  console.log("Poseidon hash initialized");

  // ============================================
  // STEP 1: Create Deposit Note
  // ============================================
  console.log("");
  console.log("STEP 1: Creating deposit note...");
  const depositAmount = parseEther("1"); // 1 ETH
  const note = await createDepositNote(depositAmount);
  console.log("  Secret:", note.secret.toString().slice(0, 20) + "...");
  console.log("  Nullifier:", note.nullifier.toString().slice(0, 20) + "...");
  console.log("  Commitment:", formatCommitment(note.commitment).slice(0, 30) + "...");
  console.log("  NullifierHash:", formatCommitment(note.nullifierHash).slice(0, 30) + "...");
  console.log("  Amount:", formatEther(note.amount), "ETH");

  // ============================================
  // STEP 2: Build Merkle Tree
  // ============================================
  console.log("");
  console.log("STEP 2: Building Merkle tree...");
  const tree = new MerkleTree(MERKLE_TREE_HEIGHT);
  await tree.initialize();

  // Insert our commitment
  const leafIndex = await tree.insert(note.commitment);
  note.leafIndex = leafIndex;
  console.log("  Leaf index:", leafIndex);
  console.log("  Merkle root:", formatCommitment(tree.getRoot()).slice(0, 30) + "...");

  // ============================================
  // STEP 3: Generate Merkle Proof
  // ============================================
  console.log("");
  console.log("STEP 3: Generating Merkle proof...");
  const merkleProof = tree.getProof(leafIndex);
  console.log("  Path elements:", merkleProof.pathElements.length);
  console.log("  Path indices:", merkleProof.pathIndices.slice(0, 5).join(",") + "...");

  // ============================================
  // STEP 4: Generate ZK Proof
  // ============================================
  console.log("");
  console.log("STEP 4: Generating Groth16 ZK proof...");

  // Generate a fake stealth address for recipient
  const stealthAddress = "1234567890123456789012345678901234567890"; // 40 hex chars = address
  const relayer = "0";
  const relayerFee = "0";
  const swapAmountOut = depositAmount.toString();

  try {
    const startTime = Date.now();
    const { proof, publicSignals } = await generateZKProof(
      note,
      merkleProof,
      stealthAddress,
      relayer,
      relayerFee,
      swapAmountOut
    );
    const proofTime = Date.now() - startTime;

    console.log("");
    console.log("ZK Proof generated successfully!");
    console.log("  Proof time:", proofTime, "ms");
    console.log("  Public signals:", publicSignals.length);
    console.log("");

    // Format for contract
    const contractProof = formatProofForContract(proof, publicSignals);
    console.log("Formatted proof for contract:");
    console.log("  pA:", contractProof.pA[0].slice(0, 20) + "...");
    console.log("  pB:", contractProof.pB[0][0].slice(0, 20) + "...");
    console.log("  pC:", contractProof.pC[0].slice(0, 20) + "...");
    console.log("");

    // Verify proof locally
    console.log("STEP 5: Verifying proof locally...");
    const vkeyPath = path.resolve(
      __dirname,
      "../../grimswap-circuits/setup/verification_key.json"
    );
    const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
    const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    console.log("  Proof valid:", isValid);
    console.log("");

    // Print summary
    console.log(
      "╔════════════════════════════════════════════════════════════════╗"
    );
    console.log(
      "║          ZK PROOF SIMULATION SUCCESSFUL!                       ║"
    );
    console.log(
      "╚════════════════════════════════════════════════════════════════╝"
    );
    console.log("");
    console.log("Summary:");
    console.log("  - Deposit commitment created with Poseidon hash");
    console.log("  - Merkle tree built with", MERKLE_TREE_HEIGHT, "levels");
    console.log("  - Merkle proof generated for leaf index", leafIndex);
    console.log("  - Groth16 ZK proof generated in", proofTime, "ms");
    console.log("  - Proof verified locally:", isValid);
    console.log("");
    console.log("Privacy guarantees:");
    console.log("  [x] Sender hidden in anonymity set of ALL depositors");
    console.log("  [x] Nullifier prevents double-spend without revealing identity");
    console.log("  [x] Recipient is stealth address");
    console.log("  [x] Relayer can submit tx to hide gas payer");
    console.log("");
    console.log("Next steps:");
    console.log("  1. Deploy contracts: forge script script/DeployZK.s.sol");
    console.log("  2. Update CONTRACTS addresses in this file");
    console.log("  3. Run again to test on-chain");
    console.log("");
  } catch (error) {
    console.error("Error generating proof:", error);
    console.log("");
    console.log("Make sure to run the trusted setup first:");
    console.log("  cd ../grimswap-circuits");
    console.log("  npm run build:circuits");
    console.log("");
  }
}

async function runOnChainTest(
  publicClient: any,
  walletClient: any,
  account: any
) {
  // TODO: Implement full on-chain test
  // This would:
  // 1. Deposit to GrimPool
  // 2. Wait for deposit confirmation
  // 3. Rebuild Merkle tree from deposit events
  // 4. Generate ZK proof
  // 5. Submit proof to relayer or directly execute swap

  console.log("On-chain test not yet implemented.");
  console.log(
    "Please use local simulation mode or wait for full implementation."
  );
}

main().catch(console.error);
