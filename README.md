# ScreenShareP2P

Kvalitetan **peer-to-peer** screenshare za Windows i macOS. Video ide direktno
između tebe i drugara (WebRTC) — bez servera u sredini, bez Discord bitrate limita.

## Kako radi
- **Electron** pakuje Chromium → pouzdano hvatanje ekrana na Win + Mac.
- **WebRTC** za direktan P2P prenos videa.
- **PeerJS** javni broker za signaling → ne moraš ništa da hostuješ.
- Ručno podešen **bitrate (do 40 Mbps), FPS i rezolucija** → oštrija/glatkija slika od Discorda.

## Pokretanje (razvoj)
```bash
npm install
npm start
```

## Upotreba
1. Oboje otvorite app. Svako dobije svoj **kod** (6 slova).
2. Pošalji svoj kod drugaru (npr. preko chata).
3. Jedan ukuca kod drugog i klikne **Poveži**.
4. Klikni **Podeli moj ekran** → izaberi ekran/prozor.
5. Podesi **bitrate / FPS / rezoluciju** po želji (menja se uživo).

## Pravljenje instalera
```bash
npm run dist:win    # -> dist/ScreenShareP2P Setup x.x.x.exe   (mora se pokrenuti na Windowsu)
npm run dist:mac    # -> dist/ScreenShareP2P-x.x.x.dmg         (mora se pokrenuti na macOS-u)
```
> macOS build se **mora** praviti na Mac-u (Apple ograničenje). Alternativa je
> GitHub Actions koji automatski pravi oba builda — mogu da namestim ako želiš.

## Kvalitet: saveti
- **Gaming režim** = glatkih 60fps. **Tekst/Kod režim** = oštra statična slika.
- Na istoj mreži (LAN) slobodno stavi **40 Mbps** — praktično bez kompresije.
- Preko interneta zavisi od uploada; 15–25 Mbps je odlično.

## Napomene / ograničenja
- **Sistemski zvuk (audio igre):** Windows radi preko loopbacka; macOS zahteva
  virtuelni audio drajver (npr. BlackHole). Mikrofon radi svuda.
- **Strog firewall/NAT:** ako direktan P2P ne prođe, koristi se besplatan TURN
  relay (podešen u `renderer.js`). Za maksimalnu pouzdanost stavi svoj TURN.
- **macOS dozvola:** prvi put traži „Screen Recording" dozvolu u System Settings.
