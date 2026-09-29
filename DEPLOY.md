# Servermonitor online zetten

Dit project is een Node.js-app die zelf een webserver draait. In de VPS-handleiding valt het
onder **D. Eigen runtime**. Dit bestand is die route, helemaal ingevuld voor de monitor.

| | |
| --- | --- |
| Projectnaam | `monitor` (map, service, nginx-bestand en logbestanden) |
| Domein | `monitor.coenvink.com` |
| Map | `/var/www/monitor` |
| Poort | `3001`, alleen op `127.0.0.1` |
| Draait als | `www-data` |
| Schrijft naar | `/var/www/monitor/data/` (de historie) |
| Repository | `https://github.com/CooleKikker3/monitor` |

Wil je een ander subdomein of een andere poort, verander het dan overal in dit bestand op
dezelfde manier.

---

# Stap 1: DNS

Zet bij je domeinnaam deze records:

| Type | Naam | Waarde |
| --- | --- | --- |
| A | `monitor` | `217.154.118.71` |
| AAAA | `monitor` | `2a02:2479:13:7700::1` |

Controleer met `nslookup monitor.coenvink.com`. Certbot heeft dit in stap 7 nodig, dus doe
het als eerste.

# Stap 2: Node.js installeren (eenmalig)

Staat Node er nog niet op, installeer dan de huidige LTS-versie via NodeSource:

```bash
node -v   # geeft een versie? Dan is deze stap klaar (minimaal v18.15 nodig)

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v && npm -v
```

`apt install nodejs` zonder NodeSource kan ook, maar dan krijg je de versie uit Ubuntu en die
loopt vaak achter. Controleer bij die route of `node -v` minimaal 18.15 geeft.

Draait er later een tweede Node-project op de VPS, dan is deze stap al gedaan.

# Stap 3: Code op de server

```bash
git clone https://github.com/CooleKikker3/monitor /var/www/monitor
cd /var/www/monitor
npm ci --omit=dev
```

`npm ci` installeert precies de versies uit `package-lock.json`. `node_modules` blijft van root
en is voor `www-data` alleen-lezen.

# Stap 4: Configuratie en rechten

```bash
cp .env.example .env
nano .env
```

Zet in `.env`:

```
MONITOR_USER=<jouw gebruikersnaam>
MONITOR_PASSWORD=<een sterk wachtwoord>
SESSION_SECRET=<uitvoer van het commando hieronder>

PORT=3001
HOST=127.0.0.1

COOKIE_SECURE=true
TRUST_PROXY=true

SAMPLE_INTERVAL_SECONDS=5
RETENTION_DAYS=30
DISK_PATH=/
```

Een `SESSION_SECRET` maak je met:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Waarom deze waarden:

* **`HOST=127.0.0.1`**: de app is dan alleen via nginx bereikbaar. Met `0.0.0.0` kan iedereen
  er via `http://217.154.118.71:3001` omheen, zonder HTTPS.
* **`COOKIE_SECURE=true`**: de browser stuurt de inlogcookie dan alleen over HTTPS mee.
  Inloggen via gewoon `http://` werkt daardoor niet meer. Dat is de bedoeling.
* **`TRUST_PROXY=true`**: anders ziet de app bij elk verzoek `127.0.0.1` als afzender, en
  blokkeert de inlogbeveiliging na 10 fouten iedereen in plaats van alleen de aanvaller.

Dan de rechten. De app moet `.env` kunnen lezen en alleen in `data/` kunnen schrijven:

```bash
chmod 755 /var/www/monitor
mkdir -p /var/www/monitor/data
chown -R www-data:www-data /var/www/monitor/data
chown root:www-data /var/www/monitor/.env
chmod 640 /var/www/monitor/.env
```

# Stap 5: De service

Kijk eerst of poort 3001 vrij is:

```bash
ss -tlnp | grep 3001   # geen uitvoer = vrij
```

In de repository staat een kant-en-klare service. Die draait als `www-data`, en bij een
crash of een herstart van de server start hij vanzelf weer:

```bash
cp /var/www/monitor/monitor.service /etc/systemd/system/monitor.service
systemctl daemon-reload
systemctl enable --now monitor
systemctl status monitor
```

In `status` hoort `active (running)` te staan, met de regel
`Monitor draait op http://127.0.0.1:3001`. Test hem lokaal:

