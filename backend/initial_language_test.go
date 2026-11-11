package main

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestBookCreationLanguageDoesNotRenameExistingBooksOrAllowOutsiders(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	owner, _, _ := registerClient(t, server.URL, "Owner")
	outsider, _, _ := registerClient(t, server.URL, "Outsider")
	for _, tc := range []struct{ language, account, category string }{{"", "Основной", "Продукты"}, {"en", "Main", "Groceries"}} {
		id := newID()
		input := map[string]string{"id": id, "name": "Test book"}
		if tc.language != "" {
			input["language"] = tc.language
		}
		call(t, owner, "POST", server.URL+"/api/books", input, 200)
		input["language"] = "ru"
		call(t, owner, "POST", server.URL+"/api/books", input, 200)
		call(t, outsider, "POST", server.URL+"/api/books", input, 403)
		response := call(t, owner, "GET", server.URL+"/api/books/"+id+"/sync", nil, 200)
		var state State
		if err := json.Unmarshal(response["state"], &state); err != nil {
			t.Fatal(err)
		}
		if len(state.Accounts) != 1 || len(state.Categories) != 16 || state.Accounts[0].Name != tc.account || state.Categories[0].Name != tc.category {
			t.Fatalf("book was renamed or initialized in the wrong language: %+v", state)
		}
	}
	call(t, owner, "POST", server.URL+"/api/books", map[string]string{"id": newID(), "name": "Invalid language", "language": "fr"}, 400)
}

func TestInitialStateLanguageDoesNotChangeIDsOrLegacyDefaults(t *testing.T) {
	legacy, ru, en := initialState(), initialStateForLanguage("ru"), initialStateForLanguage("en")
	if legacy.Accounts[0].Name != "Основной" || ru.Categories[0].Name != "Продукты" || en.Accounts[0].Name != "Main" || en.Categories[0].Name != "Groceries" {
		t.Fatal("wrong initial language")
	}
	if legacy.Accounts[0].ID != en.Accounts[0].ID || len(legacy.Categories) != len(en.Categories) {
		t.Fatal("language changed catalog identity")
	}
	for i := range legacy.Categories {
		if legacy.Categories[i].ID != en.Categories[i].ID || legacy.Categories[i].Kind != en.Categories[i].Kind {
			t.Fatalf("language changed category identity %d", i)
		}
	}
}
