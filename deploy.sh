#!/bin/bash
set -e
cd /var/www/monitor

git pull origin main
npm ci --omit=dev
mkdir -p data
chown -R www-data:www-data data
systemctl restart monitor
systemctl --no-pager status monitor | head -5
