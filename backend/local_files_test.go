package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnonymousXLSXConversionIsStateless(t *testing.T) {
	app := integrationApp(t)
	server := httptest.NewServer(app.routes())
	defer server.Close()
	client := testClient()
	state := initialState()
	entry := sampleEntry(state)
	entry.Time = "00:00"
	state.Entries = []Entry{entry}
	request, _ := http.NewRequest("POST", server.URL+"/api/local-files/export", bytes.NewReader(jsonBytes(state)))
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || len(response.Cookies()) != 0 {
		t.Fatalf("anonymous export: %d %s", response.StatusCode, data)
	}
	var form bytes.Buffer
	writer := multipart.NewWriter(&form)
	catalogs := state
	catalogs.Entries = nil
	writer.WriteField("state", string(jsonBytes(catalogs)))
	file, _ := writer.CreateFormFile("file", "sample.xlsx")
	file.Write(data)
	writer.Close()
	request, _ = http.NewRequest("POST", server.URL+"/api/local-files/preview", &form)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var proposal ImportProposal
	if response.StatusCode != 200 {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("preview %d %s", response.StatusCode, raw)
	}
	if err = json.NewDecoder(response.Body).Decode(&proposal); err != nil {
		t.Fatal(err)
	}
	if len(proposal.FileHash) != 64 || len(proposal.Entries) != 1 || proposal.Entries[0].Time != "00:00" || len(proposal.Errors) > 0 {
		t.Fatalf("invalid preview: %+v", proposal)
	}
	state.Entries[0].Amount = "-1.00"
	call(t, client, "POST", server.URL+"/api/local-files/export", state, 400)
	call(t, client, "POST", server.URL+"/api/local-files/export", map[string]any{"bookId": newID()}, 400)
	call(t, client, "GET", server.URL+"/api/books/"+newID()+"/export", nil, 401)
	var rows int
	if err = app.db.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM books)+(SELECT count(*) FROM imports)").Scan(&rows); err != nil || rows != 0 {
		t.Fatal("conversion persisted personal data", rows, err)
	}
}

func TestLocalExportDecompressionIsBounded(t *testing.T) {
	for _, test := range []struct {
		name, encoding string
		data           []byte
	}{
		{"gzip", "gzip", nil},
		{"plain", "", nil},
		{"invalid gzip", "gzip", []byte("broken")},
		{"truncated gzip", "gzip", []byte{0x1f, 0x8b}},
		{"unsupported", "br", []byte("broken")},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := test.data
			if data == nil {
				data = jsonBytes(initialState())
				if test.encoding == "gzip" {
					var compressed bytes.Buffer
					writer := gzip.NewWriter(&compressed)
					writer.Write(data)
					writer.Close()
					data = compressed.Bytes()
				}
			}
			request := httptest.NewRequest("POST", "/api/local-files/export", bytes.NewReader(data))
			request.Header.Set("Content-Encoding", test.encoding)
			var state State
			err := localExportState(request, &state)
			valid := test.name == "plain" || test.name == "gzip"
			if (err == nil) != valid {
				t.Fatal("unexpected decode result", err)
			}
		})
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	block := strings.Repeat("a", 1<<20)
	for range 65 {
		io.WriteString(writer, block)
	}
	writer.Close()
	request := httptest.NewRequest("POST", "/api/local-files/export", &compressed)
	request.Header.Set("Content-Encoding", "gzip")
	var state State
	err := localExportState(request, &state)
	if response, ok := err.(apiError); !ok || response.status != 413 {
		t.Fatal("uncompressed size was not limited", err)
	}
}

func TestLargeLocalBookExportsThroughGzip(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	state := initialState()
	for range 3000 {
		entry := sampleEntry(state)
		entry.Note = strings.Repeat("x", 4096)
		state.Entries = append(state.Entries, entry)
	}
	plain := jsonBytes(state)
	if len(plain) <= 12<<20 {
		t.Fatal("fixture does not cross HTTP body limit", len(plain))
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	writer.Write(plain)
	writer.Close()
	request, _ := http.NewRequest("POST", server.URL+"/api/local-files/export", &compressed)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Content-Encoding", "gzip")
	response, err := testClient().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	file, err := io.ReadAll(response.Body)
	if response.StatusCode != 200 || err != nil {
		t.Fatal("compressed export failed", response.StatusCode, err)
	}
	proposal, err := parseXLSX(file, initialState())
	if err != nil || len(proposal.Errors) != 0 || len(proposal.Entries) != len(state.Entries) || proposal.Entries[0].Note != state.Entries[0].Note {
		t.Fatal("large book did not round trip", len(proposal.Entries), proposal.Errors, err)
	}
}
