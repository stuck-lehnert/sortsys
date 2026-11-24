#!/usr/bin/env python3
"""Test the capture format, optionally reloading it into a local PostgreSQL."""

import base64
from fnmatch import fnmatchcase
import gzip
import hashlib
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote
from urllib.request import urlopen


EXPORTER = runpy.run_path(str(Path(__file__).with_name("seed-export-master.py")))
EXPORT_ROWS = EXPORTER["export_rows"]
COPY_SECTIONS = EXPORTER["copy_sections"]
OWNER_ID = "9007199254740993"
USER_COLUMNS = "id, username"
USER_LINE = f"{OWNER_ID}\tjohn.doe\n"


def copy_section(table, columns, *rows):
    header = f"COPY public.{table} ({columns}) FROM stdin;\n"
    return header + "".join(f"{row}\n" for row in rows) + "\\.\n"


class ExportRowsTest(unittest.TestCase):
    def capture(self, dump):
        def fake_command(program, *args, **options):
            self.assertTrue(options["capture"])
            if program == "pg_dump":
                for table in ("users", "user_sessions", "user_passkeys", "user_roles"):
                    self.assertIn(f"--exclude-table-data=public.{table}", args)
                return dump.encode()

            self.assertEqual(program, "psql")
            sql = args[-1]
            if "information_schema.columns" in sql:
                self.assertIn("column_name NOT IN ('password', 'totp_uri')", sql)
                self.assertIn("is_generated='NEVER'", sql)
                return f"{USER_COLUMNS}\n".encode()
            if sql.startswith("COPY "):
                self.assertIn(f"SELECT {USER_COLUMNS} FROM public.users ORDER BY id", sql)
                return USER_LINE.encode()

            self.assertIn("WHERE username='john.doe'", sql)
            return f"{OWNER_ID}\n".encode()

        with patch.dict(EXPORT_ROWS.__globals__, command=fake_command):
            return EXPORT_ROWS("fixture-test-dsn", {})

    def test_keeps_nonempty_tables_and_sanitizes_user_copy(self):
        empty = copy_section("commercial_offer_counters", "scope, next_number")
        reserved = copy_section("commercial_offer_number_reservations", "number", "31")
        projects = copy_section("projects", "id, title", "1\tMusterprojekt")
        dump = "\\restrict random-dump-key\n" + empty + reserved + projects

        sql, owner = self.capture(dump)

        self.assertEqual(owner, OWNER_ID)
        users = copy_section("users", USER_COLUMNS, USER_LINE.rstrip("\n"))
        self.assertEqual(sql, users + reserved + projects)

    def test_rejects_truncated_copy(self):
        dump = copy_section("projects", "id, title", "1\tMusterprojekt")
        dump += "COPY public.tools (id) FROM stdin;\n2\n"

        with self.assertRaisesRegex(ValueError, "Unvollständiger Master-Export"):
            self.capture(dump)

    def test_same_capture_has_same_bytes_at_different_paths(self):
        fixture = {"ownerDecimalId": OWNER_ID, "sql": "sample", "objects": {}, "blobs": {}}
        date = "2026-11-20"

        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.json.gz"
            second = Path(directory) / "second.json.gz"
            for target in (first, second):
                EXPORTER["write_fixture"](target, fixture, date)

            self.assertEqual(first.read_bytes(), second.read_bytes())
            with gzip.open(first, "rt", encoding="utf-8") as archive:
                captured = json.load(archive)

            self.assertEqual(captured["commit"], EXPORTER["MASTER"])
            self.assertEqual(captured["seed"], 42)
            self.assertEqual(captured["date"], date)
            self.assertEqual(captured["ownerDecimalId"], OWNER_ID)
            with self.assertRaises(FileExistsError):
                EXPORTER["write_fixture"](first, fixture, date)


