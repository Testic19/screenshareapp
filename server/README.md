# screenshare-turn

Mali, brz **TURN/STUN relay** (Go, `pion/turn`) za ScreenShareP2P. Jedan static
binary, bez zavisnosti — savršen za Pterodactyl container ili jeftin VPS.

Server **ne vidi video** (WebRTC je end-to-end enkriptovan) — samo prosleđuje
pakete. Zato je CPU/RAM trivijalno; jedini pravi trošak je **protok**.

## Resursi (2K60, obojica, oba pravca ~25 Mbps/stream)
| | |
|---|---|
| CPU | ~0.1–0.3 jezgra (1 vCPU je višak) |
| RAM | ~50–150 MB (256 MB udobno) |
| Mreža | ~50 Mbps ↑ / ~50 Mbps ↓ (skalira sa bitrate-om) |

## Konfiguracija (env varijable)
| Varijabla | Podrazumevano | Opis |
|---|---|---|
| `TURN_PUBLIC_IP` | **(obavezno)** | Javna IP servera (npr. IP Pterodactyl node-a) |
| `TURN_PORT` | `3478` (ili `SERVER_PORT`) | Kontrolni port (UDP+TCP) |
| `TURN_REALM` | `screenshare` | Realm |
| `TURN_USERS` | — | `"pera=tajna1,mika=tajna2"` |
| `TURN_USER` / `TURN_PASSWORD` | — | Alternativa za jednog korisnika |
| `TURN_MIN_PORT` | `49160` | Početak opsega relay portova |
| `TURN_MAX_PORT` | `49200` | Kraj opsega relay portova |
| `TURN_ENABLE_TCP` | `true` | TCP fallback (probija firewall koji blokira UDP) |

> **Pterodactyl:** alociraj kontrolni port + mali opseg relay portova (za 2 osobe
> ~10 portova je dovoljno) i postavi `TURN_MIN_PORT`/`TURN_MAX_PORT` na taj opseg.

## Pokretanje

### Gotov binary (Linux)
```bash
TURN_PUBLIC_IP=203.0.113.5 \
TURN_USERS="pera=nekaJakaLozinka" \
TURN_MIN_PORT=49160 TURN_MAX_PORT=49200 \
./turnserver-linux-amd64
```

### Iz izvora
```bash
go run .    # sa istim env varijablama
```

### Docker
```bash
docker build -t screenshare-turn .
docker run --network host \
  -e TURN_PUBLIC_IP=203.0.113.5 \
  -e TURN_USERS="pera=nekaJakaLozinka" \
  -e TURN_MIN_PORT=49160 -e TURN_MAX_PORT=49200 \
  screenshare-turn
```

Na startu ispiše gotov **ICE config** za nalepiti u app.

## Portovi koje treba otvoriti
- `TURN_PORT` (default 3478) — **UDP i TCP**
- `TURN_MIN_PORT`–`TURN_MAX_PORT` — **UDP** (relay saobraćaj)
