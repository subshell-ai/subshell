/** Delay TCP traffic; optional auditing records HTTP request/status lines, never credentials. */
import { createConnection, createServer } from "node:net";
import { Transform } from "node:stream";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone Docker fixture setting, outside turbo
const targetHost = process.env.ROUTE_PROXY_HOST ?? "server";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone Docker fixture setting, outside turbo
const targetPort = Number(process.env.ROUTE_PROXY_PORT ?? 3199);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone Docker fixture setting, outside turbo
const audit = process.env.ROUTE_PROXY_AUDIT === "1";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone Docker fixture setting, outside turbo
const delayMs = Number(process.env.ROUTE_PROXY_DELAY_MS ?? 80);
function delay(): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      setTimeout(() => callback(null, chunk), delayMs);
    },
  });
}

createServer((client) => {
  const upstream = createConnection({ host: targetHost, port: targetPort });
  if (audit) {
    client.once("data", (data) => {
      const header = data.toString().split("\r\n\r\n")[0] ?? "";
      console.log(
        `probe request: ${header.split("\r\n")[0]}; authorization header: ${/\r\nauthorization:/i.test(header)}`,
      );
    });
    upstream.once("data", (data) => console.log(`probe response: ${data.toString().split("\r\n")[0]}`));
  }
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(delay()).pipe(upstream);
  upstream.pipe(delay()).pipe(client);
}).listen(3199, "0.0.0.0");
