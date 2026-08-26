FROM postgres:17-bookworm AS postgres-client

FROM rust:1.88-bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY rust-api ./rust-api

RUN cargo build --release --locked --package sortsys-api


FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libpq5 \
    libreadline8 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home sortsys

# Database backup/restore routes execute these tools directly.
COPY --from=postgres-client /usr/lib/*-linux-gnu/libpq.so.5.18 /usr/local/lib/libpq.so.5
RUN system_libpq="$(find /usr/lib -name libpq.so.5 -print -quit)" \
    && test -n "${system_libpq}" \
    && rm -f "${system_libpq}" \
    && cp /usr/local/lib/libpq.so.5 "${system_libpq}" \
    && ldconfig
COPY --from=postgres-client /usr/lib/postgresql/17/bin/pg_dump /usr/local/bin/pg_dump
COPY --from=postgres-client /usr/lib/postgresql/17/bin/psql /usr/local/bin/psql

COPY --from=builder /app/target/release/sortsys-api /usr/local/bin/sortsys-api

USER sortsys

ENV PORT=3000
EXPOSE 3000

CMD ["/usr/local/bin/sortsys-api"]
