#!/usr/bin/env python3
"""Test the configured Nginx template with owned loopback HTTP and DNS servers.

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
import socketserver
import struct
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


class EditorDNS(socketserver.BaseRequestHandler):
    def handle(self):
        packet, connection = self.request
        labels = []
        offset = 12

        while offset < len(packet) and packet[offset] != 0:
            length = packet[offset]
            offset += 1
            labels.append(packet[offset:offset + length].decode("ascii"))
            offset += length

        offset += 1

        if offset + 4 > len(packet):
            return

        name = ".".join(labels)
        kind, query_class = struct.unpack("!HH", packet[offset:offset + 4])
        question = packet[12:offset + 4]
        address = self.server.records.get(name)
        self.server.queries.append((name, kind, address))
        answer = b""

        if address and kind == 1 and query_class == 1:
            answer = struct.pack("!HHHIH", 0xC00C, 1, 1, 1, 4)
            answer += socket.inet_aton(address)

        # Existing names have an empty AAAA answer, rather than NXDOMAIN.
        flags = 0x8180 if address else 0x8183
        header = packet[:2] + struct.pack("!HHHHH", flags, 1, bool(answer), 0, 0)
        connection.sendto(header + question + answer, self.client_address)


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

    for path in ["/office", "/drawio"]:
        status, headers, _ = get(path)
        assert status == 308 and headers["Location"] == path + "/", path


def assert_proxy_routes(get):
    paths = [
        ("/api/v2/echo", "/echo"),
        ("/office/echo", "/echo"),
        ("/drawio/echo", "/drawio/echo"),
        (
            "/office/echo%2Fpart?name=M%C3%BCller&next=%2Fa",
            "/echo%2Fpart?name=M%C3%BCller&next=%2Fa",
        ),
        ("/drawio/echo%2Fpart?next=%2Fa", "/drawio/echo%2Fpart?next=%2Fa"),
    ]

    for path, forwarded in paths:
        status, headers, body = get(path, {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "example.test",
        })
        assert status == 200, (path, status, body)
        echo = json.loads(body)
        assert echo["path"] == forwarded, echo
        assert echo["headers"]["X-Forwarded-Proto"] == "https", path

        if path.startswith("/office/"):
            assert echo["headers"]["X-Forwarded-Host"] == "example.test/office"
            assert headers["Content-Security-Policy"] == "upgrade-insecure-requests"

    for path in ["/api/v2/echo", "/office/echo", "/drawio/echo"]:
        status, _, body = get(path, {"Upgrade": "websocket", "Connection": "Upgrade"})
        assert status == 200, (path, status, body)
        echo = json.loads(body)
        assert echo["headers"]["Upgrade"] == "websocket"
        assert echo["headers"]["Connection"] == "upgrade"


def wait_for_backend(get, path, address):
    deadline = time.monotonic() + 12
    last = None

    while time.monotonic() < deadline:
        status, _, body = get(path)
        last = (status, body)

        if status == 200 and json.loads(body)["backend"] == address:
            return

        time.sleep(0.15)

    raise AssertionError(f"{path} did not recover to {address}: {last}")


def assert_editor_recovery(get, dns):
    assert_static_routes(get)
    assert get("/api/v2/echo")[0] == 200

    for path in ["/office/echo", "/drawio/echo"]:
        assert get(path)[0] == 502, path

    # Allow the real production resolver's five-second negative cache to expire.
    # No reload occurs: requests must trigger a fresh DNS query and reach HTTP.
    dns.records.update({"office.test": "127.0.0.1", "drawio.test": "127.0.0.1"})

    for path in ["/office/echo", "/drawio/echo"]:
        wait_for_backend(get, path, "127.0.0.1")

    assert_proxy_routes(get)

    # A restarted container may have a different IP. Test positive-cache expiry
    # too, keeping the exact same proxy process and backend port.
    dns.records.update({"office.test": "127.0.0.2", "drawio.test": "127.0.0.2"})

    for path in ["/office/echo", "/drawio/echo"]:
        wait_for_backend(get, path, "127.0.0.2")

    for name in ["office.test", "drawio.test"]:
        answers = {address for query, kind, address in dns.queries if query == name and kind == 1}
        assert answers == {None, "127.0.0.1", "127.0.0.2"}, (name, dns.queries)

    assert_static_routes(get)
    assert_proxy_routes(get)


def exercise_configuration(repo, root, command, mime_types, backend, dns):
    html = root / "html"
    (html / "assets").mkdir(parents=True)
    (html / "pdfjs").mkdir()
    (html / "index.html").write_text("<html>sortsys smoke SPA</html>")
    (html / "assets/app.js").write_text("// smoke asset")
    (html / "pdfjs/viewer.mjs").write_text("// smoke viewer")
    (html / "sw.js").write_text("// smoke service worker")
    values = {
        "API_UPSTREAM": f"http://127.0.0.1:{backend.server_port}",
        "ONLYOFFICE_UPSTREAM": f"http://office.test:{backend.server_port}",
        "DRAWIO_UPSTREAM": f"http://drawio.test:{backend.server_port}",
        "CLIENT_MAX_BODY_SIZE": "64m",
        "NGINX_LOCAL_RESOLVERS": f"127.0.0.1:{dns.server_address[1]}",
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

                def get(path, headers=None):
                    assert process.poll() is None, "Nginx exited before request"
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{port}" + path, headers=headers or {}
                    )

                    try:
                        response = opener.open(request, timeout=5)
                    except urllib.error.HTTPError as error:
                        response = error

                    with response:
                        return response.status, response.headers, response.read()

                time.sleep(0.15)
                assert_editor_recovery(get, dns)
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
        stack.enter_context(serving(http.server.ThreadingHTTPServer(
            ("127.0.0.2", backend.server_port), Echo
        )))
        dns = socketserver.UDPServer(("127.0.0.1", 0), EditorDNS)
        dns.records = {}
        dns.queries = []
        stack.enter_context(serving(dns))
        directory = stack.enter_context(tempfile.TemporaryDirectory(prefix="sortsys-nginx-"))
        exercise_configuration(repo, Path(directory), command, args.mime_types, backend, dns)

    print(
        f"Nginx {expected}: config, SPA/assets, redirects, proxy paths, TLS/WebSocket "
        "headers, unavailable-editor startup and DNS/IP recovery passed."
    )


if __name__ == "__main__":
    main()
