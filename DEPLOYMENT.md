# Развёртывание

[English](DEPLOYMENT.en.md) · [На главную](README.md)

Для локального запуска достаточно Docker Compose и `.env` по инструкции в README.
Для сервера нужны Linux, Git, Docker Compose, домен и доверенный HTTPS. Не храните
`.env`, резервные копии и пакеты релизов в публичном репозитории или веб-каталоге.

## Настройка

Скопируйте `.env.example` в `.env`, установите права `chmod 600 .env`. Задайте
разные случайные `APP_SECRET` (не менее 32 символов), `POSTGRES_PASSWORD` и
`REGISTRATION_PASSWORD`. Сохраните их отдельно. Смена пароля в `.env` не меняет
пароль уже созданной PostgreSQL: его нужно изменить согласованно.

`API_PORT` по умолчанию 18080 и привязан к loopback. Для помощника задайте
`OPENROUTER_API_KEY`; без него ручной учёт работает. Модель задаётся через
`OPENROUTER_MODEL`, дневной бюджет — `AI_DAILY_BUDGET_USD`. Не задавайте
`APP_IMAGE` и `APP_VERSION` вручную при использовании скриптов обновления.

Для Nginx на хосте, включая Hestia, задайте в `.env`:

```dotenv
COMPOSE_FILE=compose.yaml:deploy/compose.hestia.yaml
PUBLIC_URL=https://finance.example.org
API_PORT=18080
```

Настройте DNS и TLS, направьте отдельный домен на `127.0.0.1:18080`, передавая
`Host`, `X-Forwarded-Proto` и `X-Forwarded-For`. Шаблоны Hestia находятся в
`deploy/hestia/`: замените `__FINANCE_PORT__`, установите шаблоны для отдельного
домена, проверьте `nginx -t` и перезагрузите Nginx. Override включает secure cookies
и доверие proxy; не открывайте API напрямую во внешнюю сеть.

Для proxy в Docker доступен `deploy/compose.production.yaml` с `PROXY_NETWORK`.
Используйте отдельную сеть для proxy и Finance: alias `api` в общей сети может
совпасть с alias другого приложения.

## Обновление

Для серверного развёртывания из чистого Git checkout используйте:

```sh
sh scripts/update.sh
docker compose exec -T api /finance healthcheck
```

Скрипт собирает образ, сохраняет проверенный дамп PostgreSQL, применяет миграции
и проверяет запуск. Просмотрите `docker compose logs api` и проверьте внешний HTTPS,
вход и синхронизацию. На Windows скрипт `scripts/Deploy.ps1 -Server user@host`
собирает релиз и передаёт его по SSH существующей установке; сервер указывается
явно, а обе копии должны иметь общую Git-историю.

`Build-Release.ps1` включает `git bundle --all` со всеми локальными refs и историей.
Не публикуйте его архив без отдельной проверки. Чистая публичная история не может
обновить старый checkout через fast-forward; перенос установки требует отдельного плана.

После появления валютных данных старый клиент или старая копия приложения может
не понимать книгу. Не откатывайтесь к нему: используйте только совместимую версию.
Перед обновлением сохраните открытые формы и закончите запись голоса; не очищайте
данные браузера для принудительного обновления.

## Резервные копии

После развёртывания через `scripts/update.sh` создайте проверяемый серверный снимок:

```sh
sh scripts/backup.sh
```

Скрипт сохраняет дамп, `.env`, ревизии и контрольные суммы в `backups/`. Эти файлы
содержат личные данные и секреты; храните копию вне сервера и проверяйте восстановление.
Скрипту необходима Git-ревизия запущенного образа, поэтому образ, собранный простым
`docker compose up --build`, сначала нужно развернуть через `update.sh`. Redis не
копируется; счётчики ограничений сбросятся. Неотправленные данные телефонов в
серверную копию не входят: синхронизируйте устройства или скачайте JSON на каждом.

Для ежедневной копии на установке в `/opt/finance`:

```sh
install -d -m 700 /opt/finance/backups
install -m 644 deploy/finance-backup.service deploy/finance-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now finance-backup.timer
systemctl start finance-backup.service
```

Проверьте `systemctl status finance-backup.service` и наличие внешней копии.
Порядок восстановления и настройки Hestia описан в [deploy/RESTORE.md](deploy/RESTORE.md).
Для уже работающего сервера восстановление БД — отдельная операция: сначала сохраните
его текущее состояние, не заменяйте данные без проверки выбранного дампа.
