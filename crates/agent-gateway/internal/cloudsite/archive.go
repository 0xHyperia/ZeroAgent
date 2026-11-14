// Package cloudsite handles immutable static site bundles. It never executes a
// build, extracts to disk, resolves remote URLs or receives storage credentials.
package cloudsite

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	MaxArchiveBytes  = int64(32 << 20)
	MaxEntryBytes    = int64(8 << 20)
	MaxExpandedBytes = int64(64 << 20)
	MaxEntries       = 2000
)

var ErrInvalid = errors.New("invalid or unsupported static site bundle")

type Entry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	MIME   string `json:"mime"`
}
type Manifest struct {
	Format        int     `json:"format"`
	EntryPoint    string  `json:"entry_point"`
	Entries       []Entry `json:"entries"`
	ExpandedBytes int64   `json:"expanded_bytes"`
}

func ValidPath(name string) bool {
	if name == "" || len(name) > 512 || !utf8.ValidString(name) || strings.ContainsAny(name, "\\:%?#") || strings.HasPrefix(name, "/") || path.Clean(name) != name {
		return false
	}
	for _, r := range name {
		if r < 32 || r == 127 || r >= 0x202a && r <= 0x202e || r >= 0x2066 && r <= 0x2069 {
			return false
		}
	}
	for _, part := range strings.Split(name, "/") {
		lower := strings.ToLower(part)
		if part == "" || strings.HasPrefix(part, ".") || lower == "node_modules" || lower == "credentials.json" || lower == "id_rsa" || lower == "id_ed25519" {
			return false
		}
	}
	return true
}
func ContentType(name string) string {
	return map[string]string{
		".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
		".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
		".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
		".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
		".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8", ".md": "text/markdown; charset=utf-8",
		".pdf": "application/pdf", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
	}[strings.ToLower(path.Ext(name))]
}

// Check the directory before archive/zip allocates a File per entry. Declared
// counts alone are not a bound: a dishonest central directory may contain more.
func preflight(reader io.ReaderAt, size int64) error {
	if size < 22 || size > MaxArchiveBytes {
		return ErrInvalid
	}
	tail := make([]byte, min(size, 65557))
	if _, err := reader.ReadAt(tail, size-int64(len(tail))); err != nil {
		return ErrInvalid
	}
	end := len(tail) - 22
	for end >= 0 && binary.LittleEndian.Uint32(tail[end:end+4]) != 0x06054b50 {
		end--
	}
	if end < 0 || end+22+int(binary.LittleEndian.Uint16(tail[end+20:])) != len(tail) {
		return ErrInvalid
	}
	count := int(binary.LittleEndian.Uint16(tail[end+10:]))
	if binary.LittleEndian.Uint32(tail[end+4:]) != 0 || count == 0 || count > MaxEntries || int(binary.LittleEndian.Uint16(tail[end+8:])) != count {
		return ErrInvalid
	}
	length := int64(binary.LittleEndian.Uint32(tail[end+12:]))
	offset := int64(binary.LittleEndian.Uint32(tail[end+16:]))
	if length <= 0 || length > 2<<20 || offset < 0 || offset+length != size-int64(len(tail))+int64(end) {
		return ErrInvalid
	}
	directory := make([]byte, length)
	if _, err := reader.ReadAt(directory, offset); err != nil {
		return ErrInvalid
	}
	position, actual := 0, 0
	var total uint64
	for position < len(directory) {
		if position+46 > len(directory) || binary.LittleEndian.Uint32(directory[position:]) != 0x02014b50 {
			return ErrInvalid
		}
		h := directory[position:]
		flags, method := binary.LittleEndian.Uint16(h[8:]), binary.LittleEndian.Uint16(h[10:])
		compressed, expanded := binary.LittleEndian.Uint32(h[20:]), binary.LittleEndian.Uint32(h[24:])
		nameLength, extraLength, commentLength := int(binary.LittleEndian.Uint16(h[28:])), int(binary.LittleEndian.Uint16(h[30:])), int(binary.LittleEndian.Uint16(h[32:]))
		localOffset := int64(binary.LittleEndian.Uint32(h[42:]))
		next := position + 46 + nameLength + extraLength + commentLength
		if next > len(directory) || nameLength == 0 || nameLength > 513 || flags & ^uint16(0x080e) != 0 || (method != zip.Store && method != zip.Deflate) || binary.LittleEndian.Uint16(h[34:]) != 0 || uint64(expanded) > uint64(MaxEntryBytes) || compressed == 0xffffffff {
			return ErrInvalid
		}
		total += uint64(expanded)
		if total > uint64(MaxExpandedBytes) {
			return ErrInvalid
		}
		var local [30]byte
		if localOffset+30 > offset {
			return ErrInvalid
		}
		if _, err := reader.ReadAt(local[:], localOffset); err != nil || binary.LittleEndian.Uint32(local[:]) != 0x04034b50 || binary.LittleEndian.Uint16(local[6:]) != flags || binary.LittleEndian.Uint16(local[8:]) != method {
			return ErrInvalid
		}
		localNameLength := int(binary.LittleEndian.Uint16(local[26:]))
		localExtraLength := int(binary.LittleEndian.Uint16(local[28:]))
		if localNameLength != nameLength || localOffset+30+int64(localNameLength+localExtraLength)+int64(compressed) > offset {
			return ErrInvalid
		}
		localName := make([]byte, localNameLength)
		if _, err := reader.ReadAt(localName, localOffset+30); err != nil || string(localName) != string(h[46:46+nameLength]) {
			return ErrInvalid
		}
		actual++
		if actual > count {
			return ErrInvalid
		}
		position = next
	}
	if actual != count {
		return ErrInvalid
	}
	return nil
}

