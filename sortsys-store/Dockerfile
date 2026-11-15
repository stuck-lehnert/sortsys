FROM rust:1.99-bookworm AS duckdb
COPY sortsys-api-v2/rust-api/duckdb/install /tmp/install-duckdb
RUN bash /tmp/install-duckdb /opt/duckdb

FROM rust:1.99-bookworm AS builder
COPY --from=duckdb /opt/duckdb /opt/duckdb
ENV DUCKDB_LIB_DIR=/opt/duckdb DUCKDB_INCLUDE_DIR=/opt/duckdb
WORKDIR /app/sortsys-store
COPY sortsys-store/Cargo.toml sortsys-store/Cargo.lock ./
COPY sortsys-store/src ./src
COPY sortsys-zerotrust/Cargo.toml /app/sortsys-zerotrust/Cargo.toml
COPY sortsys-zerotrust/rust /app/sortsys-zerotrust/rust
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home sortsys \
    && install -d -m 0700 -o 10001 -g 0 /var/lib/sortsys-duckdb
COPY --from=duckdb /opt/duckdb/libduckdb.so /usr/local/lib/
COPY --from=duckdb /opt/duckdb/extensions /usr/local/share/sortsys-duckdb/extensions
COPY sortsys-api-v2/rust-api/duckdb/licenses /usr/local/share/licenses/sortsys-duckdb
COPY --from=builder /app/sortsys-store/target/release/sortsys-duckdb /usr/local/bin/sortsys-duckdb
RUN ldconfig
USER sortsys
EXPOSE 9494 9495
CMD ["/usr/local/bin/sortsys-duckdb"]
