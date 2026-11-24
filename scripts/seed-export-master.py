#!/usr/bin/env python3
"""Export master development data from a disposable, local PostgreSQL cluster."""

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import StringIO
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
from threading import Thread
from urllib.parse import unquote, urlsplit


MASTER = "513058b46c1659f6227e32b0284f90613011be17"
SEED = 42
REPOSITORY = Path(__file__).resolve().parent.parent
REFERENCE_PATH = REPOSITORY / "sortsys-webapp-v2/scripts/development/master-seed-reference.json.gz"
BUCKET = "sortsys-development"
TENANT_DB = "live_sortsys_api_test"
EXCLUDED_TABLES = (
    "__*", "zerotrust_*", "_sqlx_migrations", "development_seed_manifests",
    "user_sessions", "user_passkeys", "user_roles", "user_role_assignments", "users",
)


def command(*args, capture=False, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE if capture else None,
                          **kwargs).stdout


@contextmanager
def object_storage():
    objects = {}
    prefix = f"/{BUCKET}/"

    class Storage(BaseHTTPRequestHandler):
        def object_key(self):
            path = unquote(urlsplit(self.path).path)
            key = path.removeprefix(prefix)
            if not path.startswith(prefix):
                return None
            if any(part in ("", ".", "..") for part in key.split("/")):
                return None
            return key

        def do_PUT(self):
            key = self.object_key()
            if key is None:
                self.send_error(400)
                return

            content = self.rfile.read(int(self.headers["Content-Length"]))
            objects[key] = content
            self.send_response(200)
            # ETags in the development S3 implementation are the MD5 of the bytes.
            self.send_header("ETag", f'"{hashlib.md5(content).hexdigest()}"')
            self.end_headers()

        def do_GET(self):
            content = objects.get(self.object_key())
            if content is None:
                self.send_error(404)
                return

            self.send_response(200)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def log_message(self, *_):
            pass

    with HTTPServer(("127.0.0.1", 0), Storage) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", objects
        finally:
            server.shutdown()
            thread.join()


@contextmanager
def database(directory):
    # Never select a PostgreSQL service or credentials from the environment.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    data = directory / "pg"
    command("initdb", "-D", data, "--auth=trust", "-U", "postgres", "--no-locale",
            "--encoding=UTF8", env=env, capture=True)
    command("pg_ctl", "-D", data, "-l", directory / "postgres.log", "-w", "start",
            "-o", f"-h 127.0.0.1 -p {port} -k '' -c timezone=UTC", env=env)
    try:
        dsn = f"postgresql://postgres@127.0.0.1:{port}"
        command("createdb", "--maintenance-db", f"{dsn}/postgres", "seed_master", env=env)
        yield port, dsn, env
    finally:
        command("pg_ctl", "-D", data, "-m", "fast", "-w", "stop", env=env)


def export_rows(dsn, env):
    dump = command(
        "pg_dump", "--data-only", "--no-owner", "--no-privileges", "--schema=public",
        *(f"--exclude-table-data=public.{table}" for table in EXCLUDED_TABLES),
        dsn, env=env, capture=True,
    ).decode()

    def query(sql):
        return command("psql", "-XqAt", "--set=ON_ERROR_STOP=1", dsn, "-c", sql,
                       env=env, capture=True).decode()

    # Exclude the credential columns at SELECT, keeping person IDs and fields.
    columns = query("""
        SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users'
          AND column_name NOT IN ('password', 'totp_uri')
          AND is_generated='NEVER'
    """).strip()
    users = query(f"COPY (SELECT {columns} FROM public.users ORDER BY id) TO STDOUT")
    owner = query("SELECT id FROM public.users WHERE username='john.doe'").strip()
    if not owner.isdecimal() or not users.endswith("\n"):
        raise ValueError("Unvollständige Personendaten im Entwicklungsbestand")

    # pg_dump's random restrict key and restore statements are not fixture data.
    # Empty COPY sections do not carry business data either. In particular, the
    # current Master seeder makes no offer-number reservations or counters.
    sections = [f"COPY public.users ({columns}) FROM stdin;\n", users, "\\.\n"]
    section = []
    for line in StringIO(dump):
        if line.startswith("COPY public."):
            section = [line]
        elif section and line == "\\.\n":
            if len(section) > 1:
                sections.extend([*section, line])
            section = []
        elif section:
            section.append(line)

    if section or len(sections) == 3:
        raise ValueError("Unvollständiger Master-Export")
    return "".join(sections), owner


