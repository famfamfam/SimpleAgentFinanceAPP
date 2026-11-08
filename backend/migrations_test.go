package main

import (
	"context"
	"io/fs"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

func TestMigrationsPreserveLegacyDataAndRollbackFailures(t *testing.T) {
	a := integrationApp(t)
	ctx := context.Background()
	// Reproduce the pre-migration release: its tables exist, but there is no ledger.
	if _, err := a.db.Exec(ctx, `DROP TABLE chat_media,chat_messages,assistant_tasks,chat_heads,schema_migrations;
		INSERT INTO users(id,nickname,recovery_hash) VALUES('legacy','Owner','legacy-hash');
		INSERT INTO books(id,owner_id,name,state,revision) VALUES('legacy-book','legacy','Family','{"entries":[{"amount":"123.45"}]}',7);
		INSERT INTO mutations(book_id,id,user_id,request_hash,result) VALUES('legacy-book','pending','legacy','hash','{"ok":true}')`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, a.db, migrationFiles); err != nil {
		t.Fatal(err)
	}
	baseline, _ := fs.ReadFile(migrationFiles, "migrations/0001_initial.sql")
	chat, _ := fs.ReadFile(migrationFiles, "migrations/0002_chat.sql")
	next := fstest.MapFS{
		"migrations/0001_initial.sql": &fstest.MapFile{Data: baseline},
		"migrations/0002_chat.sql":    &fstest.MapFile{Data: chat},
		"migrations/0003_test.sql":    &fstest.MapFile{Data: []byte(`ALTER TABLE books ADD COLUMN migration_test text NOT NULL DEFAULT 'kept'`)},
		"migrations/0004_test.sql":    &fstest.MapFile{Data: []byte(`SELECT missing_function_for_migration_test()`)},
	}
	if err := migrate(ctx, a.db, next); err == nil {
		t.Fatal("broken SQL migration accepted")
	}
	var columnExists bool
	if err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='books' AND column_name='migration_test')`).Scan(&columnExists); err != nil || columnExists {
		t.Fatal("failed batch left schema changes", err)
	}
	next["migrations/0004_test.sql"].Data = []byte(`CREATE INDEX migration_test_idx ON books(migration_test)`)
	var group sync.WaitGroup
	for range 2 {
		group.Go(func() {
			if err := migrate(ctx, a.db, next); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	var revision, mutations, versions int
	var amount, added string
	if err := a.db.QueryRow(ctx, `SELECT revision,state->'entries'->0->>'amount',migration_test FROM books WHERE id='legacy-book'`).Scan(&revision, &amount, &added); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM mutations`).Scan(&mutations); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if revision != 7 || amount != "123.45" || added != "kept" || mutations != 1 || versions != 4 {
		t.Fatal("upgrade changed legacy data or replay history", revision, amount, added, mutations, versions)
	}
	if err := migrate(ctx, a.db, migrationFiles); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatal("older binary accepted a newer schema", err)
	}
	next["migrations/0001_initial.sql"].Data = append(append([]byte{}, baseline...), []byte("\n-- changed")...)
	if err := migrate(ctx, a.db, next); err == nil || !strings.Contains(err.Error(), "history changed") {
		t.Fatal("edited migration accepted", err)
	}
}

func TestVersionAndWorkerUseEmbeddedAssetDigest(t *testing.T) {
	a := &App{}
	response := httptest.NewRecorder()
	a.routes().ServeHTTP(response, httptest.NewRequest("GET", "/api/version", nil))
	if response.Code != 200 || !strings.Contains(response.Body.String(), assetVersion) || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("version metadata not available", response)
	}
	response = httptest.NewRecorder()
	a.routes().ServeHTTP(response, httptest.NewRequest("GET", "/sw.js", nil))
	if _, err := fs.Stat(assets, "react-web/dist/index.html"); err != nil {
		if response.Code != 503 || response.Header().Get("Cache-Control") != "no-cache" {
			t.Fatal("missing worker build must return 503", response)
		}
	} else if response.Code != 200 || !strings.Contains(response.Body.String(), "finance-"+assetVersion) || strings.Contains(response.Body.String(), "finance-dev") || response.Header().Get("Cache-Control") != "no-cache" {
		t.Fatal("worker version does not match embedded assets", response)
	}
}
