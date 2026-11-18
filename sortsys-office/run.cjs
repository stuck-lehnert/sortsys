const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const { main, sandbox, app } = require("./origins.cjs")();

if (process.argv.includes("--health")) {
  const request = http.get({ hostname: "127.0.0.1", port: 8080, path: "/integration/", headers: { Host: main.host }, timeout: 4000 }, response => {
    response.resume(); process.exitCode = response.statusCode === 200 ? 0 : 1;
  });
  request.on("timeout", () => request.destroy()); request.on("error", () => { process.exitCode = 1; });
} else {
  // Embedding is an upstream administrative decree, not a config.js flag.
  // This service exists solely for the two restricted embedding origins.
  const decrees = "/var/lib/sortsys-office/decrees";
  fs.mkdirSync(decrees, { recursive: true, mode: 0o700 });
  const decreeFile = `${decrees}/decree.ndjson`;
  const previous = fs.existsSync(decreeFile) ? fs.readFileSync(decreeFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  if (previous.filter(value => value[0] === "ENABLE_EMBEDDING").at(-1)?.[1]?.[0] !== true) {
    fs.appendFileSync(decreeFile, JSON.stringify(["ENABLE_EMBEDDING", [true], "sortsys-office", Date.now()]) + "\n", { mode: 0o600 });
  }
  const csp = `default-src 'none'; script-src 'self' 'unsafe-inline' blob: ${main.origin}; style-src 'self' 'unsafe-inline' ${main.origin}; font-src 'self' data: ${main.origin}; img-src 'self' data: blob: ${main.origin}; media-src blob:; connect-src 'self' blob: ${main.origin} ${sandbox.origin} ${main.origin.replace(/^http/, "ws")}; worker-src 'self' blob: ${main.origin}; frame-src 'self' blob: ${main.origin} ${sandbox.origin}; frame-ancestors ${app.origin} ${main.origin} ${sandbox.origin}; object-src 'none'; base-uri 'self' ${main.origin}; form-action 'none'`;
  // CryptPad's generic applications deliberately abort when eval is allowed.
  // The Office engine needs its own exception; diagram and integration pages
  // retain the stricter policy and the same limits on network destinations.
  const officeCsp = csp.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'");
  fs.writeFileSync("/tmp/sortsys-office-nginx.conf", `
pid /tmp/sortsys-office-nginx.pid;
error_log /dev/stderr warn;
worker_processes auto;
events { worker_connections 2048; }
http {
  access_log off;
  client_body_temp_path /tmp/sortsys-office-body;
  proxy_temp_path /tmp/sortsys-office-proxy;
  fastcgi_temp_path /tmp/sortsys-office-fastcgi;
  uwsgi_temp_path /tmp/sortsys-office-uwsgi;
  scgi_temp_path /tmp/sortsys-office-scgi;
  map $http_host $office_port { default 0; "${main.host}" 3000; "${sandbox.host}" 3001; }
  map $http_upgrade $office_connection { default upgrade; '' close; }
  map $uri $office_csp {
    default "${csp}";
    ~^/(?:doc|sheet|presentation|unsafeiframe)(?:/|$) "${officeCsp}";
    ~^/common/onlyoffice/ "${officeCsp}";
  }
  server {
    listen 8080 default_server; server_name _;
    if ($office_port = 0) { return 444; }
    proxy_set_header Host $http_host;
    proxy_set_header Cookie "";
    proxy_set_header Authorization "";
    proxy_hide_header Content-Security-Policy;
    add_header Content-Security-Policy $office_csp always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Content-Type-Options nosniff always;
    location ~* ^/(?:ooapidl|oosave|ConvertService(?:\\.ashx)?|coauthoring|hosting|proxy)(?:/|$) { return 403; }
    location ~* ^/(?:pad|code|kanban|form|whiteboard|calendar|drive|admin|login|register|profile|settings|support)(?:/(?:index|inner)\\.html)?/?$ { return 404; }
    location = / { return 404; }
    location ~ ^/api/auth/?$ {
      client_max_body_size 64k;
      proxy_pass http://127.0.0.1:3010;
      proxy_http_version 1.1;
    }
    location /cryptpad_websocket {
      proxy_pass http://127.0.0.1:3010;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $office_connection;
      proxy_set_header Host $http_host;
      proxy_set_header Cookie "";
      proxy_set_header Authorization "";
      proxy_read_timeout 3600s;
      proxy_buffering off;
    }
    location ~ ^/(?:blob|block|datastore)(?:/|$) { proxy_pass http://127.0.0.1:3030; }
    location /upload-blob/ {
      client_max_body_size 512k;
      proxy_pass http://127.0.0.1:3030;
      proxy_http_version 1.1;
    }
    location / {
      limit_except GET HEAD OPTIONS { deny all; }
      proxy_pass http://127.0.0.1:$office_port;
      proxy_http_version 1.1;
    }
  }
}
`);
  const children = new Set(); let stopping = false;
  const stop = code => {
    if (stopping) return; stopping = true; process.exitCode = code;
    for (const child of children) child.kill("SIGTERM");
    const timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 10000); timer.unref();
  };
  for (const [command, args] of [["node", ["server.js"]], ["nginx", ["-c", "/tmp/sortsys-office-nginx.conf", "-g", "daemon off;"]]]) {
    const child = spawn(command, args, { cwd: "/cryptpad", stdio: "inherit" }); children.add(child);
    child.on("error", () => stop(1)); child.on("exit", code => { children.delete(child); if (!stopping) stop(code || 1); });
  }
  process.on("SIGTERM", () => stop(0)); process.on("SIGINT", () => stop(0));
}
