// Command screenshare-turn is a small, fast TURN/STUN relay for the
// ScreenShareP2P app. Built on pion/turn (pure Go) so it ships as a single
// static binary with zero runtime dependencies — ideal for a Pterodactyl
// container or any cheap VPS.
//
// It only forwards already-encrypted WebRTC packets (it never sees the video),
// so CPU/RAM cost is tiny; bandwidth is the only real resource. A limited relay
// port range is configurable to fit Pterodactyl's per-port allocations.
package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/pion/turn/v4"
)

type config struct {
	PublicIP  string
	Port      int
	Realm     string
	Users     map[string]string
	MinPort   uint16
	MaxPort   uint16
	EnableTCP bool
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[turn] ")

	cfg := loadConfig()

	// Precompute long-term credential keys (HMAC of user/realm/pass).
	userKeys := map[string][]byte{}
	for name, pass := range cfg.Users {
		userKeys[name] = turn.GenerateAuthKey(name, cfg.Realm, pass)
	}

	// Self-test: how many relay ports can we actually bind? On Pterodactyl the
	// container can only bind ALLOCATED ports, so this instantly reveals a
	// misconfigured range (the usual cause of "max retries exceeded").
	checkRelayPorts(cfg.MinPort, cfg.MaxPort)

	relayGen := &turn.RelayAddressGeneratorPortRange{
		RelayAddress: net.ParseIP(cfg.PublicIP),
		Address:      "0.0.0.0",
		MinPort:      cfg.MinPort,
		MaxPort:      cfg.MaxPort,
		// High retry count so allocation still finds a free/bindable port even
		// when only a few ports in the range are usable.
		MaxRetries: 100,
	}

	var packetConns []turn.PacketConnConfig
	var listenerConns []turn.ListenerConfig

	// UDP — the primary, lowest-latency path.
	udpConn, err := net.ListenPacket("udp4", fmt.Sprintf("0.0.0.0:%d", cfg.Port))
	if err != nil {
		log.Fatalf("ne mogu da slušam UDP na %d: %v", cfg.Port, err)
	}
	packetConns = append(packetConns, turn.PacketConnConfig{
		PacketConn:            udpConn,
		RelayAddressGenerator: relayGen,
	})

	// TCP — fallback that punches through firewalls which block UDP.
	if cfg.EnableTCP {
		tcpListener, err := net.Listen("tcp4", fmt.Sprintf("0.0.0.0:%d", cfg.Port))
		if err != nil {
			log.Printf("upozorenje: TCP na %d nije uspeo (%v) — nastavljam samo UDP", cfg.Port, err)
		} else {
			listenerConns = append(listenerConns, turn.ListenerConfig{
				Listener:              tcpListener,
				RelayAddressGenerator: relayGen,
			})
		}
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm: cfg.Realm,
		AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			if key, ok := userKeys[username]; ok {
				return key, true
			}
			log.Printf("odbijena autentikacija: korisnik=%q sa %s", username, srcAddr)
			return nil, false
		},
		PacketConnConfigs: packetConns,
		ListenerConfigs:   listenerConns,
	})
	if err != nil {
		log.Fatalf("turn.NewServer: %v", err)
	}

	printBanner(cfg)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	log.Println("gašenje…")
	if err := server.Close(); err != nil {
		log.Printf("greška pri gašenju: %v", err)
	}
}

