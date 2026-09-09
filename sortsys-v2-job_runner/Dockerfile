ARG GO_IMAGE=golang:1.25-bookworm

FROM ${GO_IMAGE} AS build

ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath -ldflags='-s -w' -o /out/job-runner ./cmd/job-runner

FROM ${GO_IMAGE} AS development

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        imagemagick \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-deu \
        tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/sortsys-v2-job_runner

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        imagemagick \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-deu \
        tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --create-home runner
USER runner

COPY --from=build /out/job-runner /usr/local/bin/job-runner

ENTRYPOINT ["/usr/local/bin/job-runner"]
