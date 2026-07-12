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
	"sync"
	"syscall"
	"time"

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

	relayGen := &loggingGenerator{inner: &turn.RelayAddressGeneratorPortRange{
		RelayAddress: net.ParseIP(cfg.PublicIP),
		Address:      "0.0.0.0",
		MinPort:      cfg.MinPort,
		MaxPort:      cfg.MaxPort,
		// High retry count so allocation still finds a free/bindable port even
		// when only a few ports in the range are usable.
		MaxRetries: 100,
	}}

	var packetConns []turn.PacketConnConfig
	var listenerConns []turn.ListenerConfig

	// UDP — the primary, lowest-latency path.
	udpConn, err := net.ListenPacket("udp4", fmt.Sprintf("0.0.0.0:%d", cfg.Port))
	if err != nil {
		log.Fatalf("ne mogu da slušam UDP na %d: %v", cfg.Port, err)
	}
	tuneUDPBuffers(udpConn)

	// Custom ScreenShare forwarder protocol, multiplexed on the SAME UDP port
	// (all its packets start with the 0xC5 magic byte, which never collides
	// with STUN/TURN). One port, zero relay-port allocations needed.
	fw := newForwarder(udpConn, cfg.Users)
	muxed := &muxConn{PacketConn: udpConn, handle: fw.handle}

	packetConns = append(packetConns, turn.PacketConnConfig{
		PacketConn:            muxed,
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
	log.Printf("FORWARDER (novi protokol) aktivan na istom UDP portu %d — bez relay portova", c.Port)
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

// ---------------------------------------------------------------------------
// ScreenShare forwarder — a dumb, fast pairing relay for the app's custom
// (non-WebRTC) media protocol. Two clients register into a "room" (the code
// the users exchange); every DATA packet from one is forwarded verbatim to
// the other. The server never parses media. Runs on the SAME UDP socket as
// TURN via muxConn (magic byte 0xC5).
//
// Wire format (client<->server):
//   [0xC5][0x01] REG   : u8 ulen, user, u8 plen, pass, u8 rlen, room
//   [0xC5][0x02] REGOK : u8 otherPeerPresent (server->client)
//   [0xC5][0x03] PEER_JOINED (server->client)
//   [0xC5][0x04] PEER_LEFT   (server->client)
//   [0xC5][0x10] DATA  : opaque payload, forwarded to the room's other peer
//   [0xC5][0x20] PING  : 8B opaque -> echoed back as [0xC5][0x21] PONG
// ---------------------------------------------------------------------------

const fwdMagic = 0xC5

type fwdSlot struct {
	addr net.Addr
	key  string
	last time.Time
}

type fwdRoom struct {
	peers [2]*fwdSlot
}

type forwarder struct {
	mu     sync.Mutex
	conn   net.PacketConn
	users  map[string]string
	rooms  map[string]*fwdRoom
	byAddr map[string]*fwdRef
}

type fwdRef struct {
	roomID string
	idx    int
}

func newForwarder(conn net.PacketConn, users map[string]string) *forwarder {
	f := &forwarder{
		conn:   conn,
		users:  users,
		rooms:  map[string]*fwdRoom{},
		byAddr: map[string]*fwdRef{},
	}
	go f.sweep()
	return f
}

// handle consumes one 0xC5 packet. Called inline from the mux read loop, so
// it must stay fast: map lookups + a single WriteTo.
func (f *forwarder) handle(p []byte, addr net.Addr) {
	if len(p) < 2 {
		return
	}
	switch p[1] {
	case 0x01:
		f.register(p[2:], addr)
	case 0x10:
		f.forward(p, addr)
	case 0x20:
		out := make([]byte, len(p))
		copy(out, p)
		out[1] = 0x21
		_, _ = f.conn.WriteTo(out, addr)
	}
}

func (f *forwarder) register(p []byte, addr net.Addr) {
	readStr := func(b []byte) (string, []byte, bool) {
		if len(b) < 1 || len(b) < 1+int(b[0]) {
			return "", nil, false
		}
		return string(b[1 : 1+b[0]]), b[1+b[0]:], true
	}
	user, rest, ok := readStr(p)
	if !ok {
		return
	}
	pass, rest, ok := readStr(rest)
	if !ok {
		return
	}
	roomID, _, ok := readStr(rest)
	if !ok || roomID == "" {
		return
	}
	if want, exists := f.users[user]; !exists || want != pass {
		log.Printf("fwd: odbijen REG (los kredencijal) sa %s", addr)
		return
	}

	key := addr.String()
	now := time.Now()

	f.mu.Lock()
	// Leave any previous room this address occupied.
	if ref, ok := f.byAddr[key]; ok && ref.roomID != roomID {
		f.leaveLocked(key, ref)
	}
	room := f.rooms[roomID]
	if room == nil {
		room = &fwdRoom{}
		f.rooms[roomID] = room
	}
	// Refresh existing slot, or take a free/stale one.
	idx := -1
	for i, s := range room.peers {
		if s != nil && s.key == key {
			idx = i
			break
		}
	}
	if idx == -1 {
		for i, s := range room.peers {
			if s == nil || now.Sub(s.last) > 15*time.Second {
				if s != nil {
					delete(f.byAddr, s.key)
				}
				idx = i
				break
			}
		}
	}
	if idx == -1 {
		f.mu.Unlock()
		log.Printf("fwd: soba %q puna, odbijen %s", roomID, addr)
		return
	}
	isNew := room.peers[idx] == nil || room.peers[idx].key != key
	room.peers[idx] = &fwdSlot{addr: addr, key: key, last: now}
	f.byAddr[key] = &fwdRef{roomID: roomID, idx: idx}

	other := room.peers[1-idx]
	otherLive := other != nil && now.Sub(other.last) <= 15*time.Second
	f.mu.Unlock()

	present := byte(0)
	if otherLive {
		present = 1
	}
	_, _ = f.conn.WriteTo([]byte{fwdMagic, 0x02, present}, addr)
	if isNew && otherLive {
		_, _ = f.conn.WriteTo([]byte{fwdMagic, 0x03}, addr)
		_, _ = f.conn.WriteTo([]byte{fwdMagic, 0x03}, other.addr)
		log.Printf("fwd: soba %q uparena (%s <-> %s)", roomID, addr, other.addr)
	}
}

func (f *forwarder) forward(p []byte, addr net.Addr) {
	key := addr.String()
	f.mu.Lock()
	ref, ok := f.byAddr[key]
	if !ok {
		f.mu.Unlock()
		return
	}
	room := f.rooms[ref.roomID]
	if room == nil {
		f.mu.Unlock()
		return
	}
	if self := room.peers[ref.idx]; self != nil {
		self.last = time.Now()
	}
	other := room.peers[1-ref.idx]
	var dst net.Addr
	if other != nil {
		dst = other.addr
	}
	f.mu.Unlock()

	if dst != nil {
		_, _ = f.conn.WriteTo(p, dst)
	}
}

func (f *forwarder) leaveLocked(key string, ref *fwdRef) {
	if room := f.rooms[ref.roomID]; room != nil {
		if s := room.peers[ref.idx]; s != nil && s.key == key {
			room.peers[ref.idx] = nil
			if other := room.peers[1-ref.idx]; other != nil {
				_, _ = f.conn.WriteTo([]byte{fwdMagic, 0x04}, other.addr)
			}
		}
		if room.peers[0] == nil && room.peers[1] == nil {
			delete(f.rooms, ref.roomID)
		}
	}
	delete(f.byAddr, key)
}

func (f *forwarder) sweep() {
	for range time.Tick(5 * time.Second) {
		now := time.Now()
		f.mu.Lock()
		for key, ref := range f.byAddr {
			room := f.rooms[ref.roomID]
			if room == nil {
				delete(f.byAddr, key)
				continue
			}
			if s := room.peers[ref.idx]; s == nil || s.key != key || now.Sub(s.last) > 15*time.Second {
				f.leaveLocked(key, ref)
			}
		}
		f.mu.Unlock()
	}
}

// muxConn splits one UDP socket between the forwarder (0xC5 packets, consumed
// inline) and TURN/STUN (everything else, passed to pion).
type muxConn struct {
	net.PacketConn
	handle func(p []byte, addr net.Addr)
}

func (m *muxConn) ReadFrom(p []byte) (int, net.Addr, error) {
	for {
		n, addr, err := m.PacketConn.ReadFrom(p)
		if err != nil {
			return n, addr, err
		}
		if n > 0 && p[0] == fwdMagic {
			buf := make([]byte, n)
			copy(buf, p[:n])
			m.handle(buf, addr)
			continue
		}
		return n, addr, err
	}
}

// loggingGenerator wraps the port-range generator to log every relay
// allocation (visibility for debugging) and to enlarge the socket buffers on
// each relay conn — 60fps video bursts overflow small default UDP buffers,
// which shows up as packet loss and a throttled bitrate.
type loggingGenerator struct {
	inner *turn.RelayAddressGeneratorPortRange
}

func (g *loggingGenerator) Validate() error { return g.inner.Validate() }

func (g *loggingGenerator) AllocatePacketConn(network string, requestedPort int) (net.PacketConn, net.Addr, error) {
	conn, addr, err := g.inner.AllocatePacketConn(network, requestedPort)
	if err != nil {
		log.Printf("relay alokacija NEUSPELA: %v", err)
		return nil, nil, err
	}
	tuneUDPBuffers(conn)
	log.Printf("relay alociran: %s", addr)
	return conn, addr, nil
}

func (g *loggingGenerator) AllocateConn(network string, requestedPort int) (net.Conn, net.Addr, error) {
	return g.inner.AllocateConn(network, requestedPort)
}

// tuneUDPBuffers raises socket buffers (best effort; kernel caps may apply).
func tuneUDPBuffers(conn net.PacketConn) {
	if u, ok := conn.(*net.UDPConn); ok {
		_ = u.SetReadBuffer(4 << 20)
		_ = u.SetWriteBuffer(4 << 20)
	}
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
