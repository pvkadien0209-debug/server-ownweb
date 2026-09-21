// mongodb.js
import { MongoClient, ServerApiVersion } from "mongodb";

const uri =
  "mongodb+srv://pvkadien0209_db_user:1gAGKLCnjgDngIM4@cluster0.kauqnpn.mongodb.net";
const dbName = "pvkadien0209_db_user";

if (!uri) {
  throw new Error("Missing MONGODB_URI in environment variables");
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db = null;
let isConnected = false;

/**
 * Gọi 1 lần khi server khởi động (trong server.js)
 */
export async function connectMongo() {
  if (isConnected) return db;
  try {
    await client.connect();
    await client.db(dbName).command({ ping: 1 });
    db = client.db(dbName);
    isConnected = true;
    console.log(`✅ MongoDB connected: ${dbName}`);
    return db;
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    throw err;
  }
}

/**
 * Lấy db instance ở bất kỳ file router nào (đã connect trước đó)
 */
export function getDb() {
  if (!db) {
    throw new Error("MongoDB chưa được connect. Gọi connectMongo() trước.");
  }
  return db;
}

export function getCollection(name) {
  return getDb().collection(name);
}

export async function closeMongo() {
  await client.close();
  isConnected = false;
  console.log("MongoDB connection closed");
}
