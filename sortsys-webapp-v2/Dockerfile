FROM oven/bun:1.3.5 AS api-client-builder
WORKDIR /app/sortsys-api-v2
COPY sortsys-api-v2/ ./
RUN bun install --frozen-lockfile \
  && cd client \
  && bun install --frozen-lockfile \
  && bun run build


FROM rust:1.88-alpine AS dwg-wasm-builder
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY sortsys-dwgviewer/lib/ ./
RUN rustup target add wasm32-unknown-unknown \
  && cargo build --locked --release --target wasm32-unknown-unknown \
  && mkdir -p /out \
  && cp target/wasm32-unknown-unknown/release/sortsys_dwg_parser.wasm /out/sortsys-dwg-rust.wasm

FROM node:22-alpine AS builder
ENV NODE_OPTIONS=--max-old-space-size=4096
WORKDIR /app/sortsys-dwgviewer
COPY sortsys-dwgviewer/package.json sortsys-dwgviewer/package-lock.json ./
RUN npm ci

WORKDIR /app/sortsys-webapp-v2
COPY sortsys-webapp-v2/package.json sortsys-webapp-v2/package-lock.json ./
COPY --from=api-client-builder /app/sortsys-api-v2/client/dist /app/sortsys-api-v2/client/dist
COPY sortsys-react-components /app/sortsys-react-components
RUN npm ci
COPY sortsys-dwgviewer/ /app/sortsys-dwgviewer/
COPY --from=dwg-wasm-builder /out/ /app/sortsys-dwgviewer/src/dwg/wasm/
COPY sortsys-webapp-v2/ ./
RUN npm run build


FROM nginx:1.28-alpine
COPY --from=builder /app/sortsys-webapp-v2/build/client/ /usr/share/nginx/html/
COPY sortsys-webapp-v2/nginx.conf.template /etc/nginx/templates/default.conf.template

ENV API_UPSTREAM=http://api:3000 \
    CLIENT_MAX_BODY_SIZE=64m

EXPOSE 80
