FROM rust:1.89-bookworm AS build
WORKDIR /src
COPY rust ./rust
RUN cargo build --locked --release -p celiums-memory-cli

FROM debian:bookworm-slim
RUN useradd --create-home --uid 10001 celiums
COPY --from=build /src/rust/target/release/celiums-memory /usr/local/bin/celiums-memory
RUN mkdir -p /data/memory && chown -R celiums:celiums /data
USER celiums
EXPOSE 3210
ENTRYPOINT ["/usr/local/bin/celiums-memory", "serve", "--bind", "0.0.0.0:3210", "--data", "/data/memory"]
