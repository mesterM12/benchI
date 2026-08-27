import { createServer } from "node:http";

const role = process.env.BENCHI_ROLE;
if (role !== "orchestrator" && role !== "worker") throw new Error("BENCHI_ROLE must be orchestrator or worker");
const port = Number(process.env.PORT ?? (role === "orchestrator" ? 3001 : 3002));

createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ role, status: "ready" }));
}).listen(port, "0.0.0.0");
