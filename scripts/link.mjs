// Symlink this folder into a vault's plugins dir for development.
// Usage: npm run link -- /path/to/vault
import fs from "node:fs";
import path from "node:path";

const vault = process.argv[2];
if (!vault) {
  console.error("Usage: npm run link -- /path/to/vault");
  process.exit(1);
}
const dest = path.join(vault, ".obsidian", "plugins", "vault-digest");
fs.mkdirSync(path.dirname(dest), { recursive: true });
if (fs.existsSync(dest)) {
  console.log("Already exists:", dest);
} else {
  fs.symlinkSync(process.cwd(), dest, "dir");
  console.log("Linked", dest);
}
// hot-reload plugin looks for .hotreload
fs.writeFileSync(path.join(process.cwd(), ".hotreload"), "");
