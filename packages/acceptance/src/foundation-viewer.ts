import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Static acceptance artifacts only: no execution commands, database access or directory listing. */
export async function createFoundationViewer(directory: string, authority = "127.0.0.1:8787") {
  const [html, json] = await Promise.all([readFile(join(directory, "index.html")), readFile(join(directory, "report.json"))]);
  const app = Fastify();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (request.headers.host !== authority || request.headers["sec-fetch-site"] === "cross-site"
      || (request.headers.origin !== undefined && request.headers.origin !== `http://${authority}`)) {
      return reply.code(403).send({ error: "Local report origin required" });
    }
    if (!["GET", "HEAD"].includes(request.method)) return reply.code(405).send({ error: "Read-only acceptance viewer" });
  });
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(html));
  app.get("/report.json", async (_request, reply) => reply.type("application/json; charset=utf-8").send(json));
  return app;
}
