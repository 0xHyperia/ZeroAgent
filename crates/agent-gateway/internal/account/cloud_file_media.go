package account

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"net/http"
	"strings"
)

// A stored media original is not an extracted transcript or a vision capability.
// Browser decoding happens only after the normal owned octet-stream download.
func cloudMediaFormat(extension string, header []byte) (string, bool) {
	switch extension {
	case ".wav":
		return "audio/wav", len(header) >= 12 && string(header[:4]) == "RIFF" && string(header[8:12]) == "WAVE"
	case ".mp3":
		frame := len(header) >= 4 && header[0] == 0xff && header[1]&0xe0 == 0xe0 && header[1]&0x18 != 0x08 && header[1]&0x06 != 0 && header[2]&0xf0 != 0 && header[2]&0xf0 != 0xf0 && header[2]&0x0c != 0x0c
		return "audio/mpeg", bytes.HasPrefix(header, []byte("ID3")) || frame
	case ".flac":
		return "audio/flac", bytes.HasPrefix(header, []byte("fLaC"))
	case ".ogg", ".oga", ".ogv":
		if !bytes.HasPrefix(header, []byte{'O', 'g', 'g', 'S', 0}) {
			return "", false
		}
		if extension == ".ogv" {
			return "video/ogg", bytes.Contains(header, []byte("theora"))
		}
		return "audio/ogg", bytes.Contains(header, []byte("OpusHead")) || bytes.Contains(header, []byte("vorbis"))
	case ".mp4", ".m4a", ".mov", ".avif":
		if len(header) < 12 || string(header[4:8]) != "ftyp" || binary.BigEndian.Uint32(header[:4]) < 12 {
			return "", false
		}
		brand := string(header[8:12])
		if extension == ".avif" {
			return "image/avif", brand == "avif" || brand == "avis"
		}
		if extension == ".m4a" {
			return "audio/mp4", brand == "M4A " || brand == "isom" || brand == "mp42"
		}
		if extension == ".mov" {
			return "video/quicktime", brand == "qt  "
		}
		return "video/mp4", brand == "isom" || brand == "iso2" || brand == "mp41" || brand == "mp42" || brand == "avc1" || brand == "dash"
	case ".webm", ".weba":
		valid := bytes.HasPrefix(header, []byte{0x1a, 0x45, 0xdf, 0xa3}) && bytes.Contains(header, []byte("webm"))
		if extension == ".weba" {
			return "audio/webm", valid
		}
		return "video/webm", valid
	case ".bmp":
		return "image/bmp", http.DetectContentType(header) == "image/bmp"
	case ".svg":
		decoder := xml.NewDecoder(bytes.NewReader(header))
		for {
			token, err := decoder.Token()
			if err != nil {
				return "", false
			}
			if element, ok := token.(xml.StartElement); ok {
				return "image/svg+xml", element.Name.Local == "svg" && (element.Name.Space == "" || element.Name.Space == "http://www.w3.org/2000/svg")
			}
			if _, ok := token.(xml.Directive); ok {
				return "", false
			}
		}
	}
	return "", false
}

func cloudFileWorkspaceOnly(mime string) bool {
	return mime == "application/zip" || strings.HasPrefix(mime, "audio/") || strings.HasPrefix(mime, "video/") || mime == "image/svg+xml" || mime == "image/avif" || mime == "image/bmp"
}
