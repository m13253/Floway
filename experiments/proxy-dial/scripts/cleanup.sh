#!/usr/bin/env bash
# Cleanup script for the proxy-dial experiment infrastructure.
# Restores both servers to their pre-experiment state.
set -u

JP_HOST=${JP_HOST:-23.145.36.136}

echo "==SING-BOX CONFIG=="
ssh -o BatchMode=yes root@${JP_HOST} '
  set -e
  if compgen -G "/etc/sing-box/config.json.bak.*" > /dev/null; then
    LATEST=$(ls -t /etc/sing-box/config.json.bak.* | head -1)
    echo "Restoring sing-box config from $LATEST"
    cp "$LATEST" /etc/sing-box/config.json
    systemctl restart sing-box
    sleep 1
    systemctl status sing-box --no-pager | head -8
  else
    echo "No sing-box config backup found; skipping"
  fi
'

echo
echo "==NGINX SITE=="
ssh -o BatchMode=yes root@${JP_HOST} '
  rm -f /etc/nginx/sites-enabled/proxy-test /etc/nginx/sites-available/proxy-test
  if [ -f /etc/nginx/sites-available/default ]; then
    ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
  fi
  nginx -t && systemctl reload nginx
'

echo
echo "==UPSTREAM SERVICE=="
ssh -o BatchMode=yes root@${JP_HOST} '
  systemctl disable --now upstream-test 2>/dev/null || true
  rm -f /etc/systemd/system/upstream-test.service
  systemctl daemon-reload
  rm -rf /opt/proxy-test
  rm -rf /var/www/proxy-test
'

echo
echo "==LE CERT=="
ssh -o BatchMode=yes root@${JP_HOST} '
  if [ -d ~/.acme.sh/23.145.36.136.sslip.io_ecc ]; then
    ~/.acme.sh/acme.sh --revoke --revoke-reason 5 -d 23.145.36.136.sslip.io --ecc 2>&1 | tail -3 || true
    ~/.acme.sh/acme.sh --remove -d 23.145.36.136.sslip.io --ecc 2>&1 | tail -3 || true
    rm -rf ~/.acme.sh/23.145.36.136.sslip.io_ecc
  fi
  rm -rf /etc/proxy-test
'

echo
echo "==NGINX OPTIONAL UNINSTALL=="
echo "(left nginx installed; remove with: ssh root@${JP_HOST} apt-get remove -y nginx)"

echo
echo "==WORKER=="
echo "(test worker is at https://proxy-dial-test.menci.workers.dev — delete with: pnpm wrangler delete --name proxy-dial-test)"

echo
echo "Cleanup done."
