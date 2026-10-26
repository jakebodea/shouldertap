import { createServer } from "node:http";

// A separate origin mirrors the production download host. Delay the attachment
// to verify that navigating to the instructions doesn't cancel the download.
createServer((request, response) => {
  if (request.url === "/health") {
    response.end("ok");
    return;
  }
  const windows = request.url?.endsWith(".exe") ?? false;
  setTimeout(() => {
    response.writeHead(200, {
      "Content-Type": windows
        ? "application/vnd.microsoft.portable-executable"
        : "application/x-apple-diskimage",
      "Content-Disposition": `attachment; filename="${windows ? "Shouldertap-Setup.exe" : "Shouldertap.dmg"}"`,
    });
    response.end("test installer");
  }, 400);
}).listen(4174, "127.0.0.1");
