import { createServer } from "node:http";

// A separate origin mirrors the production download host. Delay the attachment
// to verify that navigating to the instructions doesn't cancel the download.
createServer((request, response) => {
  if (request.url === "/health") {
    response.end("ok");
    return;
  }
  setTimeout(() => {
    response.writeHead(200, {
      "Content-Type": "application/x-apple-diskimage",
      "Content-Disposition": 'attachment; filename="Shouldertap.dmg"',
    });
    response.end("test installer");
  }, 400);
}).listen(4174, "127.0.0.1");