class ReferenceSectionsTest(unittest.TestCase):
    def setUp(self):
        self.users = copy_section("users", USER_COLUMNS, USER_LINE.rstrip("\n"))
        self.row = "1\tsecond\\nline"
        self.history = copy_section("entity_changes", 'id, "timestamp"', self.row)
        self.sql = self.users + self.history

    def test_keeps_copy_rows_without_decoding_escapes(self):
        sections = COPY_SECTIONS(self.sql)
        self.assertEqual(list(sections), ["users", "entity_changes"])
        self.assertEqual(sections["users"], (USER_COLUMNS, USER_LINE, self.users))
        self.assertEqual(sections["entity_changes"], ('id, "timestamp"', self.row + "\n", self.history))

    def test_rejects_duplicate_truncated_and_extra_sections(self):
        for sql in (self.sql + self.users, self.sql[:-1], self.users, self.sql + "SELECT 1;\n"):
            with self.subTest(sql=sql), self.assertRaises(ValueError):
                COPY_SECTIONS(sql)

    def test_rejects_credentials(self):
        for credential in ('"password"', "totp_uri"):
            with self.subTest(credential=credential), self.assertRaisesRegex(ValueError, "Zugangsdaten"):
                users = copy_section("users", f"{USER_COLUMNS}, {credential}", f"{USER_LINE.rstrip()}\tvalue")
                COPY_SECTIONS(users + self.history)


class BundledReferenceTest(unittest.TestCase):
    def test_checked_in_capture_contains_only_seed_rows_and_verified_objects(self):
        with gzip.open(EXPORTER["REFERENCE_PATH"], "rt", encoding="utf-8") as archive:
            fixture = json.load(archive)

        self.assertEqual(fixture["format"], "sortsys-master-seed-v1")
        self.assertEqual(fixture["commit"], EXPORTER["MASTER"])
        self.assertEqual((fixture["seed"], fixture["date"]), (42, "2026-11-20"))
        self.assertEqual(fixture["bucket"], EXPORTER["BUCKET"])

        sections = COPY_SECTIONS(fixture["sql"])
        self.assertEqual(len(sections), 40)
        self.assertEqual(sum(rows.count("\n") for _, rows, _ in sections.values()), 4801)

        excluded_tables = set(EXPORTER["EXCLUDED_TABLES"]) - {"users"}
        for table in sections:
            with self.subTest(table=table):
                self.assertFalse(
                    any(fnmatchcase(table, pattern) for pattern in excluded_tables)
                )

        self.assertEqual(len(fixture["objects"]), 304)
        self.assertEqual(set(fixture["objects"].values()), set(fixture["blobs"]))
        for digest, encoded in fixture["blobs"].items():
            with self.subTest(digest=digest):
                content = base64.b64decode(encoded, validate=True)
                self.assertEqual(hashlib.sha256(content).hexdigest(), digest)


@unittest.skipUnless(os.environ.get("SORTSYS_MASTER_SEED_BIN"), "Master-Seed-Binary fehlt")
class MasterReferenceTest(unittest.TestCase):
    def test_same_postgres_rows_objects_and_test_logins(self):
        with gzip.open(EXPORTER["REFERENCE_PATH"], "rt", encoding="utf-8") as archive:
            fixture = json.load(archive)

        binary = Path(os.environ["SORTSYS_MASTER_SEED_BIN"]).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="sortsys-master-reference-") as directory:
            with EXPORTER["master_reference"](binary, Path(directory)) as local:
                endpoint = local["TEST_S3_ENDPOINT"]
                for name, digest in fixture["objects"].items():
                    url = f"{endpoint}/{fixture['bucket']}/{quote(name)}"
                    with urlopen(url, timeout=5) as response:
                        self.assertEqual(hashlib.sha256(response.read()).hexdigest(), digest, name)

                master_dsn = local["PG_MASTER_DSN"].removesuffix("/seed_master")
                tenant = f"{master_dsn}/{EXPORTER['TENANT_DB']}"
                sql = """
SELECT username, length(password) > 0,
       EXISTS (SELECT FROM user_role_assignments WHERE user_id=users.id AND role_name=':admin')
FROM public.users WHERE username IN ('john.doe', 'frank.doe') ORDER BY username;
"""
                logins = EXPORTER["command"](
                    "psql", "-XqAt", "--set=ON_ERROR_STOP=1", "-c", sql, tenant, env=local, capture=True,
                ).decode().splitlines()
                self.assertEqual(logins, ["frank.doe|t|f", "john.doe|t|t"])


if __name__ == "__main__":
    unittest.main()
