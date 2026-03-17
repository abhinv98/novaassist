const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".novaassist");
const MEMORY_FILE = path.join(CONFIG_DIR, "memory.json");
const MAX_MEMORIES = 200;

const client = new BedrockRuntimeClient({ region: "us-east-1" });

let memories = [];

function loadMemories() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (fs.existsSync(MEMORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
      memories = Array.isArray(data) ? data : [];
      console.log(`Memory: loaded ${memories.length} memories from disk`);
    }
  } catch (e) {
    console.error("Memory: failed to load:", e.message);
    memories = [];
  }
}

function saveMemories() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2));
  } catch (e) {
    console.error("Memory: failed to save:", e.message);
  }
}

async function embed(text, purpose = "GENERIC_INDEX") {
  const body = JSON.stringify({
    schemaVersion: "nova-multimodal-embed-v1",
    taskType: "SINGLE_EMBEDDING",
    singleEmbeddingParams: {
      embeddingPurpose: purpose,
      embeddingDimension: 256,
      text: { value: text, truncationMode: "END" },
    },
  });

  const command = new InvokeModelCommand({
    modelId: "amazon.nova-2-multimodal-embeddings-v1:0",
    body,
    contentType: "application/json",
    accept: "application/json",
  });

  const response = await client.send(command);
  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.embedding;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function timeAgo(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

async function storeMemory(summary, actionType, success) {
  try {
    const embedding = await embed(summary, "GENERIC_INDEX");
    const entry = {
      summary,
      embedding,
      timestamp: new Date().toISOString(),
      actionType: actionType || "unknown",
      success: success !== false,
    };
    memories.push(entry);
    if (memories.length > MAX_MEMORIES) {
      memories = memories.slice(-MAX_MEMORIES);
    }
    saveMemories();
    console.log(`Memory: stored "${summary.substring(0, 60)}..."`);
  } catch (e) {
    console.error("Memory: failed to store:", e.message);
  }
}

async function recallMemories(query, topK = 3) {
  if (memories.length === 0) return [];

  try {
    const queryEmbedding = await embed(query, "GENERIC_RETRIEVAL");
    const scored = memories
      .map((m) => ({ ...m, score: cosine(queryEmbedding, m.embedding) }))
      .filter((m) => m.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map((m) => ({
      summary: m.summary,
      timeAgo: timeAgo(m.timestamp),
      actionType: m.actionType,
      success: m.success,
      score: m.score,
    }));
  } catch (e) {
    console.error("Memory: failed to recall:", e.message);
    return [];
  }
}

function formatMemoriesForContext(recalled) {
  if (!recalled || recalled.length === 0) return "";
  const lines = recalled.map(
    (m, i) =>
      `[${i + 1}] ${m.timeAgo}: ${m.summary} (${m.success ? "Success" : "Failed"})`
  );
  return `\nPrevious interactions:\n${lines.join("\n")}`;
}

function getMemoryCount() {
  return memories.length;
}

module.exports = {
  loadMemories,
  storeMemory,
  recallMemories,
  formatMemoriesForContext,
  getMemoryCount,
};
