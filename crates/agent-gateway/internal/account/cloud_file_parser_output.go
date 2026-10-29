package account

import (
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

type cloudFileParsedDocument struct {
	Version      int                `json:"version"`
	Format       string             `json:"format"`
	SourceSHA256 string             `json:"source_sha256"`
	Scope        string             `json:"scope"`
	SandboxID    string             `json:"sandbox_id"`
	Segments     []CloudFileSegment `json:"segments"`
	Truncated    bool               `json:"truncated"`
	Warnings     []string           `json:"warnings"`
}

var cloudFileSegmentID = regexp.MustCompile(`^s[0-9]{5}$`)
var cloudFileCell = regexp.MustCompile(`^([A-Z]{1,3})([1-9][0-9]{0,6})$`)

func validateCloudFileParsedOutput(data []byte, file *CloudFile, sandboxID string, parsed cloudexecutor.ParseResult) (cloudFileParsedDocument, string, error) {
	var result cloudFileParsedDocument
	if len(data) > CloudFileMaxTextBytes || int64(len(data)) != parsed.Bytes {
		return result, "", ErrCloudFileInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil {
		return result, "", ErrCloudFileInvalid
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return result, "", ErrCloudFileInvalid
	}
	if result.Version != 1 || result.Format != cloudFileParserFormat(*file) || result.SourceSHA256 != file.SHA256 || result.SandboxID != sandboxID || result.Scope != parsed.ScopeHash ||
		len(result.Scope) != 64 || len(result.Segments) != parsed.SegmentCount || len(result.Segments) > 5000 || result.Truncated != parsed.Truncated || len(result.Warnings) > 20 {
		return result, "", ErrCloudFileInvalid
	}
	for _, warning := range result.Warnings {
		if len(warning) > 512 || !utf8.ValidString(warning) || strings.ContainsRune(warning, 0) {
			return result, "", ErrCloudFileInvalid
		}
	}
	seen := map[string]bool{}
	var text strings.Builder
	for _, segment := range result.Segments {
		if !cloudFileSegmentID.MatchString(segment.ID) || seen[segment.ID] || !utf8.ValidString(segment.Text) || strings.ContainsRune(segment.Text, 0) || len(segment.Text) > 8000 || !validCloudFileLocator(result.Format, segment.Locator) {
			return result, "", ErrCloudFileInvalid
		}
		seen[segment.ID] = true
		if text.Len() > 0 {
			text.WriteString("\n\n")
		}
		text.WriteString(segment.Text)
		if text.Len() > CloudFileMaxTextBytes {
			return result, "", ErrCloudFileTooLarge
		}
	}
	return result, text.String(), nil
}

func validCloudFileLocator(format string, l CloudFileLocator) bool {
	if l.CharStart < 0 || l.CharStart > 1<<20 {
		return false
	}
	switch format {
	case "pdf":
		return l.Page >= 1 && l.Page <= 200 && l.Part == "" && l.Paragraph == 0 && l.Sheet == "" && l.SheetIndex == 0 && l.Cell == "" && l.Slide == 0
	case "docx":
		return l.Part == "word/document.xml" && l.Paragraph >= 1 && l.Paragraph <= 10000 && l.Page == 0 && l.Sheet == "" && l.SheetIndex == 0 && l.Cell == "" && l.Slide == 0
	case "xlsx":
		match := cloudFileCell.FindStringSubmatch(l.Cell)
		if match == nil || len(l.Sheet) > 124 || !utf8.ValidString(l.Sheet) || strings.ContainsRune(l.Sheet, 0) {
			return false
		}
		col := 0
		for _, letter := range match[1] {
			col = col*26 + int(letter-'A'+1)
		}
		row, _ := strconv.Atoi(match[2])
		return col <= 16384 && row <= 1048576 && l.SheetIndex >= 1 && l.SheetIndex <= 64 && l.Page == 0 && l.Part == "" && l.Paragraph == 0 && l.Slide == 0
	case "pptx":
		return l.Slide >= 1 && l.Slide <= 200 && l.Paragraph >= 1 && l.Paragraph <= 10000 && l.Page == 0 && l.Part == "" && l.Sheet == "" && l.SheetIndex == 0 && l.Cell == ""
	}
	return false
}
