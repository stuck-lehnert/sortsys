#!/usr/bin/env python3
"""Test the configured Nginx template with an owned loopback HTTP server.

Pass an explicit executable command; no container runtime or implicit host fallback.
"""

import argparse
import contextlib
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
        data = json.dumps({
            "path": self.path,
            "headers": dict(self.headers),
            "backend": self.server.server_address[0],
        }).encode()
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


@contextlib.contextmanager
def serving(server):
    thread = threading.Thread(target=server.serve_forever)
    thread.start()

    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def runtime_configuration(repo, root, mime_types):
    config = (repo / "sortsys-webapp-v2/nginx.conf").read_text()
    config = config.replace("/tmp/", f"{root}/")

    if mime_types is None:
        mime_types = root / "mime.types"
        mime_types.write_text("types { text/html html; application/javascript js; }\n")

    config = config.replace("/etc/nginx/mime.types", str(mime_types.resolve()))

    if os.getuid() == 0:
        # Native tests may run as root; use the current test identity for workers.
        user = pwd.getpwuid(os.getuid()).pw_name
        group = grp.getgrgid(os.getgid()).gr_name
        config = f"user {user} {group};\n" + config

    return config


def assert_static_routes(get):
    for path in ["/", "/projects/123", "/index.html"]:
        status, headers, body = get(path)
        assert status == 200 and b"sortsys smoke SPA" in body, path
        assert headers["Server"] == "nginx", headers["Server"]

    assert "no-cache" in get("/index.html")[1]["Cache-Control"]
    assert "no-store" in ",".join(get("/sw.js")[1].get_all("Cache-Control", []))
    assert "immutable" in ",".join(get("/assets/app.js")[1].get_all("Cache-Control", []))

    status, headers, _ = get("/pdfjs/viewer.mjs")
    assert status == 200 and headers["Content-Type"].startswith("application/javascript")

    for path in ["/assets/missing.js", "/pdfjs/missing.mjs"]:
        assert get(path)[0] == 404, path


def assert_proxy_routes(get):
    for editor in ["office", "drawio"]:
        for suffix in ["", "/", "/echo", "/index.html", "/export?document=private-test-data"]:
            for method in ["GET", "POST"]:
                path = f"/{editor}{suffix}"
                assert get(path, method=method)[0] == 403, (path, method)

    for path, forwarded in [
        ("/api/v2/echo", "/echo"),
        ("/api/v2/echo?next=%2Fa", "/echo?next=%2Fa"),
    ]:
        status, _, body = get(path, {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "example.test",
        })
        assert status == 200, (path, status, body)
        echo = json.loads(body)
        assert echo["path"] == forwarded, echo
        assert echo["headers"]["X-Forwarded-Proto"] == "https", path

    status, _, body = get("/api/v2/echo", {"Upgrade": "websocket", "Connection": "Upgrade"})
    assert status == 200, (status, body)
    echo = json.loads(body)
    assert echo["headers"]["Upgrade"] == "websocket"
    assert echo["headers"]["Connection"] == "upgrade"


def exercise_configuration(repo, root, command, mime_types, backend):
    html = root / "html"
    (html / "assets").mkdir(parents=True)
    (html / "pdfjs").mkdir()
    (html / "index.html").write_text("<html>sortsys smoke SPA</html>")
    (html / "assets/app.js").write_text("// smoke asset")
    (html / "pdfjs/viewer.mjs").write_text("// smoke viewer")
    (html / "sw.js").write_text("// smoke service worker")
    values = {
        "API_UPSTREAM": f"http://127.0.0.1:{backend.server_port}",
        "CLIENT_MAX_BODY_SIZE": "64m",
    }
    template = (repo / "sortsys-webapp-v2/nginx.conf.template").read_text()

    for name, value in values.items():
        template = template.replace("${" + name + "}", value)

    assert not re.search(r"\$\{[^}]+\}", template), "Unrendered template variable"

    # Transfer our reserved listener to Nginx, avoiding an unrelated local service.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        port = listener.getsockname()[1]
        template = template.replace(
            "listen 80 default_server;", f"listen 127.0.0.1:{port} default_server;"
        )
        template = template.replace("root /usr/share/nginx/html;", f"root {html};")
        config = root / "nginx.conf"
        (root / "default.conf").write_text(template)
        config.write_text(runtime_configuration(repo, root, mime_types))
        base = command + [
            "-p", str(root) + "/", "-c", str(config), "-e", str(root / "error.log")
        ]

        # Executor output descriptors are sockets; /dev/stderr needs an owned
        # regular descriptor for syntax checks as well as runtime logs.
        syntax_log = root / "syntax.log"

        with syntax_log.open("w") as log:
            config_check = subprocess.run(base + ["-t"], stdout=log, stderr=subprocess.STDOUT)

        if config_check.returncode != 0:
            print(syntax_log.read_text())

        config_check.check_returncode()
        env = dict(os.environ, NGINX=str(listener.fileno()) + ";")

        with (root / "process.log").open("w+") as log:
            process = subprocess.Popen(
                base + ["-g", "daemon off; master_process off;"],
                pass_fds=(listener.fileno(),), env=env,
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            )

            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

                def get(path, headers=None, method="GET"):
                    assert process.poll() is None, "Nginx exited before request"
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{port}" + path, headers=headers or {}, method=method
                    )

                    try:
                        response = opener.open(request, timeout=5)
                    except urllib.error.HTTPError as error:
                        response = error

                    with response:
                        return response.status, response.headers, response.read()

                time.sleep(0.15)
                assert_static_routes(get)
                assert_proxy_routes(get)
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

    with contextlib.ExitStack() as stack:
        backend = stack.enter_context(serving(http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), Echo
        )))
        directory = stack.enter_context(tempfile.TemporaryDirectory(prefix="sortsys-nginx-"))
        exercise_configuration(repo, Path(directory), command, args.mime_types, backend)

    print(
        f"Nginx {expected}: config, SPA/assets, API proxy paths, TLS/WebSocket "
        "headers and blocked editor proxy routes passed."
    )


if __name__ == "__main__":
    main()
