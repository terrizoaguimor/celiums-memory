# Custom domain — replacing the trycloudflare URL

By default, a 1-Click Celiums Memory droplet exposes the dashboard at a random
`*.trycloudflare.com` URL minted by Cloudflare's quick-tunnel. The URL
**changes every time the `celiums-tunnel` daemon restarts** — fine for kicking
the tires, painful for production.

This guide swaps the quick-tunnel out for a stable URL. Pick the path that
matches what you already have:

- **You have a Cloudflare account + a domain** → [Path A: Named Cloudflare
  tunnel](#path-a-named-cloudflare-tunnel) (free, no port forwarding, easiest).
- **You have a domain but no Cloudflare account** → [Path B: Caddy with
  Let's Encrypt](#path-b-caddy--lets-encrypt) (free, but you open ports
  80/443 on the droplet).
- **You bought a domain through DigitalOcean** → see [Path C: DO managed
  DNS](#path-c-digitalocean-managed-dns) — combine with Path A or B.

After every change, run `cat /root/.celiums/dashboard_url` to verify the
URL the dashboard exposes (the Public URL field on `/settings` reads from
that file).

---

## Path A: Named Cloudflare tunnel

A named tunnel lives across restarts. It survives reboots, the URL never
changes, and traffic still goes through the Cloudflare edge with TLS
auto-managed.

### 1. Install — already done on the droplet

`cloudflared` is preinstalled on every Celiums Memory snapshot. Confirm:

```bash
cloudflared --version
```

### 2. Authenticate (once, on the droplet)

```bash
cloudflared tunnel login
```

Follow the URL it prints, log in to Cloudflare, pick the domain you want
to use. The certificate is saved to `/root/.cloudflared/cert.pem`.

### 3. Create the tunnel

Pick any name — it shows up in your Cloudflare Zero Trust dashboard.

```bash
TUNNEL_NAME=celiums-memory
cloudflared tunnel create $TUNNEL_NAME
```

The credentials file lands at `/root/.cloudflared/<UUID>.json`. Copy that
UUID — you'll need it next.

### 4. Route a hostname

```bash
HOSTNAME=memory.your-domain.com
cloudflared tunnel route dns $TUNNEL_NAME $HOSTNAME
```

Cloudflare creates the CNAME automatically.

### 5. Write the named-tunnel config

```bash
sudo tee /etc/cloudflared/config.yml <<EOF
tunnel: $TUNNEL_NAME
credentials-file: /root/.cloudflared/<UUID>.json

ingress:
  - hostname: $HOSTNAME
    service: http://127.0.0.1:8080
  - service: http_status:404
EOF
```

### 6. Swap the systemd unit

```bash
sudo systemctl stop celiums-tunnel.service
sudo systemctl disable celiums-tunnel.service

# Persist the URL the redirect service hands out.
echo "https://$HOSTNAME" | sudo tee /root/.celiums/dashboard_url

# Run cloudflared in named-tunnel mode under its own service.
sudo tee /etc/systemd/system/celiums-named-tunnel.service <<EOF
[Unit]
Description=Celiums named Cloudflare tunnel
After=network-online.target celiums-proxy.service
Requires=celiums-proxy.service

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --config /etc/cloudflared/config.yml run
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now celiums-named-tunnel.service
```

Test:

```bash
curl -I https://$HOSTNAME/health  # → 200 OK + JSON
```

---

## Path B: Caddy + Let's Encrypt

This route ditches Cloudflare entirely. Caddy serves TLS directly,
Let's Encrypt issues the certificate via HTTP-01.

### Prerequisites

- A domain with an A record pointing at the droplet's public IP.
- Ports 80 and 443 reachable (DO firewall by default allows this — verify
  with `doctl compute firewall list`).

### 1. Stop the tunnel + redirect

```bash
sudo systemctl stop celiums-tunnel.service celiums-redirect.service
sudo systemctl disable celiums-tunnel.service celiums-redirect.service
```

The redirect service binds to port 80; Caddy needs that port for the ACME
challenge.

### 2. Replace the Caddyfile

```bash
HOSTNAME=memory.your-domain.com
EMAIL=you@your-domain.com

sudo tee /etc/celiums/Caddyfile <<EOF
{
  email $EMAIL
}

$HOSTNAME {
  handle /v1/* { reverse_proxy 127.0.0.1:3210 }
  handle /mcp* { reverse_proxy 127.0.0.1:3210 }
  handle /oauth/* { reverse_proxy 127.0.0.1:3210 }
  handle /.well-known/* { reverse_proxy 127.0.0.1:3210 }
  handle /health { reverse_proxy 127.0.0.1:3210 }
  handle { reverse_proxy 127.0.0.1:5173 }
}
EOF
```

### 3. Update the proxy unit so Caddy can bind 80/443

The bundled `celiums-proxy.service` runs as the `celiums` user, which can't
bind privileged ports. Either:

- Grant the binary the cap: `sudo setcap 'cap_net_bind_service=+ep' $(which caddy)`, **or**
- Edit the unit to run as root.

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart celiums-proxy.service
echo "https://$HOSTNAME" | sudo tee /root/.celiums/dashboard_url
```

Caddy will request the certificate on first hit. Watch the journal:

```bash
sudo journalctl -u celiums-proxy.service -f
```

---

## Path C: DigitalOcean managed DNS

If your domain's nameservers point at DO (`ns1.digitalocean.com`,
`ns2…`, `ns3…`), the DO API can create the A or CNAME for you.

```bash
doctl compute domain records create your-domain.com \
  --record-type A \
  --record-name memory \
  --record-data $(curl -s ifconfig.me) \
  --record-ttl 3600
```

Then follow Path A or B with `memory.your-domain.com` as the hostname.

> **Coming in v1.3** — Celiums will provision per-droplet subdomains
> automatically against a DO-managed apex domain we own. If you'd rather
> wait, that flow needs zero config from you.

---

## Reverting

To go back to the trycloudflare URL:

```bash
sudo systemctl stop celiums-named-tunnel.service 2>/dev/null
sudo systemctl disable celiums-named-tunnel.service 2>/dev/null
sudo systemctl enable --now celiums-tunnel.service celiums-redirect.service
```

The next start mints a fresh `*.trycloudflare.com` URL — find it with
`journalctl -u celiums-tunnel.service | grep trycloudflare | tail -1`.
