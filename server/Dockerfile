# Tiny static TURN server image (~15 MB). Good for a Docker-based Pterodactyl
# egg or any container host.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /turnserver .

FROM alpine:3.20
RUN adduser -D -u 10001 turn
USER turn
COPY --from=build /turnserver /turnserver
# Control port (UDP+TCP). Relay port range is set via TURN_MIN_PORT/TURN_MAX_PORT.
EXPOSE 3478/udp 3478/tcp
ENTRYPOINT ["/turnserver"]
