FROM postgres:17-bookworm AS postgres-client

FROM rust:1.99-bookworm AS duckdb
COPY rust-api/duckdb/install /tmp/install-duckdb
RUN bash /tmp/install-duckdb /opt/duckdb

FROM rust:1.99-bookworm AS builder

COPY --from=duckdb /opt/duckdb /opt/duckdb
ENV DUCKDB_LIB_DIR=/opt/duckdb DUCKDB_INCLUDE_DIR=/opt/duckdb

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY rust-api ./rust-api
COPY seed-assets ./seed-assets

RUN cargo build --release --locked --package sortsys-api


FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libgssapi-krb5-2 \
    libldap-2.5-0 \
    liblz4-1 \
    libreadline8 \
    libssl3 \
    libstdc++6 \
    libzstd1 \
    zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home sortsys \
    && install -d -m 0700 -o 10001 -g 0 /var/lib/sortsys-duckdb

# Database backup/restore routes execute these tools directly.
COPY --from=postgres-client /usr/lib/*-linux-gnu/libpq.so.5.* /usr/local/lib/
COPY --from=duckdb /opt/duckdb/libduckdb.so /usr/local/lib/
COPY --from=duckdb /opt/duckdb/extensions /usr/local/share/sortsys-duckdb/extensions
COPY rust-api/duckdb/licenses /usr/local/share/licenses/sortsys-duckdb
RUN ldconfig
COPY --from=postgres-client /usr/lib/postgresql/17/bin/pg_dump /usr/local/bin/pg_dump
COPY --from=postgres-client /usr/lib/postgresql/17/bin/psql /usr/local/bin/psql

COPY --from=builder /app/target/release/sortsys-api /usr/local/bin/sortsys-api
COPY --from=builder /app/target/release/sortsys_duckdb /usr/local/bin/sortsys-duckdb

USER sortsys

ENV PORT=3000
EXPOSE 3000

CMD ["/usr/local/bin/sortsys-api"]
