package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"fmt"
	"io/fs"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// All pending migrations and their ledger commit together; another instance waits.
func migrate(ctx context.Context, pool *pgxpool.Pool, source fs.FS) error {
	names, err := fs.Glob(source, "migrations/*.sql")
	if err != nil || len(names) == 0 {
		return fmt.Errorf("no migrations: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(81499001)`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
		applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	type applied struct{ name, checksum string }
	history := map[int]applied{}
	rows, err := tx.Query(ctx, `SELECT version,name,checksum FROM schema_migrations ORDER BY version`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var version int
		var item applied
		if err = rows.Scan(&version, &item.name, &item.checksum); err != nil {
			rows.Close()
			return err
		}
		history[version] = item
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for version := range history {
		if version < 1 || version > len(names) {
			return fmt.Errorf("database migration %d is unknown to this binary; use a compatible release", version)
		}
	}
	for index, name := range names {
		filename := strings.TrimPrefix(name, "migrations/")
		number, _, _ := strings.Cut(filename, "_")
		version, parseErr := strconv.Atoi(number)
		if parseErr != nil || len(number) != 4 || version != index+1 {
			return fmt.Errorf("migration names must be consecutive: %s", name)
		}
		content, readErr := fs.ReadFile(source, name)
		if readErr != nil {
			return readErr
		}
		checksum := fmt.Sprintf("%x", sha256.Sum256(content))
		if previous, ok := history[version]; ok {
			if previous.name != filename || previous.checksum != checksum || version > len(history) {
				return fmt.Errorf("migration history changed at %s; restore the original file", filename)
			}
			continue
		}
		if version <= len(history) {
			return fmt.Errorf("migration history has a gap at %d", version)
		}
		if _, err = tx.Exec(ctx, string(content)); err != nil {
			return fmt.Errorf("migration %s: %w", filename, err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)`, version, filename, checksum); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
