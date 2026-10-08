import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".pdf": "application/pdf" };

export function createAppServer(root = resolve(dirname(fileURLToPath(import.meta.url)), "../dist")) {
  const insideRoot = (path) => path === root || path.startsWith(root + sep);
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    const fail = (status, message) => {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : message);
    };
    if (!["GET", "HEAD"].includes(request.method)) {
      response.setHeader("Allow", "GET, HEAD"); fail(405, "Method not allowed"); return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
    catch { fail(400, "Invalid path"); return; }
    if (pathname.includes("\0") || pathname.includes("\\")) { fail(400, "Invalid path"); return; }
    let path = resolve(root, "." + pathname);
    if (!insideRoot(path)) { fail(403, "Forbidden"); return; }
    if (pathname === "/") path = resolve(root, "index.html");
    try {
      try {
        if (!(await stat(path)).isFile()) throw Object.assign(new Error("Not a file"), { code: "ENOENT" });
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        // SPA routing is only for HTML navigation, never for missing assets.
        if (extname(pathname) || !request.headers.accept?.includes("text/html")) { fail(404, "Not found"); return; }
        path = resolve(root, "index.html");
      }
      path = await realpath(path);
      if (!insideRoot(path)) { fail(403, "Forbidden"); return; }
      const content = await readFile(path);
      const hashedAsset = pathname.startsWith("/assets/") && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(pathname);
      response.writeHead(200, { "Content-Type": TYPES[extname(path).toLowerCase()] || "application/octet-stream",
        "Content-Length": content.length, "Cache-Control": hashedAsset ? "public, max-age=31536000, immutable" : "no-cache" });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) { fail(error.code === "ENOENT" ? 404 : 500, "Content unavailable"); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  await stat(resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.html"));
  const server = createAppServer();
  server.listen(port, "0.0.0.0", () => console.log("HotelSuite frontend listening on port " + port + "."));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