```bash
curl -i http://127.0.0.1:3001/login
```

De poort komt uit `.env`, niet uit het servicebestand. Wil je een andere poort, dan pas je hem
alleen daar aan (en in de nginx-config).

# Stap 6: nginx

```bash
nano /etc/nginx/sites-available/monitor
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name monitor.coenvink.com;

    access_log /var/log/nginx/monitor.access.log;
    error_log  /var/log/nginx/monitor.error.log;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/monitor /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
curl -i http://monitor.coenvink.com/login
```

Krijg je een `200`, dan kan het certificaat erop. Inloggen kan nu nog niet, omdat de cookie
alleen over HTTPS meegaat.

| Wat je ziet | Waar het meestal aan ligt |
| --- | --- |
| `502 Bad Gateway` | de service draait niet (`systemctl status monitor`), of de poort in `.env` en in nginx is niet gelijk |
| Lege reactie | nginx kent `monitor.coenvink.com` nog niet: het bestand staat niet in `sites-enabled`, of nginx is niet herladen |
| Inloggen lukt, maar je komt steeds terug op het inlogscherm | je zit nog op `http://`, terwijl `COOKIE_SECURE=true` staat. Eerst stap 7 doen. |

# Stap 7: HTTPS

```bash
certbot --nginx -d monitor.coenvink.com
```

Certbot past het nginx-bestand zelf aan en zet de doorverwijzing van HTTP naar HTTPS. Daarna
kun je inloggen op `https://monitor.coenvink.com`.

# Stap 8: VPS-overzicht bijwerken

Zet het project in de tabel "Wat al draait" van de VPS-handleiding:

| Project | Soort | Domein | Map | Poort / pool |
| --- | --- | --- | --- | --- |
| Servermonitor | Node (eigen runtime) | `monitor.coenvink.com` | `/var/www/monitor` | `127.0.0.1:3001` |

---

# Nieuwe versies uitrollen

In de repository staat `deploy.sh`. Zet eenmalig de uitvoerrechten:

```bash
chmod +x /var/www/monitor/deploy.sh
```

Daarna is uitrollen:

```bash
/var/www/monitor/deploy.sh
```

Het script haalt de nieuwste code op, installeert de packages en herstart de service. Bij het
stoppen schrijft de monitor zijn historie eerst weg, dus je verliest hooguit de minuut die
nog bezig was. De grafiek laat op die plek een kleine onderbreking zien.

# Projecten volgen

De monitor kan per project laten zien:
- CPU en RAM;
- verzoeken per minuut en 5xx-fouten;
- of het domein bereikbaar is;
- hoe lang het certificaat nog geldig is;
- hoeveel schijfruimte het project inneemt;
- de laatst uitgerolde commit.

Welke projecten er zijn, staat in `/var/www/monitor/projects.json`. Dat bestand staat niet in git.
Je maakt het eenmalig op de server aan, zodat een `git pull` het nooit overschrijft.

## Gegevens opzoeken

Zoek per project drie dingen op:

```bash
ls /var/log/nginx/                          # naam van de access-log per project
ps -eo cmd | grep "php-fpm: pool" | sort -u # namen van de PHP-FPM-pools
systemctl list-units --type=service | grep -v '@'   # namen van eigen services (Node e.d.)
```

## Het bestand aanmaken

```bash
cp /var/www/monitor/projects.example.json /var/www/monitor/projects.json
nano /var/www/monitor/projects.json
```

```json
[
  {
    "name": "upmanager",
    "label": "Auto Reserveerapp-API",
    "type": "laravel",
    "domain": "autoapp.coenvink.com",
    "dir": "/var/www/upmanager-api",
    "pool": "upmanager",
    "accessLog": "/var/log/nginx/upmanager.access.log"
  },
  {
    "name": "monitor",
    "label": "Servermonitor",
    "type": "node",
    "domain": "monitor.coenvink.com",
    "dir": "/var/www/monitor",
    "services": ["monitor"],
    "accessLog": "/var/log/nginx/monitor.access.log"
  }
]
```

