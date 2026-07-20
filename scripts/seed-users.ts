import { db } from "../lib/db";
import { users } from "../lib/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

const args = process.argv.slice(2);
const username = args[0];
const password = args[1];
const name = args[2] ?? username;
const role = args[3] ?? "member";

if (!username || !password) {
  console.log("Usage: npx tsx scripts/seed-users.ts <username> <password> [name] [role]");
  console.log("  role: admin (default) or member");
  process.exit(1);
}

const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);
if (existing[0]) {
  console.log(`User '${username}' already exists`);
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
await db.insert(users).values({ username, passwordHash: hash, name, role });
console.log(`Created user '${username}' (role: ${role})`);
