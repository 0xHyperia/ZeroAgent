package cloudresearch

import (
	"bytes"
	"context"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"
)

type textSink struct {
	limits           Limits
	runes            []rune
	bytes, lines     int
	space, truncated bool
}

func newTextSink(limits Limits) *textSink { return &textSink{limits: limits, lines: 1} }
func (s *textSink) add(char rune) {
	if s.truncated {
		return
	}
	if len(s.runes) >= s.limits.MaxTextRunes || s.bytes+utf8.RuneLen(char) > s.limits.MaxTextBytes {
		s.truncated = true
		return
	}
	s.runes = append(s.runes, char)
	s.bytes += utf8.RuneLen(char)
}
func (s *textSink) newline() {
	s.space = false
	if len(s.runes) == 0 || s.runes[len(s.runes)-1] == '\n' {
		return
	}
	if s.lines >= s.limits.MaxLines {
		s.truncated = true
		return
	}
	s.add('\n')
	s.lines++
}
func (s *textSink) write(text string, preserveLines bool) {
	for _, char := range text {
		if preserveLines && (char == '\r' || char == '\n') {
			s.newline()
			continue
		}
		if unicode.IsSpace(char) {
			s.space = true
			continue
		}
		if unicode.IsControl(char) || char == 0x202a || char == 0x202b || char == 0x202c || char == 0x202d || char == 0x202e || char >= 0x2066 && char <= 0x2069 {
			continue
		}
		if s.space && len(s.runes) > 0 && s.runes[len(s.runes)-1] != '\n' {
			s.add(' ')
		}
		s.space = false
		s.add(char)
	}
}
func (s *textSink) text() string { return strings.TrimSpace(string(s.runes)) }

func extractPlain(body []byte, limits Limits) (string, bool) {
	sink := newTextSink(limits)
	sink.write(strings.TrimPrefix(string(body), "\ufeff"), true)
	return sink.text(), sink.truncated
}

func blockedHTMLTag(tag string) bool {
	switch tag {
	case "script", "style", "noscript", "template", "iframe", "svg", "math", "canvas", "object", "applet":
		return true
	}
	return false
}
func blockHTMLTag(tag string) bool {
	switch tag {
	case "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "table", "tr", "pre", "blockquote", "br", "hr", "address", "dl", "dt", "dd":
		return true
	}
	return false
}

func extractHTML(ctx context.Context, body []byte, limits Limits) (string, string, bool, error) {
	parser := html.NewTokenizer(bytes.NewReader(body))
	parser.SetMaxBuf(limits.MaxTokenBytes)
	sink := newTextSink(limits)
	titleLimits := limits
	titleLimits.MaxTextBytes = 512
	titleLimits.MaxTextRunes = 256
	titleLimits.MaxLines = 1
	title := newTextSink(titleLimits)
	blocked := make([]string, 0, 8)
	head, pre := false, false
	inTitle := false
	for count := 0; ; count++ {
		if ctx.Err() != nil {
			return "", "", false, ctx.Err()
		}
		if count >= limits.MaxHTMLTokens {
			return "", "", false, ErrTooLarge
		}
		kind := parser.Next()
		if kind == html.ErrorToken {
			if parser.Err() == io.EOF {
				break
			}
			return "", "", false, ErrTooLarge
		}
		if kind == html.TextToken {
			if len(blocked) > 0 {
				continue
			}
			if inTitle {
				title.write(string(parser.Text()), false)
				continue
			}
			if !head {
				sink.write(string(parser.Text()), pre)
			}
			continue
		}
		if kind != html.StartTagToken && kind != html.EndTagToken && kind != html.SelfClosingTagToken {
			continue
		}
		name, _ := parser.TagName()
		tag := string(name)
		if kind == html.EndTagToken {
			if len(blocked) > 0 {
				if tag == blocked[len(blocked)-1] {
					blocked = blocked[:len(blocked)-1]
				}
				continue
			}
			if tag == "head" {
				head = false
			}
			if tag == "title" {
				inTitle = false
			}
			if tag == "pre" {
				pre = false
			}
			if !head && blockHTMLTag(tag) {
				sink.newline()
			}
			continue
		}
		if blockedHTMLTag(tag) {
			if len(blocked) >= 256 {
				return "", "", false, ErrTooLarge
			}
			blocked = append(blocked, tag)
			continue
		}
		if len(blocked) > 0 {
			continue
		}
		if tag == "head" {
			head = true
		}
		if tag == "body" {
			head = false
		}
		if tag == "title" {
			inTitle = true
		}
		if tag == "pre" {
			pre = true
		}
		if !head && blockHTMLTag(tag) {
			sink.newline()
		}
	}
	return sink.text(), title.text(), sink.truncated, nil
}
