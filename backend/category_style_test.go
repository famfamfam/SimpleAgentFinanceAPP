package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"
)

func TestModelPayloadUsesQwenRouting(t *testing.T) {
	a := &App{model: "qwen/qwen3.8-omni-flash"}
	payload := a.modelPayload(nil, nil, 512)
	provider := payload["provider"].(map[string]any)
	if payload["model"] != a.model || provider["sort"] != "price" || provider["data_collection"] != "deny" || provider["require_parameters"] != true {
		t.Fatal("model routing lost required safeguards", payload)
	}
	if _, filtered := provider["quantizations"]; filtered {
		t.Fatal("a quantization filter excludes the selected provider")
	}
	if payload["reasoning"].(map[string]string)["effort"] != "medium" {
		t.Fatal("requested reasoning level was not applied")
	}
	price := provider["max_price"].(map[string]float64)
	if price["prompt"] < 0.15 || price["completion"] < 0.47 || price["prompt"] > 0.30 || price["completion"] > 1.70 {
		t.Fatal("invalid price cap for the selected model", price)
	}
}

func TestCategoryStyleValidatesCachesAndSharesBudget(t *testing.T) {
	a := integrationApp(t)
	a.openrouter = "mock"
	var calls atomic.Int32
	styles := []CategoryStyle{{"apple", "#123456"}, {"cake", "#654321"}, {"pizza", "#abcdef"}}
	var proposed atomic.Value
	proposed.Store(styles)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var payload map[string]any
		json.NewDecoder(r.Body).Decode(&payload)
		if payload["tool_choice"] != "auto" {
			t.Error("Qwen supports automatic tool selection only")
		}
		if bytes.Contains(jsonBytes(payload["tools"]), []byte(`"enum"`)) {
			t.Error("large catalog enums break Gemini's tool schema; validate returned IDs in the backend")
		}
		respond(w, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"tool_calls": []any{map[string]any{"function": map[string]any{"name": "suggest_category_styles", "arguments": string(jsonBytes(map[string]any{"suggestions": proposed.Load()}))}}}}}}, "usage": map[string]any{"cost": 0.0001}})
	}))
	defer provider.Close()
	t.Setenv("OPENROUTER_URL", provider.URL)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, user, _ := registerClient(t, server.URL, "Styles")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Styles"}, 200)
	var in CategoryStyleInput
	json.Unmarshal([]byte(`{"name":"Еда","kind":"expense","icons":[{"id":"apple","label":"Яблоко"},{"id":"cake","label":"Торт"},{"id":"pizza","label":"Пицца"}],"colors":["#123456","#654321","#abcdef"]}`), &in)
	in.ID = newID()
	url := server.URL + "/api/books/" + book + "/category-style"
	for _, key := range []string{"finance:ai-ip:127.0.0.1", "finance:ai-user:" + user, "finance:ai-global"} {
		if err := a.redis.Set(context.Background(), key, 10000, 0).Err(); err != nil {
			t.Fatal(err)
		}
	}
	call(t, client, "POST", url, in, 200)
	call(t, client, "POST", url, in, 200)
	if calls.Load() != 1 {
		t.Fatal("cached request called provider again")
	}
	in.Name = "Другой"
	call(t, client, "POST", url, in, 400)
	in.ID = newID()
	in.Exclude = styles
	second := call(t, client, "POST", url, in, 200)
	var suggestions []CategoryStyle
	if err := json.Unmarshal(second["suggestions"], &suggestions); err != nil || len(suggestions) != 3 {
		t.Fatal("missing replacement suggestions", err)
	}
	for i, style := range suggestions {
		if style.Icon != styles[i].Icon || !slices.Contains(in.Colors, style.Color) || slices.Contains(styles, style) || slices.Contains(suggestions[:i], style) {
			t.Fatal("repeated or unavailable replacement", suggestions)
		}
	}
	call(t, client, "POST", url, in, 200)
	if calls.Load() != 2 {
		t.Fatal("repeated styles should need one provider call and remain cached")
	}
	proposed.Store([]CategoryStyle{styles[0], styles[0], styles[0]})
	in.ID = newID()
	in.Exclude = nil
	duplicates := call(t, client, "POST", url, in, 200)
	if err := json.Unmarshal(duplicates["suggestions"], &suggestions); err != nil {
		t.Fatal(err)
	}
	for i, style := range suggestions {
		if style.Icon != "apple" || !slices.Contains(in.Colors, style.Color) || slices.Contains(suggestions[:i], style) {
			t.Fatal("duplicate alternatives were not replaced", suggestions)
		}
	}
	in.ID = newID()
	in.Exclude = suggestions
	call(t, client, "POST", url, in, 502)
	proposed.Store([]CategoryStyle{{"apple", "#ffffff"}, styles[1], styles[2]})
	in.ID = newID()
	in.Exclude = nil
	call(t, client, "POST", url, in, 502)
	proposed.Store(styles)
	in.ID = newID()
	in.Exclude = nil
	in.Icons[0].ID = "unknown"
	call(t, client, "POST", url, in, 502)
	in.Name = ""
	call(t, client, "POST", url, in, 400)
}
