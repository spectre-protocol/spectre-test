/**
 * GRIMSWAP - ZK On-Chain Test
 *
 * Tests:
 * 1. Generate ZK proof locally with Poseidon Merkle tree
 * 2. Verify proof on-chain via Groth16Verifier
 * 3. (Optional) Deposit to GrimPool
 *
 * Run: PRIVATE_KEY=0x... npm run test:zk:onchain
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
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

// Deployed contracts
const CONTRACTS = {
  grimPool: "0x0102Ba64Eefdbf362E402B9dCe0Cf9edfab611f5" as Address,
  groth16Verifier: "0x2AAaCece42E8ec7C6066D547C81a9e7cF09dBaeA" as Address,
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
  return { secret, nullifier, amount, commitment, nullifierHash };
}

function formatCommitment(commitment: bigint): Hex {
  return ("0x" + commitment.toString(16).padStart(64, "0")) as Hex;
}

// Merkle tree using Poseidon hashing (matches the ZK circuit)
class PoseidonMerkleTree {
  private height: number;
  private leaves: bigint[] = [];
  private zeros: bigint[] = [];
  private layers: bigint[][] = [];

  constructor(height: number = MERKLE_TREE_HEIGHT) {
    this.height = height;
  }

  async initialize() {
    this.zeros = [ZERO_VALUE];
    for (let i = 1; i <= this.height; i++) {
      const prevZero = this.zeros[i - 1];
      this.zeros[i] = await this.hashLeftRight(prevZero, prevZero);
    }
    this.layers = [];
    for (let i = 0; i <= this.height; i++) {
      this.layers[i] = [];
    }
  }

  private async hashLeftRight(left: bigint, right: bigint): Promise<bigint> {
    return await poseidonHash([left, right]);
  }

  async insert(leaf: bigint): Promise<number> {
    if (this.zeros.length === 0) {
      await this.initialize();
    }
    const index = this.leaves.length;
    this.leaves.push(leaf);

    let currentIndex = index;
    let currentValue = leaf;
    this.layers[0][index] = currentValue;

    for (let level = 0; level < this.height; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      const sibling = this.layers[level][siblingIndex] ?? this.zeros[level];
      const [left, right] = isLeft ? [currentValue, sibling] : [sibling, currentValue];
      currentValue = await this.hashLeftRight(left, right);
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
    return { root: this.getRoot(), pathElements, pathIndices };
  }
}

async function generateZKProof(
  note: DepositNote,
  merkleProof: { root: bigint; pathElements: bigint[]; pathIndices: number[] },
  recipient: string,
  relayer: string,
  relayerFee: string,
  swapAmountOut: string
) {
  const circuitsPath = path.resolve(__dirname, "../../grimswap-circuits");
  const wasmPath = path.join(circuitsPath, "build/privateSwap_js/privateSwap.wasm");
  const zkeyPath = path.join(circuitsPath, "setup/privateSwap_final.zkey");

  const input = {
    merkleRoot: merkleProof.root.toString(),
    nullifierHash: note.nullifierHash.toString(),
    recipient,
    relayer,
    relayerFee,
    swapAmountOut,
    secret: note.secret.toString(),
    nullifier: note.nullifier.toString(),
    depositAmount: note.amount.toString(),
    pathElements: merkleProof.pathElements.map((e) => e.toString()),
    pathIndices: merkleProof.pathIndices,
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  return { proof, publicSignals };
}

function formatProofForContract(proof: any, publicSignals: string[]) {
  return {
    pA: [proof.pi_a[0], proof.pi_a[1]] as [string, string],
    pB: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ] as [[string, string], [string, string]],
    pC: [proof.pi_c[0], proof.pi_c[1]] as [string, string],
    pubSignals: publicSignals.map((s) => BigInt(s)),
  };
}

async function main() {
  console.log("");
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║       GRIMSWAP - ZK ON-CHAIN TEST                              ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log("");

  const privateKey = process.env.PRIVATE_KEY as Hex;
  if (!privateKey) {
    console.error("ERROR: Set PRIVATE_KEY environment variable");
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

  // Check balance
  const ethBalance = await publicClient.getBalance({ address: account.address });
  console.log("ETH Balance:", formatEther(ethBalance), "ETH");
  console.log("");

  console.log("Deployed Contracts:");
  console.log("  GrimPool:", CONTRACTS.grimPool);
  console.log("  Groth16Verifier:", CONTRACTS.groth16Verifier);
  console.log("");

  // Initialize Poseidon
  await initPoseidon();

  // ============================================
  // STEP 1: Create Deposit Note
  // ============================================
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ STEP 1: Create Deposit Note                                   │");
  console.log("└────────────────────────────────────────────────────────────────┘");

  const depositAmount = parseEther("0.001");
  const note = await createDepositNote(depositAmount);
  console.log("  Amount:", formatEther(note.amount), "ETH");
  console.log("  Commitment:", formatCommitment(note.commitment).slice(0, 42) + "...");
  console.log("  NullifierHash:", formatCommitment(note.nullifierHash).slice(0, 42) + "...");
  console.log("");

  // ============================================
  // STEP 2: Build Local Poseidon Merkle Tree
  // ============================================
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ STEP 2: Build Poseidon Merkle Tree (matches circuit)          │");
  console.log("└────────────────────────────────────────────────────────────────┘");

  const tree = new PoseidonMerkleTree(MERKLE_TREE_HEIGHT);
  await tree.initialize();
  const leafIndex = await tree.insert(note.commitment);
  note.leafIndex = leafIndex;

  const root = tree.getRoot();
  console.log("  Leaf index:", leafIndex);
  console.log("  Merkle root:", formatCommitment(root).slice(0, 42) + "...");
  console.log("");

  // Generate Merkle proof
  const merkleProof = tree.getProof(leafIndex);
  console.log("  Path elements:", merkleProof.pathElements.length);
  console.log("");

  // ============================================
  // STEP 3: Generate ZK Proof
  // ============================================
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ STEP 3: Generate Groth16 ZK Proof                             │");
  console.log("└────────────────────────────────────────────────────────────────┘");

  // Convert address to BigInt for circuit (address is 160-bit number)
  const recipientBigInt = BigInt(account.address).toString();
  console.log("  Recipient (as BigInt):", recipientBigInt.slice(0, 20) + "...");
  console.log("  Generating proof...");

  const startTime = Date.now();

  try {
    const { proof, publicSignals } = await generateZKProof(
      note,
      merkleProof,
      recipientBigInt,
      "0", // relayer
      "0", // relayerFee
      note.amount.toString() // swapAmountOut
    );

    const proofTime = Date.now() - startTime;
    console.log("  Proof generated in:", proofTime, "ms");
    console.log("  Public signals:", publicSignals.length);
    console.log("");

    // Show public signals
    console.log("  Public signals breakdown:");
    console.log("    [0] merkleRoot:", publicSignals[0].slice(0, 20) + "...");
    console.log("    [1] nullifierHash:", publicSignals[1].slice(0, 20) + "...");
    console.log("    [2] recipient:", publicSignals[2].slice(0, 20) + "...");
    console.log("    [3] relayer:", publicSignals[3]);
    console.log("    [4] relayerFee:", publicSignals[4]);
    console.log("    [5] swapAmountOut:", publicSignals[5]);
    console.log("    [6] depositAmount:", publicSignals[6]);
    console.log("    [7] commitmentOut:", publicSignals[7].slice(0, 20) + "...");
    console.log("");

    // ============================================
    // STEP 4: Verify Proof Locally First
    // ============================================
    console.log("┌────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 4: Verify Proof Locally                                  │");
    console.log("└────────────────────────────────────────────────────────────────┘");

    const circuitsPath = path.resolve(__dirname, "../../grimswap-circuits");
    const vkeyPath = path.join(circuitsPath, "setup/verification_key.json");
    const vkeyJson = await import(vkeyPath, { assert: { type: "json" } });

    const localVerify = await snarkjs.groth16.verify(vkeyJson.default, publicSignals, proof);
    console.log("  Local verification:", localVerify ? "VALID" : "INVALID");
    console.log("");

    // ============================================
    // STEP 5: Verify Proof On-Chain
    // ============================================
    console.log("┌────────────────────────────────────────────────────────────────┐");
    console.log("│ STEP 5: Verify Proof On-Chain (Groth16Verifier)               │");
    console.log("└────────────────────────────────────────────────────────────────┘");

    const contractProof = formatProofForContract(proof, publicSignals);

    console.log("  Calling verifyProof() on", CONTRACTS.groth16Verifier.slice(0, 12) + "...");

    const isValid = await publicClient.readContract({
      address: CONTRACTS.groth16Verifier,
      abi: GROTH16_VERIFIER_ABI,
      functionName: "verifyProof",
      args: [
        contractProof.pA.map(BigInt) as [bigint, bigint],
        contractProof.pB.map((row) => row.map(BigInt)) as [[bigint, bigint], [bigint, bigint]],
        contractProof.pC.map(BigInt) as [bigint, bigint],
        contractProof.pubSignals as [
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint
        ],
      ],
    });

    console.log("");
    console.log("  ON-CHAIN VERIFICATION:", isValid ? "VALID" : "INVALID");
    console.log("");

    // ============================================
    // Summary
    // ============================================
    console.log("╔════════════════════════════════════════════════════════════════╗");
    if (isValid) {
      console.log("║          ZK ON-CHAIN TEST SUCCESSFUL!                          ║");
    } else {
      console.log("║          ZK ON-CHAIN TEST FAILED                               ║");
    }
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log("");
    console.log("Summary:");
    console.log("  - Poseidon commitment created");
    console.log("  - Merkle tree built with 20 levels");
    console.log("  - Groth16 proof generated in", proofTime, "ms");
    console.log("  - Local verification:", localVerify ? "PASSED" : "FAILED");
    console.log("  - On-chain verification:", isValid ? "PASSED" : "FAILED");
    console.log("");
    console.log("Contracts verified:");
    console.log("  Groth16Verifier:", CONTRACTS.groth16Verifier);
    console.log("  GrimPool:", CONTRACTS.grimPool);
    console.log("");
  } catch (error: any) {
    console.error("");
    console.error("Error:", error.message);
    if (error.cause) {
      console.error("Cause:", error.cause);
    }
    console.error("");
    console.error("Stack:", error.stack);
  }
}

main().catch(console.error);
