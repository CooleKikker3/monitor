# VPS Monitor

Lichtgewicht dashboard voor CPU-, RAM- en opslaggebruik van je server, met historie tot 30 dagen.

- Live waarden (elke 5 seconden) met status: Normaal / Hoog (≥ 75%) / Kritiek (≥ 90%)
- Grafieken over 1 uur, 6 uur, 24 uur, 7 dagen en 30 dagen
- Per project: CPU, RAM, verzoeken/min, 5xx-fouten, bereikbaarheid, certificaat, schijfruimte en laatste commit (zie "Projecten volgen" in [DEPLOY.md](DEPLOY.md))
- Inloggen met vaste gegevens uit `.env`
- Geen database: historie staat in `data/history.json` (per minuut, ± 3 MB bij 30 dagen)
- Licht en donker thema (volgt je systeeminstelling)

## Lokaal starten

```bash
npm install
cp .env.example .env   # en vul de waarden in
npm start
```

Open daarna `http://localhost:3000`.

## Instellingen (`.env`)

| Variabele | Uitleg |
|---|---|
| `MONITOR_USER` / `MONITOR_PASSWORD` | Inloggegevens |
| `SESSION_SECRET` | Lange willekeurige string. Genereer met `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` / `HOST` | Waar de server luistert (standaard `0.0.0.0:3000`) |
| `COOKIE_SECURE` | `true` zodra het dashboard via HTTPS draait |
| `TRUST_PROXY` | `true` als er nginx/Caddy voor staat (nodig voor correcte IP's bij de inlogbeveiliging) |
| `SAMPLE_INTERVAL_SECONDS` | Hoe vaak er gemeten wordt (standaard 5) |
| `RETENTION_DAYS` | Hoe lang historie bewaard wordt (standaard 30) |
| `DISK_PATH` | Welke schijf/mount gemeten wordt (standaard `/`) |

Na 10 mislukte inlogpogingen wordt een IP 15 minuten geblokkeerd. Een sessie blijft 7 dagen geldig.

## Online zetten

Zie [DEPLOY.md](DEPLOY.md) voor de volledige uitrol op de VPS: nginx ervoor, HTTPS met certbot, een systemd-service als `www-data` en `deploy.sh` voor nieuwe versies.

## Hoe er gemeten wordt

- **CPU**: verschil in CPU-tijden tussen twee metingen, over alle cores samen. Bij langere periodes toont de tooltip ook de piek binnen dat tijdvak.
- **RAM**: `MemTotal − MemAvailable` uit `/proc/meminfo`, dus zonder cache/buffers (zoals `free -h` bij "used").
- **Opslag**: zelfde berekening als `df` voor `DISK_PATH`.

Historie wordt elke minuut weggeschreven. Is de server een tijd uit geweest, dan zie je een onderbreking in de grafiek.
