package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestImportRequiresCurrentPreviewAndRefreshesCachedFile(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, _, _ := registerClient(t, server.URL, "Owner")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Import"}, 200)
	member, memberID, _ := registerClient(t, server.URL, "Member")
	invite := call(t, client, "POST", server.URL+"/api/books/"+book+"/invite", map[string]any{}, 200)
	call(t, member, "POST", server.URL+"/api/join", map[string]string{"code": stringField(invite, "code")}, 200)
	source := initialState()
	entry := sampleEntry(source)
	source.Entries = []Entry{entry}
	file, err := writeXLSX(source)
	if err != nil {
		t.Fatal(err)
	}
	preview := func() ImportProposal {
		t.Helper()
		response, err := client.Post(server.URL+"/api/books/"+book+"/import", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes.NewReader(file))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var proposal ImportProposal
		if response.StatusCode != 200 || json.NewDecoder(response.Body).Decode(&proposal) != nil {
			t.Fatal("preview failed", response.StatusCode)
		}
		return proposal
	}
	first := preview()
	if first.Revision == nil || len(first.Duplicates) != 0 {
		t.Fatal("initial preview", first)
	}
	if cached := preview(); cached.ID != first.ID {
		t.Fatal("unchanged preview was not reused")
	}
	// Pending previews from older releases must be regenerated before confirmation.
	if _, err := a.db.Exec(context.Background(), `UPDATE imports SET proposal=proposal-'revision' WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	confirm := server.URL + "/api/books/" + book + "/import/"
	call(t, client, "POST", confirm+first.ID, map[string]any{"includeDuplicates": []string{}}, 409)
	current := preview()
	if current.Revision == nil || current.ID == first.ID {
		t.Fatal("legacy preview was not refreshed")
	}
	if _, err := a.applyCommands(context.Background(), memberID, book, []Command{{ID: newID(), Entity: "entry", Data: jsonBytes(entry)}}); err != nil {
		t.Fatal(err)
	}
	call(t, client, "POST", confirm+current.ID, map[string]any{"includeDuplicates": []string{}}, 409)
	updated := preview()
	if len(updated.Duplicates) != 1 || updated.Revision == nil || *updated.Revision <= *current.Revision {
		t.Fatal("stale duplicates were not refreshed", updated)
	}
	call(t, client, "POST", confirm+updated.ID, map[string]any{"includeDuplicates": []string{}}, 200)
	call(t, client, "POST", confirm+updated.ID, map[string]any{"includeDuplicates": []string{}}, 200)
	snapshot, err := a.snapshot(context.Background(), memberID, book)
	if err != nil || len(snapshot.State.Entries) != 1 {
		t.Fatal("import duplicated the concurrent operation", snapshot, err)
	}
	if applied := preview(); !applied.Applied {
		t.Fatal("completed file was offered again")
	}
}

func TestConcurrentImportPreviewsShareOneFileRecord(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, _, _ := registerClient(t, server.URL, "Preview")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Import"}, 200)
	source := initialState()
	source.Entries = []Entry{sampleEntry(source)}
	file, err := writeXLSX(source)
	if err != nil {
		t.Fatal(err)
	}
	statuses := make([]int, 2)
	var done sync.WaitGroup
	for i := range statuses {
		done.Add(1)
		go func(i int) {
			defer done.Done()
			response, err := client.Post(server.URL+"/api/books/"+book+"/import", "application/octet-stream", bytes.NewReader(file))
			if err == nil {
				io.Copy(io.Discard, response.Body)
				response.Body.Close()
				statuses[i] = response.StatusCode
			}
		}(i)
	}
	done.Wait()
	for _, status := range statuses {
		if status != http.StatusOK {
			t.Fatal("concurrent preview failed", statuses)
		}
	}
	var count int
	if err := a.db.QueryRow(context.Background(), `SELECT count(*) FROM imports WHERE book_id=$1`, book).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate file records", count, err)
	}
}