def prepare_source(source, clock):
    # Master deliberately randomizes each run. Pin the RNG and the Rust clock
    # used to calculate business dates; PostgreSQL audit timestamps vary.
    rust = source / "sortsys-api-v2/rust-api/src"
    seed = rust / "seed.rs"
    entry = seed.read_text()
    random = '''    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).expect("operating system random source must be available");
    u64::from_le_bytes(bytes)'''
    if entry.count(random) != 1:
        raise ValueError("Der gepinnte Master-RNG wurde nicht gefunden")

    seed.write_text(entry.replace(random, f"    {SEED}"))
    for path in [seed, rust / "seed/commercial.rs", rust / "seed/commercial/takeoff.rs"]:
        text = path.read_text()
        text = text.replace("Utc::now()", f"chrono::DateTime::from_timestamp({clock}, 0).unwrap()")
        path.write_text(text.replace(", Utc}", "}"))


def build(source, target):
    env = {
        **os.environ,
        "CARGO_TARGET_DIR": str(target),
        "CARGO_BUILD_JOBS": os.environ.get("CARGO_BUILD_JOBS", "1"),
        "CARGO_INCREMENTAL": "0",
        "CARGO_PROFILE_DEV_DEBUG": "0",
    }
    command("cargo", "build", "--locked", "--bin", "seed_dev",
            cwd=source / "sortsys-api-v2", env=env)
    return target / "debug/seed_dev"


def seed_environment(port, dsn, endpoint, env):
    # No connection parameters from the surrounding developer environment
    # reach the master binary. Its two services are temporary and local.
    return {
        "PATH": env["PATH"],
        "TZ": "UTC",
        "JWT_SECRET": "fixture-local-unused-signing-key",
        "ADMIN_HASH": "fixture-local-unused-admin-hash",
        "AUTO_BACKUPS_ENABLED": "false",
        "PG_MASTER_DSN": f"{dsn}/seed_master",
        "DEV_TEST_TENANT_NAME": "test",
        "DEV_TEST_DATABASE_NAME": TENANT_DB,
        "TEST_PG_HOST": "127.0.0.1",
        "TEST_PG_PORT": str(port),
        "TEST_S3_ENDPOINT": endpoint,
        "TEST_S3_PUBLIC_BASE_URL": endpoint,
        "TEST_S3_BUCKET": BUCKET,
        "TEST_S3_ACCESS_KEY_ID": "seed-access-key",
        "TEST_S3_SECRET_ACCESS_KEY": "seed-secret-key",
    }


def generate(binary, directory):
    with database(directory) as (port, dsn, env), object_storage() as (endpoint, objects):
        command(binary, env=seed_environment(port, dsn, endpoint, env))
        sql, owner = export_rows(f"{dsn}/{TENANT_DB}", env)

    index = {}
    blobs = {}
    for key, content in sorted(objects.items()):
        digest = hashlib.sha256(content).hexdigest()
        index[key] = digest
        blobs.setdefault(digest, base64.b64encode(content).decode())

    return {"ownerDecimalId": owner, "sql": sql, "bucket": BUCKET, "objects": index, "blobs": blobs}


def copy_sections(sql):
    sections = {}
    offset = 0
    identifier = r'(?:[a-z_][a-z_0-9]*|"[a-z_][a-z_0-9]*")'
    pattern = re.compile(
        rf"^COPY public\.([a-z_]+) \(({identifier}(?:, {identifier})*)\) FROM stdin;\n(.*?)^\\\.\n",
        re.MULTILINE | re.DOTALL,
    )
    for match in pattern.finditer(sql):
        table, columns, rows = match.groups()
        if match.start() != offset or table in sections:
            raise ValueError("Unerwarteter Abschnitt im Master-Musterbestand")
        sections[table] = (columns, rows, match[0])
        offset = match.end()

    if offset != len(sql) or not {"users", "entity_changes"} <= sections.keys():
        raise ValueError("Unvollständiger Master-Musterbestand")

    user_columns = {column.strip('"') for column in sections["users"][0].split(", ")}
    if user_columns & {"password", "totp_uri"}:
        raise ValueError("Zugangsdaten gehören nicht in den Master-Musterbestand")

    return sections


