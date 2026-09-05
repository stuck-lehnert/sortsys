# sortsys job runner

The job runner executes image work outside the API process. It connects to `/internal/job-runners/ws`, leases jobs, downloads source files through signed URLs, generates project-file thumbnails and tenant-logo variants, uploads the results, and reports completion or failure.

## Run locally

```bash
go test ./...

JOB_RUNNER_WS_URL=ws://127.0.0.1:3000/internal/job-runners/ws \
JOB_RUNNER_TOKEN=dev-job-runner-token \
go run ./cmd/job-runner
```

The repository-level `scripts/dev` command starts two watched media runners and one OCR runner automatically.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `JOB_RUNNER_WS_URL` | required | API WebSocket URL |
| `JOB_RUNNER_TOKEN` | required | shared token configured on the API |
| `JOB_RUNNER_ID` | random | stable identifier for this runner |
| `JOB_RUNNER_WS_IGNORE_PROXY` | `false` | bypass `HTTP_PROXY` and `HTTPS_PROXY` for the API connection |
| `JOB_RUNNER_LEASE_SEC` | `90` | requested job lease duration, with a minimum of 5 seconds |
| `JOB_RUNNER_POLL_LIMIT` | `10` | jobs requested per poll, clamped to 1–50 |
| `JOB_RUNNER_POLL_INTERVAL_MS` | `800` | delay between polls, with a minimum of 100 ms |
| `JOB_RUNNER_JOB_TYPE` | `project_file_thumbnail_generate,tenant_logo_generate` | comma-separated accepted job types |
| `JOB_RUNNER_JPEG_QUALITY` | `85` | JPEG quality, clamped to 60–95 |
| `JOB_RUNNER_RETRY_AFTER_SEC` | `60` | retry delay after failures, with a minimum of 5 seconds |
| `JOB_RUNNER_USER_AGENT` | `sortsys-v2-job-runner/0.1` | WebSocket client user agent |

## Container images

```bash
docker build -t sortsys-job-runner:local .
docker build -f Dockerfile.ocr -t sortsys-ocr-job-runner:local .
```

The default image handles thumbnails and logos. The OCR image accepts only `delivery_note_ocr` jobs when `JOB_RUNNER_JOB_TYPE` is set accordingly. It first reads an existing PDF text layer. Scanned pages and images are processed locally with Poppler, ImageMagick, and Tesseract using German and English language data.

Both images run without root privileges. OCR jobs receive short-lived signed download URLs; they do not receive tenant database credentials or LLM API keys.

## License

This service is licensed under the [GNU Affero General Public License v3.0 only](../LICENSE).

