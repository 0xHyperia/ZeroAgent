package cloudsite

import (
	"bytes"
	"encoding/base64"
	"net/url"
	"path"
	"strings"

	"golang.org/x/net/html"
)

// Cover is an inert view of the actual entry document. It never follows URLs,
// runs scripts or issues access grants. Every embedded asset is manifest-bound.
func Cover(archive []byte, manifest Manifest) (string, error) {
	entries := make(map[string]Entry, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		entries[entry.Path] = entry
	}
	budget, count := int64(1400<<10), 0
	read := func(name string) ([]byte, error) {
		entry, ok := entries[name]
		if !ok || entry.Size > budget || count >= 32 {
			return nil, ErrInvalid
		}
		budget -= entry.Size
		count++
		return ReadEntry(bytes.NewReader(archive), int64(len(archive)), entry)
	}
	body, err := read(manifest.EntryPoint)
	if err != nil {
		return "", err
	}
	doc, err := html.Parse(bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	asset := func(value, base string) string {
		u, err := url.Parse(value)
		if err != nil || u.IsAbs() || u.Host != "" || u.RawQuery != "" || u.Fragment != "" {
			return ""
		}
		name := path.Clean(path.Join(path.Dir(base), u.Path))
		entry, ok := entries[name]
		if !ok || !ValidPath(name) || !(strings.HasPrefix(entry.MIME, "image/") || strings.HasPrefix(entry.MIME, "font/")) {
			return ""
		}
		data, err := read(name)
		if err != nil {
			return ""
		}
		return "data:" + entry.MIME + ";base64," + base64.StdEncoding.EncodeToString(data)
	}
	var walk func(*html.Node, int)
	walk = func(n *html.Node, depth int) {
		for child := n.FirstChild; child != nil; {
			next := child.NextSibling
			if depth > 100 || child.Type == html.ElementNode && strings.Contains("|script|iframe|object|embed|base|meta|noscript|form|", "|"+child.Data+"|") {
				n.RemoveChild(child)
				child = next
				continue
			}
			if child.Type == html.ElementNode {
				attrs := []html.Attribute{}
				for _, a := range child.Attr {
					if a.Namespace != "" || strings.HasPrefix(strings.ToLower(a.Key), "on") || strings.Contains("|srcdoc|srcset|action|formaction|target|integrity|nonce|", "|"+a.Key+"|") {
						continue
					}
					if a.Key == "src" || a.Key == "poster" {
						a.Val = asset(a.Val, manifest.EntryPoint)
					}
					if a.Key == "href" || a.Key == "xlink:href" {
						continue
					}
					attrs = append(attrs, a)
				}
				if child.Data == "link" {
					var href, rel string
					for _, a := range child.Attr {
						if a.Key == "href" {
							href = a.Val
						}
						if a.Key == "rel" {
							rel = a.Val
						}
					}
					if rel == "stylesheet" {
						u, e := url.Parse(href)
						if e == nil && !u.IsAbs() && u.Host == "" && u.RawQuery == "" {
							name := path.Clean(path.Join(path.Dir(manifest.EntryPoint), u.Path))
							if entries[name].MIME == "text/css; charset=utf-8" {
								if css, e := read(name); e == nil {
									child.Data = "style"
									child.Attr = nil
									// Stylesheets become raw-text HTML nodes: prevent a CSS
									// string from closing the style element in srcDoc.
									child.AppendChild(&html.Node{Type: html.TextNode, Data: strings.ReplaceAll(string(css), "<", `\3c `)})
								}
							}
						}
					}
					if child.Data == "link" {
						n.RemoveChild(child)
						child = next
						continue
					}
				} else {
					child.Attr = attrs
				}
			}
			walk(child, depth+1)
			child = next
		}
	}
	walk(doc, 0)
	var out bytes.Buffer
	// A meta policy also protects srcDoc consumers. The frame has no sandbox permissions.
	out.WriteString(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"><style>html,body{scrollbar-width:none!important;overflow:hidden!important}*::-webkit-scrollbar{display:none!important}</style>`)
	if err = html.Render(&out, doc); err != nil || out.Len() > 2<<20 {
		return "", ErrInvalid
	}
	return out.String(), nil
}
