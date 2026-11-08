package main

import (
	"io/fs"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebUIRequiresBuildWithoutHidingSharedResources(t *testing.T) {
	_, buildErr := fs.Stat(assets, "react-web/dist/index.html")
	handler := (&App{}).routes()
	for _, name := range []string{"/", "/index.html", "/sw.js", "/db.js", "/chat-db.js", "/sync.js", "/benchmark.html", "/benchmark.css", "/assets/", "/missing"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", name, nil))
		want := 200
		if name == "/assets/" || name == "/missing" {
			want = 404
		}
		if buildErr != nil && (name == "/" || name == "/index.html" || name == "/sw.js") {
			want = 503
		}
		if response.Code != want {
			t.Fatalf("%s: got %d, want %d", name, response.Code, want)
		}
		cache := "public, max-age=3600"
		if name == "/" || name == "/sw.js" || strings.HasSuffix(name, ".html") {
			cache = "no-cache"
		}
		if response.Header().Get("Cache-Control") != cache || !strings.Contains(response.Header().Get("Content-Security-Policy"), "script-src 'self'") || response.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s: security or cache headers changed", name)
		}
		if want == 503 && !strings.Contains(response.Body.String(), "npm run build") {
			t.Fatal("missing build instructions")
		}
		if name == "/sw.js" && want == 200 {
			worker := response.Body.String()
			if !strings.Contains(worker, "finance-"+assetDigest()) || !strings.Contains(worker, "ACTIVATE_UPDATE") || !strings.Contains(worker, "/assets/") || strings.Contains(worker, `"/app.js"`) {
				t.Fatal("worker missing built assets or safe activation")
			}
			fs.WalkDir(assets, "react-web/dist/assets", func(name string, entry fs.DirEntry, err error) error {
				if err != nil {
					t.Fatal(err)
				}
				if !entry.IsDir() && !strings.Contains(worker, "/"+strings.TrimPrefix(name, "react-web/dist/")) {
					t.Errorf("worker omits %s", name)
				}
				return nil
			})
		}
		if name == "/db.js" || name == "/chat-db.js" || name == "/sync.js" {
			expected, _ := assets.ReadFile("web" + name)
			if response.Body.String() != string(expected) {
				t.Fatalf("canonical module changed: %s", name)
			}
		}
	}
}
