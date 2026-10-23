ARG GO_IMAGE=golang:1.27-bookworm

FROM ${GO_IMAGE} AS build

ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath -ldflags='-s -w' -o /out/job-runner ./cmd/job-runner

# Export tests separately so production images contain neither tests nor the SDK.
FROM build AS test-build

RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go test -c -o /out/ocr-runtime.test ./internal/runner

FROM scratch AS runtime-test-binary

COPY --from=test-build /out/ocr-runtime.test /ocr-runtime.test

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

FROM alpine:3.24 AS runtime

RUN apk add --no-cache \
        ca-certificates \
        font-dejavu \
        imagemagick \
        imagemagick-jpeg \
        imagemagick-webp \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-data-deu \
        tesseract-ocr-data-eng \
    && addgroup -S -g 10001 runner \
    && adduser -S -D -u 10001 -G runner runner

COPY policy.xml /etc/ImageMagick-7/policy.xml

USER runner

COPY --from=build /out/job-runner /usr/local/bin/job-runner

ENTRYPOINT ["/usr/local/bin/job-runner"]