func Inspect(reader io.ReaderAt, size int64, entryPoint string) (*Manifest, error) {
	if entryPoint == "" {
		entryPoint = "index.html"
	}
	if !ValidPath(entryPoint) || ContentType(entryPoint) != "text/html; charset=utf-8" {
		return nil, ErrInvalid
	}
	if err := preflight(reader, size); err != nil {
		return nil, err
	}
	archive, err := zip.NewReader(reader, size)
	if err != nil {
		return nil, ErrInvalid
	}
	manifest := &Manifest{Format: 1, EntryPoint: entryPoint, Entries: []Entry{}}
	names := map[string]bool{}
	folded := map[string]bool{}
	for _, file := range archive.File {
		name := strings.TrimSuffix(file.Name, "/")
		if !ValidPath(name) || folded[strings.ToLower(name)] || (file.Mode()&os.ModeType != 0 && !file.Mode().IsDir()) {
			return nil, ErrInvalid
		}
		folded[strings.ToLower(name)] = true
		names[name] = file.FileInfo().IsDir()
	}
	entryFound := false
	for _, file := range archive.File {
		if file.FileInfo().IsDir() {
			if file.UncompressedSize64 != 0 {
				return nil, ErrInvalid
			}
			continue
		}
		for parent := path.Dir(file.Name); parent != "."; parent = path.Dir(parent) {
			if directory, found := names[parent]; found && !directory {
				return nil, ErrInvalid
			}
		}
		media := ContentType(file.Name)
		if media == "" {
			return nil, ErrInvalid
		}
		stream, err := file.Open()
		if err != nil {
			return nil, ErrInvalid
		}
		hash := sha256.New()
		count, readErr := io.Copy(hash, io.LimitReader(stream, MaxEntryBytes+1))
		closeErr := stream.Close()
		if readErr != nil || closeErr != nil || count != int64(file.UncompressedSize64) || count > MaxEntryBytes {
			return nil, ErrInvalid
		}
		manifest.ExpandedBytes += count
		if manifest.ExpandedBytes > MaxExpandedBytes {
			return nil, ErrInvalid
		}
		manifest.Entries = append(manifest.Entries, Entry{file.Name, count, hex.EncodeToString(hash.Sum(nil)), media})
		if file.Name == entryPoint {
			entryFound = count > 0
		}
	}
	if !entryFound {
		return nil, ErrInvalid
	}
	sort.Slice(manifest.Entries, func(i, j int) bool { return manifest.Entries[i].Path < manifest.Entries[j].Path })
	return manifest, nil
}

func ReadEntry(reader io.ReaderAt, size int64, expected Entry) ([]byte, error) {
	if !ValidPath(expected.Path) || expected.Size < 0 || expected.Size > MaxEntryBytes || expected.MIME != ContentType(expected.Path) {
		return nil, ErrInvalid
	}
	if err := preflight(reader, size); err != nil {
		return nil, err
	}
	archive, err := zip.NewReader(reader, size)
	if err != nil {
		return nil, ErrInvalid
	}
	for _, file := range archive.File {
		if file.Name == expected.Path {
			stream, err := file.Open()
			if err != nil {
				return nil, ErrInvalid
			}
			defer func() { _ = stream.Close() }()
			data, err := io.ReadAll(io.LimitReader(stream, MaxEntryBytes+1))
			digest := sha256.Sum256(data)
			if err != nil || int64(len(data)) != expected.Size || hex.EncodeToString(digest[:]) != expected.SHA256 {
				return nil, ErrInvalid
			}
			return data, nil
		}
	}
	return nil, ErrInvalid
}