| Veld | Betekenis |
| --- | --- |
| `name` | Korte naam: alleen letters, cijfers, `-` en `_`. De historie wordt onder deze naam bewaard. Verander hem dus niet. |
| `label` | De naam in het dashboard |
| `type` | `laravel`, `php`, `node` of `static`. Dit is alleen een label. Wat er gemeten wordt, hangt af van de velden hieronder. |
| `domain` | Voor de bereikbaarheidscheck (elke minuut) en de certificaatcheck (elke 6 uur) |
| `dir` | Voor de schijfruimte (elk uur) en de laatste commit (elke 5 minuten) |
| `pool` | Naam van de PHP-FPM-pool: CPU en RAM van de PHP-processen |
| `services` | Systemd-services van het project, zoals een Node-app of een Laravel-queueworker: CPU en RAM |
| `accessLog` | Standaard `/var/log/nginx/<name>.access.log`. Vul het in als de naam afwijkt. |

Laat een veld weg als het niet van toepassing is. Een statische site heeft bijvoorbeeld geen
`pool` en geen `services`. De kleuren in de grafieken volgen de volgorde in dit bestand.

Zet daarna de rechten goed en herstart:

```bash
chmod 644 /var/www/monitor/projects.json
systemctl restart monitor
journalctl -u monitor -n 20 --no-pager      # meldt een fout in projects.json
```

Na een wijziging in `projects.json` is altijd een `systemctl restart monitor` nodig.

## Controleren of de monitor overal bij kan

Draai de controles als `www-data`, de gebruiker waaronder de monitor draait:

```bash
sudo -u www-data head -n 1 /var/log/nginx/upmanager.access.log
sudo -u www-data cat /sys/fs/cgroup/system.slice/monitor.service/memory.stat | head -n 2
```

Geven beide uitvoer, dan werkt het. Toont het dashboard een streepje (–) bij de verzoeken,
dan kan `www-data` die log niet lezen, of klopt het pad in `accessLog` niet. Een streepje bij
CPU en RAM betekent dat de pool- of servicenaam niet klopt.

## Wat de cijfers betekenen

* **CPU** is een percentage van de hele server, net als in de servergrafiek. `1%` op een VPS
  met 4 cores is dus 4% van één core.
* **RAM** is het eigen geheugen van het project. Voor PHP is dat per worker het RSS-geheugen
  min het gedeelde deel. Opcache en gedeelde bibliotheken tellen dus niet mee, anders zouden
  ze per worker dubbel worden geteld.
* **PHP met `pm = ondemand`**: workers bestaan alleen als er verzoeken zijn. Bij een idle
  project zie je dus 0 MB en 0%. Een worker die tussen twee metingen (5 seconden) start en weer
  stopt, telt niet mee. De CPU van PHP is daarom een ondergrens.
* **Verzoeken** zijn alle regels in de nginx-log, dus ook plaatjes, CSS en bots.
* **Bereikbaar** betekent dat het domein met een statuscode onder de 500 antwoordt. Een 404 op
  de hoofdpagina van een API is dus gewoon "Online".

# Wat de monitor meet

De monitor meet de hele VPS, niet alleen zijn eigen proces: de CPU van alle projecten samen,
al het RAM-gebruik, en de schijf die in `DISK_PATH` staat (standaard `/`). `www-data` mag
`/proc` lezen, dus daar zijn geen extra rechten voor nodig.

Zelf gebruikt de monitor weinig: ongeveer 50–70 MB RAM, en de historie in `data/` blijft bij
30 dagen rond de 3 MB.

# Problemen zoeken

```bash
systemctl status monitor
journalctl -u monitor -n 50 --no-pager      # uitvoer en fouten van de app
tail -f /var/log/nginx/monitor.error.log
ls -la /var/www/monitor/data                # moet van www-data zijn
```

**`Kon historie niet opslaan: EACCES`** in de journal: `data/` is niet van `www-data`, of er
staat een bestand in dat root heeft aangemaakt, bijvoorbeeld omdat je `npm start` als root
hebt gedraaid. Herstellen:

```bash
chown -R www-data:www-data /var/www/monitor/data
systemctl restart monitor
```

Start de app daarom nooit met de hand als root. Moet je hem los testen, gebruik dan
`sudo -u www-data node src/server.js`, en stop eerst de service.

**Een wijziging in `.env` doet niets.** De app leest `.env` alleen bij het opstarten. Doe
`systemctl restart monitor`.

**Wachtwoord vergeten.** Het staat in `/var/www/monitor/.env`. Pas het daar aan en herstart
de service. Alle bestaande sessies blijven geldig, tenzij je ook `SESSION_SECRET` verandert.