def load_reference_rows(tenant, env, fixture, sections):
    columns, _, user_copy = sections["users"]
    users = ", ".join(f"u.{column}" for column in columns.split(", "))
    user_stage = user_copy.replace("COPY public.users ", "COPY reference_users ", 1)
    tables = ", ".join(f"public.{table}" for table in sections)
    business = "".join(
        block
        for table, (_, _, block) in sections.items()
        if table not in ("users", "entity_changes")
    )

    # Never replace seed credentials with fixture data. Inserting them with the
    # users avoids a later UPDATE trigger changing the captured modified_at.
    # Copy history last, removing audit rows emitted during reconstruction.
    setup = f"""\
ALTER TABLE public.commercial_cases ALTER CONSTRAINT commercial_selected_offer_fk DEFERRABLE;
SET CONSTRAINTS commercial_selected_offer_fk DEFERRED;

CREATE TEMP TABLE test_logins ON COMMIT DROP AS
SELECT username, password FROM public.users WHERE username IN ('john.doe', 'frank.doe');
CREATE TEMP TABLE test_grants ON COMMIT DROP AS
SELECT u.username, a.role_name FROM public.user_role_assignments a
JOIN public.users u ON u.id=a.user_id WHERE u.username IN ('john.doe', 'frank.doe');

TRUNCATE {tables} CASCADE;
CREATE TEMP TABLE reference_users ON COMMIT DROP AS SELECT {columns} FROM public.users WITH NO DATA;
{user_stage}INSERT INTO public.users ({columns}, password)
SELECT {users}, l.password FROM reference_users u LEFT JOIN test_logins l ON l.username=u.username;
{business}SET CONSTRAINTS commercial_selected_offer_fk IMMEDIATE;
ALTER TABLE public.commercial_cases ALTER CONSTRAINT commercial_selected_offer_fk NOT DEFERRABLE;

INSERT INTO public.user_role_assignments (user_id, role_name)
SELECT u.id, r.role_name FROM test_grants r JOIN public.users u ON u.username=r.username;

TRUNCATE public.entity_changes;
{sections["entity_changes"][2]}"""
    command("psql", "-Xq", "--single-transaction", "--set=ON_ERROR_STOP=1", "-f", "-", tenant,
            input=setup, encoding="utf-8", env=env)

    exported, owner = export_rows(tenant, env)
    actual = copy_sections(exported)
    different = [
        table
        for table, (columns, rows, _) in sections.items()
        if table not in actual
        or columns != actual[table][0]
        or sorted(rows.split("\n")) != sorted(actual[table][1].split("\n"))
    ]
    different.extend(actual.keys() - sections.keys())
    if owner != fixture["ownerDecimalId"] or different:
        raise ValueError(f"Master-Musterbestand weicht ab: Administrator oder Tabellen {different}")


@contextmanager
def master_reference(binary, directory):
    """Open the checked-in fixture in a new loopback-only PostgreSQL and S3."""
    with gzip.open(REFERENCE_PATH, "rt", encoding="utf-8") as archive:
        fixture = json.load(archive)

    identity = (fixture["format"], fixture["commit"], fixture["seed"], fixture["bucket"])
    if identity != ("sortsys-master-seed-v1", MASTER, SEED, BUCKET):
        raise ValueError("Unerwartete Master-Referenz")

    sections = copy_sections(fixture["sql"])
    blobs = {
        digest: base64.b64decode(encoded, validate=True)
        for digest, encoded in fixture["blobs"].items()
    }
    for digest, content in blobs.items():
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError("Dateiobjekt weicht von der Master-Referenz ab")

    reference_objects = {key: blobs[digest] for key, digest in fixture["objects"].items()}

    with database(directory) as (port, dsn, env), object_storage() as (endpoint, objects):
        local = seed_environment(port, dsn, endpoint, env)
        command(binary, env=local, capture=True)
        load_reference_rows(f"{dsn}/{TENANT_DB}", env, fixture, sections)

        objects.clear()
        objects.update(reference_objects)
        yield local


def write_fixture(output_path, fixture, date):
    fixture = {"format": "sortsys-master-seed-v1", "commit": MASTER, "seed": SEED,
               "date": date, **fixture}
    with output_path.open("xb") as output:
        with gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as archive:
            archive.write(json.dumps(fixture, ensure_ascii=False, separators=(",", ":")).encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--date", default="2026-11-20", help="UTC date of the reference")
    parser.add_argument("--target-dir", type=Path, help="Dedicated target for the master build")
    args = parser.parse_args()
    clock = datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    if args.output.exists():
        parser.error("The output already exists")

    with tempfile.TemporaryDirectory(prefix="sortsys-master-seed-", dir="/var/tmp") as temp:
        directory = Path(temp)
        source = directory / "master"
        command("git", "worktree", "add", "--detach", source, MASTER, cwd=REPOSITORY)
        try:
            prepare_source(source, int(clock.timestamp()))
            target = args.target_dir.resolve() if args.target_dir else directory / "cargo-target"
            fixture = generate(build(source, target), directory)
        finally:
            command("git", "worktree", "remove", "--force", source, cwd=REPOSITORY)

    write_fixture(args.output, fixture, args.date)


if __name__ == "__main__":
    main()
