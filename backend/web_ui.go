package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

func workerScript() ([]byte, error) {
	if _, err := assets.ReadFile("react-web/dist/index.html"); err != nil {
		return nil, err
	}
	content, err := assets.ReadFile("web/sw.js")
	if err != nil {
		return nil, err
	}
	script := strings.Replace(string(content), "finance-dev", "finance-"+assetDigest(), 1)
	paths := []string{"/", "/index.html", "/db.js", "/chat-db.js", "/sync.js", "/model.js", "/icons.js", "/release.js", "/i18n.js", "/en.js", "/en-screens.js", "/en-forms.js", "/manifest.webmanifest", "/icon.svg", "/icon-180.png", "/icon-192.png", "/icon-512.png"}
	err = fs.WalkDir(assets, "react-web/dist/assets", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			paths = append(paths, "/"+strings.TrimPrefix(name, "react-web/dist/"))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(paths)
	start := strings.Index(script, "const ASSETS = ")
	if start < 0 {
		return nil, fmt.Errorf("service worker asset list missing")
	}
	end := strings.Index(script[start:], "];")
	if end < 0 {
		return nil, fmt.Errorf("service worker asset list missing")
	}
	script = script[:start] + "const ASSETS = " + string(encoded) + ";" + script[start+end+2:]
	return []byte(script), nil
}

func staticFiles() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		if name == "index.html" || name == "sw.js" {
			if _, err := assets.ReadFile("react-web/dist/index.html"); err != nil {
				http.Error(w, "React build unavailable; run npm run build before compiling Go", http.StatusServiceUnavailable)
				return
			}
		}
		if name == "sw.js" {
			content, err := workerScript()
			if err != nil {
				http.Error(w, "Service worker unavailable", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(content))
			return
		}
		if !fs.ValidPath(name) {
			http.NotFound(w, r)
			return
		}
		root := "web"
		if name == "index.html" || strings.HasPrefix(name, "assets/") {
			root = "react-web/dist"
		}
		content, err := assets.ReadFile(path.Join(root, name))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(content))
	})
}
