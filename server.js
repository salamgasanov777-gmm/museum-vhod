// Российский «вход» для гостей Отклика.
// Основной сервер (боты, база) стоит за границей, и часть российских провайдеров его не пускает.
// Этот маленький сервер стоит в Timeweb: гость открывает его, а он пересылает запросы на основной сервер
// и возвращает ответ. Своих данных не хранит. Пропускает только адреса страницы оценки.
const http = require("http");

const PORT = Number(process.env.PORT) || 3000;
const UPSTREAM = (process.env.UPSTREAM || "https://museum.66-42-53-22.nip.io").replace(/\/$/, "");
const PROXY_KEY = process.env.PROXY_KEY || ""; // общий секрет с основным сервером — по нему тот верит адресу гостя

const ALLOWED = {
  GET: new Set(["/", "/r", "/health"]),
  POST: new Set(["/api/rate", "/api/comment", "/api/click"]),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 16_384) { reject(new Error("too big")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const FAIL_PAGE = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Попробуйте ещё раз</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#080D18;color:#F2F5F9;font:17px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:24px">
<div><p style="font-size:22px;font-weight:700;margin:0 0 8px">Не получилось открыть страницу</p>
<p style="color:#9AA7B8;margin:0">Проверьте интернет и отсканируйте QR-код ещё раз.</p></div></body></html>`;

// Адрес гостя: берём самый правый внешний адрес из x-forwarded-for — его дописал балансировщик Timeweb.
// Левые элементы гость может прислать сам, поэтому им не верим; внутренние адреса платформы пропускаем.
const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
function clientIp(req) {
  const list = (req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim().replace(/^::ffff:/, "")).filter(Boolean);
  for (let i = list.length - 1; i >= 0; i--) if (!PRIVATE.test(list[i])) return list[i].slice(0, 64);
  return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end(); } // кривой адрес не роняет вход
  if (!ALLOWED[req.method]?.has(url.pathname)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Не найдено");
  }
  const ip = clientIp(req);
  try {
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const r = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        "x-otklik-client-ip": ip,
        "x-otklik-proxy-key": PROXY_KEY,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, {
      "content-type": r.headers.get("content-type") || "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(buf);
  } catch (e) {
    console.error("пересылка:", req.method, url.pathname, e.message);
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      return res.end('{"error":"upstream"}');
    }
    res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
    res.end(FAIL_PAGE);
  }
}).listen(PORT, () => console.log(`вход Отклика: порт ${PORT} → ${UPSTREAM}`));