// loadConfig reads everything from environment variables (12-factor style),
// which maps cleanly onto Pterodactyl's egg variables.
func loadConfig() config {
	c := config{
		Port:      envInt("TURN_PORT", envInt("SERVER_PORT", 3478)),
		Realm:     env("TURN_REALM", "screenshare"),
		MinPort:   uint16(envInt("TURN_MIN_PORT", 49160)),
		MaxPort:   uint16(envInt("TURN_MAX_PORT", 49200)),
		EnableTCP: envBool("TURN_ENABLE_TCP", true),
		Users:     map[string]string{},
	}

	c.PublicIP = strings.TrimSpace(env("TURN_PUBLIC_IP", ""))
	if c.PublicIP == "" {
		log.Fatal("TURN_PUBLIC_IP je obavezan (javna IP adresa servera, npr. 203.0.113.5)")
	}
	if net.ParseIP(c.PublicIP) == nil {
		log.Fatalf("TURN_PUBLIC_IP nije validna IP: %q", c.PublicIP)
	}

	// Multi-user form: TURN_USERS="pera=tajna1,mika=tajna2"
	if raw := env("TURN_USERS", ""); raw != "" {
		for _, pair := range strings.Split(raw, ",") {
			kv := strings.SplitN(strings.TrimSpace(pair), "=", 2)
			if len(kv) == 2 && kv[0] != "" && kv[1] != "" {
				c.Users[kv[0]] = kv[1]
			}
		}
	}
	// Single-user shortcut: TURN_USER + TURN_PASSWORD
	if u := strings.TrimSpace(env("TURN_USER", "")); u != "" {
		c.Users[u] = env("TURN_PASSWORD", "")
	}

	if len(c.Users) == 0 {
		log.Fatal(`nema korisnika: postavi TURN_USERS="ime=lozinka" ili TURN_USER + TURN_PASSWORD`)
	}
	if c.MinPort > c.MaxPort {
		log.Fatalf("TURN_MIN_PORT (%d) je veći od TURN_MAX_PORT (%d)", c.MinPort, c.MaxPort)
	}
	return c
}

// printBanner logs a ready-to-paste ICE config for the app.
func printBanner(c config) {
	log.Printf("TURN server sluša na 0.0.0.0:%d (UDP%s)", c.Port, tcpNote(c.EnableTCP))
	log.Printf("javna IP: %s | realm: %s | relay portovi: %d-%d", c.PublicIP, c.Realm, c.MinPort, c.MaxPort)
	log.Printf("korisnika: %d", len(c.Users))

	var user, pass string
	for u, p := range c.Users {
		user, pass = u, p
		break
	}
	fmt.Println()
	fmt.Println("==================== ICE CONFIG ZA APP ====================")
	fmt.Printf("{ urls: 'stun:%s:%d' },\n", c.PublicIP, c.Port)
	fmt.Printf("{ urls: 'turn:%s:%d?transport=udp', username: '%s', credential: '%s' },\n", c.PublicIP, c.Port, user, pass)
	fmt.Printf("{ urls: 'turn:%s:%d?transport=tcp', username: '%s', credential: '%s' },\n", c.PublicIP, c.Port, user, pass)
	fmt.Println("===========================================================")
	fmt.Println()
}

// checkRelayPorts tries to bind every UDP port in the range and reports how
// many succeed. On Pterodactyl an unallocated port cannot be bound, so a low
// count means you must allocate more (contiguous) ports and match the range.
func checkRelayPorts(min, max uint16) {
	ok := 0
	var bad []uint16
	for p := int(min); p <= int(max); p++ {
		conn, err := net.ListenPacket("udp4", fmt.Sprintf("0.0.0.0:%d", p))
		if err != nil {
			bad = append(bad, uint16(p))
			continue
		}
		_ = conn.Close()
		ok++
	}
	total := int(max-min) + 1
	log.Printf("relay portovi bindable: %d/%d", ok, total)
	if ok == 0 {
		log.Printf("KRITIČNO: nijedan relay port se ne može vezati — alociraj opseg u Ptero i podesi TURN_MIN_PORT/TURN_MAX_PORT na te portove!")
	} else if len(bad) > 0 {
		log.Printf("upozorenje: %d portova nije bindable (nisu alocirani u Ptero?): %v", len(bad), bad)
	}
}

func tcpNote(enabled bool) string {
	if enabled {
		return "+TCP"
	}
	return ""
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "yes", "da", "on":
			return true
		case "0", "false", "no", "ne", "off":
			return false
		}
	}
	return def
}
