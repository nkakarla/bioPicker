#!/usr/bin/env node
// BioPicker admin tasks, run on the server (same DATA_DIR as the app).
// Stop the server before claim, reset-2fa or unpublish, then start it again: the running
// server keeps users and biopics in memory and would overwrite the change.
//   node scripts/admin.js users                    list accounts
//   node scripts/admin.js claim <username>         give every biopic from before accounts to <username>
//   node scripts/admin.js reset-2fa <username>     user sets up a new authenticator at next sign-in
//   node scripts/admin.js reports                  list reports about public biopics
//   node scripts/admin.js unpublish <projectId>    make a public biopic private
// Copyright (c) 2026 ePerf
import fs from "node:fs";
import path from "node:path";
import { allUsers, findUser, resetTwoFactor } from "../lib/auth.js";
import { allProjects, claimUnowned, loadProject, saveProject } from "../lib/store.js";
import { DATA_DIR } from "../lib/util.js";

const [cmd, arg] = process.argv.slice(2);
const need = (x, what) => {
  if (!x) {
    console.error(`Missing ${what}.`);
    process.exit(1);
  }
  return x;
};
const user = (name) => findUser(need(name, "username")) || (console.error(`No account named “${name}”.`), process.exit(1));

switch (cmd) {
  case "users": {
    const counts = {};
    for (const p of allProjects()) counts[p.ownerId] = (counts[p.ownerId] || 0) + 1;
    for (const u of allUsers()) console.log(`${u.username.padEnd(24)} ${String(counts[u.id] || 0).padStart(4)} biopic(s)  since ${u.createdAt.slice(0, 10)}  2FA ${u.totpSecret ? "on" : "RESET"}  devices ${u.devices?.length || 0}`);
    console.log(`${counts.undefined || counts.null || 0} biopic(s) without an owner.`);
    break;
  }
  case "claim": {
    const u = user(arg);
    const names = claimUnowned(u.id);
    console.log(names.length ? `Gave ${names.length} biopic(s) to ${u.username}: ${names.join(", ")}` : "No unowned biopics.");

    break;
  }
  case "reset-2fa": {
    const u = user(arg);
    resetTwoFactor(u);
    console.log(`${u.username} will set up a new authenticator at next sign-in (password still required).`);
    break;
  }
  case "reports": {
    const f = path.join(DATA_DIR, "reports.jsonl");
    if (!fs.existsSync(f)) {
      console.log("No reports.");
      break;
    }
    for (const line of fs.readFileSync(f, "utf8").trim().split("\n")) {
      const r = JSON.parse(line);
      console.log(`${r.at}  ${r.projectId}  “${r.name}”  ${r.reason}`);
    }
    break;
  }
  case "unpublish": {
    const p = loadProject(need(arg, "project id"));
    p.public = false;
    p.publishedAt = null;
    saveProject(p);
    console.log(`“${p.person.name}” is private now.`);
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("// ") && !l.includes("Copyright")).map((l) => l.slice(3)).join("\n"));
}
