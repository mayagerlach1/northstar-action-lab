import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import createIssueHandler from "../api/create-issue.js";
import receiverHandler from "../api/receiver.js";
import sendEventHandler from "../api/send-event.js";
import verifyEventHandler from "../api/verify-event.js";
import actionPreflightHandler from "../api/action-preflight.js";
import actionsHandler from "../api/actions.js";

const defaultPublicDir = fileURLToPath(new URL("../public/", import.meta.url));
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export function createLabServer({ publicDir = defaultPublicDir } = {}) {
  const root = resolve(publicDir);
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }
    if (pathname === "/api/create-issue") {
      req.resume();
      createIssueHandler(req, res);
      return;
    }
    const apiRoute = { "/api/receiver": receiverHandler, "/api/send-event": sendEventHandler, "/api/verify-event": verifyEventHandler, "/api/action-preflight": actionPreflightHandler, "/api/actions": actionsHandler }[pathname];
    if (apiRoute) {
      await apiRoute(req, res);
      return;
    }
    if (pathname.startsWith("/api/")) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.writeHead(405).end("Method not allowed");
      return;
    }
    if (pathname === "/preflight" || pathname === "/preflight.html") {
      res.writeHead(302, { Location: "/" }).end();
      return;
    }
    if (pathname.includes("\0") || pathname.includes("\\")) {
      res.writeHead(400).end("Bad request");
      return;
    }
    const asset = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = resolve(root, asset);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const bytes = await readFile(filePath);
      res.setHeader("Content-Type", contentTypes[extname(filePath)] || "application/octet-stream");
      res.setHeader("Content-Length", bytes.length);
      res.writeHead(200).end(req.method === "HEAD" ? undefined : bytes);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be an integer between 1 and 65535.");
    process.exit(1);
  }
  createLabServer().listen(port, "127.0.0.1", () => {
    console.log(`IE Apps Action Lab: http://127.0.0.1:${port}`);
    console.log("Contextual dashboard actions use /api/actions. Configure your own server credentials.");
  });
}
