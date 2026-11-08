package main

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
)

func assetDigest() string {
	hash := sha256.New()
	for _, root := range []string{"web", "react-web/dist"} {
		fs.WalkDir(assets, root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if !entry.IsDir() {
				content, _ := assets.ReadFile(path)
				hash.Write([]byte(path + "\x00"))
				hash.Write(content)
			}
			return nil
		})
	}
	return fmt.Sprintf("%x", hash.Sum(nil))[:16]
}

var assetVersion = assetDigest()
