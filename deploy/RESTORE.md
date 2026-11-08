# Восстановление из бэкапа Hestia

В архиве пользователя Hestia раздел User Directories содержит `.finance-backup`.
Внутри — `finance-latest.tar`: дамп PostgreSQL, серверный `.env`, Git-bundle,
ревизии исходников и работающего приложения, контрольные суммы и эта инструкция.
Пакет содержит пароли и данные книг. Держите его вне веб-каталогов.

## Проверка пакета

Восстановите только `.finance-backup` через Hestia или извлеките его из архива.
Не восстанавливайте всего пользователя поверх работающего сервера ради одного
приложения: у него могут быть другие сайты.

Команды ниже выполняются от root в одной shell-сессии. Замените `financeuser`
именем пользователя, из чьего архива получен пакет.

```sh
umask 077
hestia_user=financeuser
work=$(mktemp -d)
tar -xf "/home/$hestia_user/.finance-backup/finance-latest.tar" -C "$work"
cd "$work"
sha256sum -c SHA256SUMS
```

Все проверки должны завершиться с `OK`. Для проверки дампа без запуска приложения:
`pg_restore --list "$work/database.dump" > /dev/null` — нужен PostgreSQL 17 или новее.

## Восстановление на новом сервере

Нужны Git, Docker и Compose. Команды рассчитаны на новый `/opt/finance` и пустую БД.
Если приложение уже работает, сначала сохраните его отдельную копию. Этот сценарий
не объединяет книги и не подходит для импорта в существующую БД.

Проверьте, что имя проекта `finance`, сети, тома и порт из `.env` не заняты другой
установкой. При необходимости поправьте `.env` до запуска контейнеров.

```sh
git clone "$work/project.bundle" /opt/finance
cd /opt/finance
chmod 700 /opt/finance
git checkout --detach "$(cat "$work/runtime-revision")"
install -m 600 "$work/environment" .env
docker compose build api
docker compose up -d --wait db redis
docker compose exec -T db pg_restore -U finance -d finance --exit-on-error < "$work/database.dump"
docker compose up -d --no-build --wait api
docker compose exec -T api /finance healthcheck
```

Образ собирается из ревизии, записанной вместе с дампом. Не запускайте API до
восстановления БД: иначе он создаст таблицы в пустой базе.
Redis запускается пустым: пользователи и история хранятся в PostgreSQL,
а счетчики попыток и расходов AI сбросятся.

## Домен и новые бэкапы

Восстановите домен через Hestia. Если шаблона приложения нет, установите отдельный
шаблон из `deploy/hestia/finance.tpl` и `.stpl`, заменив `__FINANCE_PORT__` портом
из `.env`. Назначьте его только этому домену, проверьте `nginx -t`, выполните reload.
Подробности — в [DEPLOYMENT.md](../DEPLOYMENT.md).

`revision` может быть новее `runtime-revision`: скрипты бэкапа и документацию можно
обновлять без пересборки API. Верните эти файлы перед установкой службы.
В исключения User Directories пользователя Hestia добавьте только
`.finance-backup/.incoming`, сохранив остальные правила. Сам `.finance-backup`
и весь раздел User Directories исключать нельзя.

```sh
git checkout --detach "$(cat "$work/revision")"
install -d -m 700 /opt/finance/backups
install -d -m 700 "/home/$hestia_user/.finance-backup"
install -d -m 755 /etc/systemd/system/finance-backup.service.d
install -m 644 deploy/finance-backup.service deploy/finance-backup.timer /etc/systemd/system/
sed "s/__HESTIA_USER__/$hestia_user/g" deploy/finance-backup-hestia.conf > /etc/systemd/system/finance-backup.service.d/hestia.conf
chmod 644 /etc/systemd/system/finance-backup.service.d/hestia.conf
systemctl daemon-reload
systemctl enable --now finance-backup.timer
systemctl start finance-backup.service
```

Для `/opt/finance/backups` нужен отдельный шаг: каталог отсутствует в Git,
а systemd проверяет `ReadWritePaths` до запуска скрипта.
Проверьте вход по личному ключу, книги, внешний HTTPS-адрес и состав следующего
архива Hestia. До окончания проверки исходный архив не удаляйте.

# Restore from a Hestia backup

The Hestia user's User Directories archive contains `.finance-backup/finance-latest.tar`:
a PostgreSQL dump, server `.env`, Git bundle, source and runtime revisions, checksums
and this guide. The package contains secrets and book data; keep it out of web roots.
A server backup does not include changes still unsent from phones.

Restore only `.finance-backup` through Hestia or extract it from the archive. Do not
restore the entire user over a working server merely to recover this application.
Run the following as root in one shell session, replacing `financeuser` with the
Hestia user. PostgreSQL 17 or newer is needed for the optional dump inspection.

```sh
umask 077
hestia_user=financeuser
work=$(mktemp -d)
tar -xf "/home/$hestia_user/.finance-backup/finance-latest.tar" -C "$work"
cd "$work"
sha256sum -c SHA256SUMS
pg_restore --list "$work/database.dump" > /dev/null
```

All checksum checks must report `OK`. The steps below require Git, Docker, Compose,
a new `/opt/finance` and an empty database. They do not merge books. If an app is
already running, save it separately first. Ensure that the `finance` project name,
networks, volumes and port in `.env` do not conflict with another installation.

```sh
git clone "$work/project.bundle" /opt/finance
cd /opt/finance
chmod 700 /opt/finance
git checkout --detach "$(cat "$work/runtime-revision")"
install -m 600 "$work/environment" .env
docker compose build api
docker compose up -d --wait db redis
docker compose exec -T db pg_restore -U finance -d finance --exit-on-error < "$work/database.dump"
docker compose up -d --no-build --wait api
docker compose exec -T api /finance healthcheck
```

Do not start the API before restoring the database. Redis starts empty, so rate and
AI budget counters reset. Restore the domain and TLS in Hestia; if necessary, install
`deploy/hestia/finance.tpl` and `.stpl`, replacing `__FINANCE_PORT__`, assign the
templates only to this domain, test with `nginx -t` and reload.

`revision` can be newer than `runtime-revision`; restore the former before setting
up future backups. Add only `.finance-backup/.incoming` to the Hestia user's User
Directories exclusions, retaining the other rules. Do not exclude `.finance-backup`
or all User Directories.

```sh
git checkout --detach "$(cat "$work/revision")"
install -d -m 700 /opt/finance/backups
install -d -m 700 "/home/$hestia_user/.finance-backup"
install -d -m 755 /etc/systemd/system/finance-backup.service.d
install -m 644 deploy/finance-backup.service deploy/finance-backup.timer /etc/systemd/system/
sed "s/__HESTIA_USER__/$hestia_user/g" deploy/finance-backup-hestia.conf > /etc/systemd/system/finance-backup.service.d/hestia.conf
chmod 644 /etc/systemd/system/finance-backup.service.d/hestia.conf
systemctl daemon-reload
systemctl enable --now finance-backup.timer
systemctl start finance-backup.service
```

Check recovery-key sign-in, books, external HTTPS and the next Hestia archive. Keep
the original archive until recovery has been verified.
