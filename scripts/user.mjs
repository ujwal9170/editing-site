/* Account admin. Accounts are created here rather than through the API so the
 * server exposes no signup or privilege-granting route at all. */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { createRepository } from "../server/repository.mjs";
import {
  ADMIN,
  MEMBER,
  createUser,
  findUser,
  listUsers,
  setPassword,
  setRole,
} from "../server/users.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");
const repo = createRepository(path.resolve(process.env.DATA_DIR || "runtime"));
const [command, username, inline] = process.argv.slice(2);

async function askSecret(prompt) {
  // Echo is suppressed while the answer is being typed so the password is not
  // left sitting on screen (or in a screen-share) after the command finishes.
  let hide = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!hide) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  try {
    const answer = rl.question(prompt);
    hide = true;
    const value = await answer;
    return value;
  } finally {
    hide = false;
    rl.close();
    process.stdout.write("\n");
  }
}

function usage() {
  console.log(`Usage:
  pnpm user add <username> [password]      create an account
  pnpm user passwd <username> [password]   change a password
  pnpm user list                           list accounts
  pnpm user remove <username>              delete an account (keeps their media)
  pnpm user promote <username>             make an admin
  pnpm user demote <username>              make an ordinary member

Passing the password inline is optional; leave it off to be prompted instead
of putting it in your shell history.

Admin rights can only be granted here, never through the web app, so a stolen
admin session cannot create more admins.`);
}

try {
  if (command === "list") {
    const users = listUsers(repo);
    if (!users.length) console.log("No accounts yet. Create one with: pnpm user add <username>");
    for (const u of users)
      console.log(
        `${u.username}\t${u.role}\t${new Date(u.createdAt).toLocaleString()}`,
      );
  } else if (command === "promote" || command === "demote") {
    if (!username) throw new Error("A username is required.");
    const user = setRole(repo, username, command === "promote" ? ADMIN : MEMBER);
    console.log(`"${user.username}" is now ${user.role}.`);
  } else if (command === "add" || command === "passwd") {
    if (!username) throw new Error("A username is required.");
    const password = inline || (await askSecret(`Password for "${username}": `));
    const user =
      command === "add"
        ? await createUser(repo, username, password)
        : await setPassword(repo, username, password);
    console.log(
      `${command === "add" ? "Created" : "Updated"} account "${user.username}".`,
    );
  } else if (command === "remove") {
    const user = findUser(repo, username);
    if (!user) throw new Error(`No user named "${username}".`);
    repo.remove("user", user.id);
    console.log(
      `Removed account "${user.username}". Their media and edits are still on disk; delete them from the workspace if they are no longer wanted.`,
    );
  } else {
    usage();
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  repo.close();
}
