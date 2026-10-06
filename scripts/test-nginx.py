#!/usr/bin/env python3
"""Smoke-test the configured Nginx version/template using only owned loopback servers.

Pass an explicit executable command; no container runtime or implicit host fallback.
"""
import argparse
import grp
import http.server
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request


class Echo(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        data = json.dumps({"path": self.path, "headers": dict(self.headers)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nginx-command", required=True)
    parser.add_argument("--mime-types", type=Path)
    args = parser.parse_args()
    command = shlex.split(args.nginx_command)
    repo = Path(__file__).resolve().parent.parent
    dockerfile = (repo / "sortsys-webapp-v2/Dockerfile").read_text()
    expected = re.search(r"^FROM nginx:([0-9.]+)-", dockerfile, re.M).group(1)
    version = subprocess.check_output(command + ["-v"], stderr=subprocess.STDOUT).decode()
    assert re.search(r"nginx/" + re.escape(expected) + r"(?:\s|$)", version), version

    backend = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Echo)
    thread = threading.Thread(target=backend.serve_forever)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="sortsys-nginx-") as directory:
            root = Path(directory)
            html = root / "html"
            (html / "assets").mkdir(parents=True)
            (html / "pdfjs").mkdir()
            (html / "index.html").write_text("<html>sortsys smoke SPA</html>")
            (html / "assets/app.js").write_text("// smoke asset")
            (html / "pdfjs/viewer.mjs").write_text("// smoke viewer")
            (html / "sw.js").write_text("// smoke service worker")
            upstream = f"http://127.0.0.1:{backend.server_port}"
            template = (repo / "sortsys-webapp-v2/nginx.conf.template").read_text()
            for name, value in {"API_UPSTREAM": upstream, "ONLYOFFICE_UPSTREAM": upstream,
                                "DRAWIO_UPSTREAM": upstream, "CLIENT_MAX_BODY_SIZE": "64m"}.items():
                template = template.replace("${" + name + "}", value)
            assert not re.search(r"\$\{[^}]+\}", template), "Unrendered template variable"

            # Reserve the port for this test and transfer its socket to Nginx.
            # This avoids racing or connecting to an unrelated localhost service.
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(128)
                port = listener.getsockname()[1]
                template = template.replace("listen 80 default_server;", f"listen 127.0.0.1:{port} default_server;")
                template = template.replace("root /usr/share/nginx/html;", f"root {html};")
                user = ""
                if os.getuid() == 0:
                    user = f"user {pwd.getpwuid(os.getuid()).pw_name} {grp.getgrgid(os.getgid()).gr_name};\n"
                mime = f"include {args.mime_types.resolve()};" if args.mime_types else "types { text/html html; application/javascript js; }"
                temporary_paths = "\n".join(f"{name}_temp_path {root / name};" for name in ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"])
                config = root / "nginx.conf"
                config.write_text(user + f"pid {root / 'nginx.pid'};\nerror_log stderr;\n"
                                  "events { worker_connections 64; }\nhttp {\naccess_log off;\n"
                                  + mime + "\n" + temporary_paths + "\n" + template + "\n}\n")
                base = command + ["-p", str(root) + "/", "-c", str(config), "-e", str(root / "error.log")]
                subprocess.run(base + ["-t"], check=True)
                env = dict(os.environ, NGINX=str(listener.fileno()) + ";")
                with (root / "process.log").open("w+") as log:
                    process = subprocess.Popen(base + ["-g", "daemon off; master_process off;"],
                                               pass_fds=(listener.fileno(),), env=env,
                                               stdin=subprocess.DEVNULL, stdout=log, stderr=log)
                    try:
                        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

                        def get(path, headers=None):
                            assert process.poll() is None, "Nginx exited before request"
                            request = urllib.request.Request(f"http://127.0.0.1:{port}" + path, headers=headers or {})
                            try:
                                response = opener.open(request, timeout=5)
                            except urllib.error.HTTPError as error:
                                response = error
                            with response:
                                return response.status, response.headers, response.read()

                        time.sleep(0.15)
                        for path in ["/", "/projects/123", "/index.html"]:
                            status, headers, body = get(path)
                            assert status == 200 and b"sortsys smoke SPA" in body, path
                        assert "no-cache" in get("/index.html")[1]["Cache-Control"]
                        assert "no-store" in ",".join(get("/sw.js")[1].get_all("Cache-Control", []))
                        assert "immutable" in ",".join(get("/assets/app.js")[1].get_all("Cache-Control", []))
                        status, headers, body = get("/pdfjs/viewer.mjs")
                        assert status == 200 and headers["Content-Type"].startswith("application/javascript")
                        for path in ["/assets/missing.js", "/pdfjs/missing.mjs"]:
                            assert get(path)[0] == 404, path
                        for path in ["/office", "/drawio"]:
                            status, headers, body = get(path)
                            assert status == 308 and headers["Location"] == path + "/", path
                        for path, forwarded in [("/api/v2/echo", "/echo"), ("/office/echo", "/echo"), ("/drawio/echo", "/drawio/echo")]:
                            status, headers, body = get(path, {"X-Forwarded-Proto": "https", "X-Forwarded-Host": "example.test"})
                            echo = json.loads(body)
                            assert status == 200 and echo["path"] == forwarded, path
                            assert echo["headers"]["X-Forwarded-Proto"] == "https", path
                            if path.startswith("/office/"):
                                assert echo["headers"]["X-Forwarded-Host"] == "example.test/office"
                                assert headers["Content-Security-Policy"] == "upgrade-insecure-requests"
                        echo = json.loads(get("/api/v2/echo", {"Upgrade": "websocket", "Connection": "Upgrade"})[2])
                        assert echo["headers"]["Upgrade"] == "websocket"
                        assert echo["headers"]["Connection"] == "upgrade"
                    except Exception:
                        log.flush()
                        print((root / "process.log").read_text())
                        raise
                    finally:
                        if process.poll() is None:
                            process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
    finally:
        backend.shutdown()
        backend.server_close()
        thread.join()
    print(f"Nginx {expected}: config, SPA/assets, redirects, proxy paths, TLS headers and upgrade headers passed.")


if __name__ == "__main__":
    main()
