// Create the D1 database on first deploy and pin its id into wrangler.toml.
// Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const config = new URL("../wrangler.toml", import.meta.url);
const toml = await readFile(config, "utf8");
const name = toml.match(/database_name = "([^"]+)"/)[1];
const wrangler = (...args) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], { encoding: "utf8" });
const find = () =>
  JSON.parse(wrangler("d1", "list", "--json")).find((db) => db.name === name);
let database = find();
if (!database) {
  console.log(`Creating D1 database ${name}`);
  wrangler("d1", "create", name);
  database = find();
}
if (!database?.uuid) throw new Error(`D1 database ${name} was not found.`);
await writeFile(
  config,
  toml.replace(/database_id = "[^"]*"/, `database_id = "${database.uuid}"`),
);
console.log(`Using D1 database ${name} (${database.uuid})`);
