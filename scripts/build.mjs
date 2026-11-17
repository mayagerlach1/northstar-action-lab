import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const publicUrl = new URL("../public/", import.meta.url);
const required = ["index.html", "styles.css", "app.js", "data.json", "guide.html", "start-here.html"];
for (const path of required) await access(new URL(path, publicUrl));
const data = JSON.parse(await readFile(new URL("data.json", publicUrl), "utf8"));
if (!data || typeof data !== "object") throw new Error("data.json must contain the synthetic dataset.");
console.log(`Validated ${required.length} required starter files in ${fileURLToPath(publicUrl)}.`);
console.log("Dashboard assets are ready. /api/actions connects contextual actions using your server credentials.");
