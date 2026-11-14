package cloudbackup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
)

var identifier = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func privateDirectory(path string, create bool) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return ErrInvalid
	}
	if create {
		if err := os.Mkdir(path, 0700); err != nil {
			return err
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || real != path || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return ErrInvalid
	}
	return nil
}
func regular(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return ErrInvalid
	}
	// File identity APIs differ by platform; POSIX nlink guards archive aliases.
	value := reflect.ValueOf(info.Sys())
	if value.IsValid() && value.Kind() == reflect.Pointer {
		value = value.Elem()
		if value.IsValid() && value.Kind() == reflect.Struct {
			n := value.FieldByName("Nlink")
			if n.IsValid() && n.CanUint() && n.Uint() != 1 {
				return ErrInvalid
			}
		}
	}
	return nil
}
func archivePath(root, path string) (string, error) {
	if path == "" || strings.Contains(path, "\\") || filepath.IsAbs(path) || strings.HasPrefix(path, "/") {
		return "", ErrInvalid
	}
	clean := filepath.Clean(filepath.FromSlash(path))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.ToSlash(clean) != path {
		return "", ErrInvalid
	}
	result := filepath.Join(root, clean)
	real, err := filepath.EvalSymlinks(result)
	if err != nil {
		return "", err
	}
	if real != result {
		return "", ErrInvalid
	}
	if err = regular(result); err != nil {
		return "", err
	}
	return result, nil
}
func hashFile(path string) (File, error) {
	return hashFileContext(context.Background(), path, 1<<40)
}
func copyBounded(ctx context.Context, target io.Writer, source io.Reader, limit int64) (int64, error) {
	buffer := make([]byte, 64<<10)
	var count int64
	for {
		if err := ctx.Err(); err != nil {
			return count, err
		}
		n, readErr := source.Read(buffer)
		if n > 0 {
			count += int64(n)
			if count > limit {
				return count, ErrIntegrity
			}
			written, writeErr := target.Write(buffer[:n])
			if writeErr != nil {
				return count, writeErr
			}
			if written != n {
				return count, io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			return count, nil
		}
		if readErr != nil {
			return count, readErr
		}
	}
}
func hashFileContext(ctx context.Context, path string, limit int64) (File, error) {
	if err := regular(path); err != nil {
		return File{}, err
	}
	source, err := os.Open(path)
	if err != nil {
		return File{}, err
	}
	defer func() { _ = source.Close() }()
	if info, err := source.Stat(); err != nil || info.Size() > limit {
		return File{}, ErrIntegrity
	}
	h := sha256.New()
	n, err := copyBounded(ctx, h, source, limit)
	return File{Bytes: n, SHA256: hex.EncodeToString(h.Sum(nil))}, err
}
func writeExclusiveJSON(path string, value any) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	if err = json.NewEncoder(file).Encode(value); err != nil {
		return err
	}
	return file.Sync()
}
func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = directory.Close() }()
	return directory.Sync()
}
func loadManifest(root string) (*Manifest, error) {
	if err := privateDirectory(root, false); err != nil {
		return nil, err
	}
	path, err := archivePath(root, "manifest.json")
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	decoder := json.NewDecoder(io.LimitReader(file, 64<<20))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err = decoder.Decode(&manifest); err != nil || manifest.Format != 1 || manifest.ID == "" || manifest.Consistency != "metadata-share-locks-and-stopped-sdk" {
		return nil, ErrInvalid
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return nil, ErrInvalid
	}
	return &manifest, nil
}
