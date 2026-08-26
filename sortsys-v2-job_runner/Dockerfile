FROM golang:1.25-alpine AS build

ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath -ldflags='-s -w' -o /out/job-runner ./cmd/job-runner

FROM alpine:3.22

RUN apk --no-cache add ca-certificates
USER nobody:nobody

COPY --from=build /out/job-runner /usr/local/bin/job-runner

ENTRYPOINT ["/usr/local/bin/job-runner"]
