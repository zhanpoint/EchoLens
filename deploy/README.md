# EchoLens Deployment

The production topology is:

```text
https://echolens.dreamlog.xyz
-> Nginx :80/:443
-> http://127.0.0.1:3000
-> EchoLens container
```

The container is intentionally bound to `127.0.0.1:3000` only. External traffic should go through Nginx on `80/443`.

## GitHub Actions

Set these `production` environment secrets in GitHub:

- `SSH_HOST`
- `SSH_USER`
- `SSH_PORT`
- `DEPLOY_PATH`
- `APP_PORT`
- `SSH_PRIVATE_KEY`
- `SSH_KNOWN_HOSTS`
- `GHCR_USERNAME`
- `GHCR_TOKEN`

Recommended values for this server:

```text
SSH_HOST=47.82.79.170
SSH_USER=deploy
SSH_PORT=22
DEPLOY_PATH=/opt/echolens
APP_PORT=3000
```

## Server Runtime Env

Create `/opt/echolens/.env` on the server and keep production variables there.

## Nginx

Install Nginx:

```bash
apt-get update
apt-get install -y nginx
```

Upload [nginx.echolens.conf](/D:/python%20project/EchoLens/deploy/nginx.echolens.conf) to the server as `/etc/nginx/sites-available/echolens.conf`, then enable it:

```bash
ln -sf /etc/nginx/sites-available/echolens.conf /etc/nginx/sites-enabled/echolens.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

Open firewall ports `80` and `443`. Port `3000` no longer needs public access once Nginx is in front.

## HTTPS

After the DNS `A` record for `echolens.dreamlog.xyz` points to `47.82.79.170`, issue a certificate:

```bash
snap install core
snap refresh core
snap install --classic certbot
ln -sf /snap/bin/certbot /usr/bin/certbot
certbot --nginx -d echolens.dreamlog.xyz
```

Once that succeeds, the service should be accessed at:

```text
https://echolens.dreamlog.xyz
```
