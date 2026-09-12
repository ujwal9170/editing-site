import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const KEY_LENGTH = 64;
const USERNAME = /^[a-z0-9._-]{3,32}$/;

export function normalizeUsername(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const key = await derive(password, salt, KEY_LENGTH);
  return { salt, hash: key.toString("hex") };
}

export async function verifyPassword(password, salt, hash) {
  const expected = Buffer.from(String(hash ?? ""), "hex");
  // A wrong-length stored hash would make timingSafeEqual throw, so bail first.
  if (expected.length !== KEY_LENGTH) return false;
  const key = await derive(String(password ?? ""), String(salt ?? ""), KEY_LENGTH);
  return timingSafeEqual(key, expected);
}

export function findUser(repo, username) {
  const name = normalizeUsername(username);
  if (!name) return null;
  return repo.list("user").find((u) => u.username === name) ?? null;
}

export const ADMIN = "admin";
export const MEMBER = "member";

export function isAdmin(user) {
  return user?.role === ADMIN;
}

export function listUsers(repo) {
  return repo
    .list("user")
    .map(({ id, username, createdAt, role, lastSeenAt }) => ({
      id,
      username,
      createdAt,
      role: role ?? MEMBER,
      lastSeenAt: lastSeenAt ?? null,
    }));
}

export function admins(repo) {
  return repo.list("user").filter(isAdmin);
}

export function setRole(repo, username, role) {
  if (![ADMIN, MEMBER].includes(role))
    throw new Error(`Role must be "${ADMIN}" or "${MEMBER}".`);
  const user = findUser(repo, username);
  if (!user) throw new Error(`No user named "${normalizeUsername(username)}".`);
  // Removing the last admin would leave nobody able to manage accounts.
  if (user.role === ADMIN && role === MEMBER && admins(repo).length <= 1)
    throw new Error(
      "This is the only admin. Promote someone else before demoting this account.",
    );
  return repo.put("user", { ...user, role });
}

export function hasUsers(repo) {
  return repo.list("user").length > 0;
}

export async function createUser(repo, username, password, role = MEMBER) {
  const name = normalizeUsername(username);
  if (!USERNAME.test(name))
    throw new Error(
      "Username must be 3-32 characters using letters, numbers, dot, dash or underscore.",
    );
  if (String(password ?? "").length < 8)
    throw new Error("Password must be at least 8 characters.");
  if (findUser(repo, name)) throw new Error(`User "${name}" already exists.`);
  const { salt, hash } = await hashPassword(password);
  return repo.put("user", { username: name, salt, hash, role });
}

export async function setPassword(repo, username, password) {
  const user = findUser(repo, username);
  if (!user) throw new Error(`No user named "${normalizeUsername(username)}".`);
  if (String(password ?? "").length < 8)
    throw new Error("Password must be at least 8 characters.");
  const { salt, hash } = await hashPassword(password);
  return repo.put("user", { ...user, salt, hash });
}

export async function authenticate(repo, username, password) {
  const user = findUser(repo, username);
  // Still run a hash on a dummy salt when the user is missing, so a wrong
  // username and a wrong password take about the same time to answer.
  if (!user) {
    await hashPassword(String(password ?? ""), "0".repeat(32));
    return null;
  }
  return (await verifyPassword(password, user.salt, user.hash)) ? user : null;
}
