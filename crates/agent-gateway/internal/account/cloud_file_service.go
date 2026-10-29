package account

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

type cloudFileService struct {
	metadata  CloudFileStore
	objects   objectstore.Store
	uploads   chan struct{}
	downloads chan struct{}
}

// SetCloudObjectStore does not connect to S3. nil or a disabled provider leaves
// file uploads/downloads disabled; account metadata remains readable. Configure
// once at startup; replacement requires restarting to keep in-flight ownership
// and concurrency gates stable.
func (s *Service) SetCloudObjectStore(provider objectstore.Store) error {
	s.cloudFileMu.Lock()
	defer s.cloudFileMu.Unlock()
	if s.cloudFiles != nil {
		return ErrCloudFileConflict
	}
	if provider == nil {
		s.cloudFiles = nil
		return nil
	}
	metadata, ok := s.store.(CloudFileStore)
	if !ok {
		return ErrCloudFileInvalid
	}
	s.cloudFiles = &cloudFileService{metadata: metadata, objects: provider, uploads: make(chan struct{}, 4), downloads: make(chan struct{}, 4)}
	return nil
}

func (s *Service) cloudFileProvider() (*cloudFileService, error) {
	s.cloudFileMu.RLock()
	provider := s.cloudFiles
	s.cloudFileMu.RUnlock()
	if provider == nil || provider.objects == nil {
		return nil, objectstore.ErrDisabled
	}
	if status, ok := provider.objects.(interface{ Status() objectstore.Status }); ok && !status.Status().Enabled {
		return nil, objectstore.ErrDisabled
	}
	return provider, nil
}

func cloudFileObjectKey(userID int64, id string) string {
	digest := sha256.Sum256([]byte(strconv.FormatInt(userID, 10)))
	return "accounts/" + hex.EncodeToString(digest[:16]) + "/files/" + id + "/original"
}
func cloudFileVisionMIME(value string) bool {
	switch value {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	}
	return false
}

func cloudFileObjectMetadata(file *CloudFile) map[string]string {
	return map[string]string{"file-id": file.ID, "owner-scope": strings.Split(file.ObjectKey, "/")[1]}
}

func acquireCloudFileSlot(ctx context.Context, gate chan struct{}) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	select {
	case gate <- struct{}{}:
		return nil
	default:
		return ErrCloudFileBusy
	}
}

func cloudFileFormat(name string, header []byte) (string, bool, error) {
	ext := strings.ToLower(path.Ext(name))
	textTypes := map[string]string{".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".yaml": "text/yaml", ".yml": "text/yaml", ".xml": "application/xml", ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".jsx": "text/javascript", ".ts": "text/plain", ".tsx": "text/plain", ".py": "text/plain", ".go": "text/plain", ".rs": "text/plain", ".java": "text/plain", ".c": "text/plain", ".cpp": "text/plain", ".h": "text/plain", ".sh": "text/plain", ".sql": "text/plain", ".log": "text/plain"}
	if mime, ok := textTypes[ext]; ok {
		return mime, true, nil
	}
	switch ext {
	case ".pdf":
		if bytes.HasPrefix(header, []byte("%PDF-")) {
			return "application/pdf", false, nil
		}
	case ".zip":
		// An opaque archive: only the isolated guest may inspect or extract it.
		if bytes.HasPrefix(header, []byte{'P', 'K', 3, 4}) || bytes.HasPrefix(header, []byte{'P', 'K', 5, 6}) {
			return "application/zip", false, nil
		}
	case ".docx", ".xlsx", ".pptx":
		if bytes.HasPrefix(header, []byte{'P', 'K', 3, 4}) {
			return map[string]string{".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}[ext], false, nil
		}
	case ".doc", ".xls", ".ppt":
		if bytes.HasPrefix(header, []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}) {
			return map[string]string{".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint"}[ext], false, nil
		}
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		detected := http.DetectContentType(header)
		expected := map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}[ext]
		if detected == expected {
			return detected, false, nil
		}
	}
	return "", false, ErrCloudFileInvalid
}

func (p *cloudFileService) upload(ctx context.Context, userID int64, conversationID, name string, source multipart.File, size int64) (*CloudFile, error) {
	if !validCloudFileName(name) || size < 0 || size > CloudFileMaxBytes {
		return nil, ErrCloudFileInvalid
	}
	var header [512]byte
	n, err := io.ReadFull(source, header[:])
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, ErrCloudFileInvalid
	}
	mime, isText, err := cloudFileFormat(name, header[:n])
	if err != nil {
		return nil, err
	}
	if _, err = source.Seek(0, io.SeekStart); err != nil {
		return nil, ErrCloudFileInvalid
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(source, CloudFileMaxBytes+1))
	if err != nil {
		return nil, ErrCloudFileInvalid
	}
	if count != size {
		return nil, ErrCloudFileInvalid
	}
	if _, err = source.Seek(0, io.SeekStart); err != nil {
		return nil, ErrCloudFileInvalid
	}
	id := uuid.NewString()
	file, err := p.metadata.CreateCloudFile(ctx, &CloudFile{ID: id, UserID: userID, ConversationID: conversationID, ObjectKey: cloudFileObjectKey(userID, id), Name: name, MIME: mime, Size: size, SHA256: hex.EncodeToString(hash.Sum(nil)), State: CloudFileUploading})
	if err != nil {
		return nil, err
	}
	_, err = p.objects.Put(ctx, file.ObjectKey, source, size, objectstore.PutOptions{ContentType: mime, SHA256: file.SHA256, Metadata: cloudFileObjectMetadata(file)})
	if err == nil {
		err = p.verifyOriginal(ctx, file)
	}
	if err != nil {
		p.uploadFailed(file, err)
		lookupCtx, lookupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer lookupCancel()
		latest, _ := p.metadata.GetCloudFile(lookupCtx, userID, file.ID)
		if latest != nil {
			return latest, err
		}
		return file, err
	}
	stage := "awaiting_isolated_parser"
	if mime == "application/zip" {
		stage = "workspace_only"
	}
	file, err = p.metadata.UpdateCloudFile(ctx, userID, file.ID, file.Version, CloudFileUpdate{State: CloudFileUploaded, MarkUploaded: true, ProcessingStage: stage})
	if err != nil {
		p.cleanupLateUpload(userID, id)
		return nil, err
	}
	if !isText {
		if cloudFileVisionMIME(file.MIME) && file.Size <= CloudFileMaxVisionBytes {
			return p.metadata.UpdateCloudFile(ctx, userID, file.ID, file.Version, CloudFileUpdate{State: CloudFileVisionReady, ProcessingStage: "vision_ready"})
		}
		return file, nil
	}
	if size > CloudFileMaxTextBytes {
		return file, nil
	}
	file, err = p.metadata.UpdateCloudFile(ctx, userID, file.ID, file.Version, CloudFileUpdate{State: CloudFileProcessing, ProcessingStage: "extracting_text"})
	if err != nil {
		return nil, err
	}
	if _, err = source.Seek(0, io.SeekStart); err != nil {
		return p.extractionFailed(ctx, file, "parse_failed")
	}
	data, err := io.ReadAll(io.LimitReader(source, CloudFileMaxTextBytes+1))
	if err != nil {
		return p.extractionFailed(ctx, file, "parse_failed")
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return p.extractionFailed(ctx, file, "unsupported_text_encoding")
	}
	text := strings.TrimPrefix(string(data), "\ufeff")
	file, err = p.metadata.UpdateCloudFile(ctx, userID, file.ID, file.Version, CloudFileUpdate{State: CloudFileReady, ProcessingStage: "complete", Text: &text})
	return file, err
}

func (p *cloudFileService) extractionFailed(ctx context.Context, file *CloudFile, code string) (*CloudFile, error) {
	return p.metadata.UpdateCloudFile(ctx, file.UserID, file.ID, file.Version, CloudFileUpdate{State: CloudFileFailed, ErrorCode: code})
}

func (p *cloudFileService) verifyOriginal(ctx context.Context, file *CloudFile) error {
	object, err := p.objects.Get(ctx, file.ObjectKey)
	if err != nil {
		return err
	}
	defer object.Body.Close()
	if err = cloudFileVerifyInfo(file, object.ObjectInfo); err != nil {
		return err
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(object.Body, CloudFileMaxBytes+1))
	if err != nil {
		return err
	}
	if count != file.Size || hex.EncodeToString(hash.Sum(nil)) != file.SHA256 {
		return objectstore.ErrIntegrity
	}
	return nil
}

func cloudFileVerifyInfo(file *CloudFile, info objectstore.ObjectInfo) error {
	if info.Size != file.Size || info.ContentType != file.MIME || info.SHA256 != file.SHA256 {
		return objectstore.ErrIntegrity
	}
	for key, value := range cloudFileObjectMetadata(file) {
		if info.Metadata[key] != value {
			return objectstore.ErrIntegrity
		}
	}
	return nil
}

func (p *cloudFileService) uploadFailed(file *CloudFile, cause error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	latest, err := p.metadata.GetCloudFile(ctx, file.UserID, file.ID)
	if err != nil {
		return
	}
	if latest.DeletedAt != nil {
		p.cleanupLateUpload(file.UserID, file.ID)
		return
	}
	code := "storage_unavailable"
	if errors.Is(cause, objectstore.ErrIntegrity) || errors.Is(cause, objectstore.ErrLengthMismatch) {
		code = "storage_integrity_failed"
	}
	_, _ = p.metadata.UpdateCloudFile(ctx, file.UserID, file.ID, latest.Version, CloudFileUpdate{State: CloudFileFailed, ErrorCode: code})
}

// A remote PUT may finish after another request persisted deletion intent. The
// original tombstone stays authoritative; put the object back on the cleanup
// queue even if a preceding DELETE already considered it absent.
func (p *cloudFileService) cleanupLateUpload(userID int64, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	file, err := p.metadata.GetCloudFile(ctx, userID, id)
	if err != nil || file.DeletedAt == nil {
		return
	}
	file, err = p.metadata.UpdateCloudFile(ctx, userID, id, file.Version, CloudFileUpdate{State: CloudFileDeleting})
	if err != nil {
		return
	}
	_, _ = p.deleteOriginal(ctx, file)
}

func (p *cloudFileService) deleteOriginal(ctx context.Context, file *CloudFile) (*CloudFile, error) {
	if err := p.objects.Delete(ctx, file.ObjectKey); err != nil && !errors.Is(err, objectstore.ErrNotFound) {
		updateCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		failed, updateErr := p.metadata.UpdateCloudFile(updateCtx, file.UserID, file.ID, file.Version, CloudFileUpdate{State: CloudFileDeleting, ErrorCode: "delete_failed"})
		if updateErr != nil {
			return file, err
		}
		return failed, err
	}
	return p.metadata.UpdateCloudFile(ctx, file.UserID, file.ID, file.Version, CloudFileUpdate{State: CloudFileDeleted})
}

// ReconcileCloudFiles retries durable deletion intents. It never drops rows and
// only addresses server-generated original keys from those rows.
func (s *Service) ReconcileCloudFiles(ctx context.Context, limit int) error {
	p, err := s.cloudFileProvider()
	if err != nil {
		return err
	}
	files, err := p.metadata.ListCloudFileCleanup(ctx, limit)
	if err != nil {
		return err
	}
	var first error
	for i := range files {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		file := &files[i]
		if file.State == CloudFileDeleting {
			err = s.cancelCloudFileParser(ctx, file)
			if err == nil {
				file, err = p.metadata.GetCloudFile(ctx, file.UserID, file.ID)
			}
			if err == nil {
				_, err = p.deleteOriginal(ctx, file)
			}
		} else {
			if file.ParseTask != nil {
				continue
			}
			code := "storage_unavailable"
			if file.State == CloudFileProcessing {
				code = "parse_timeout"
			}
			_, err = p.metadata.UpdateCloudFile(ctx, file.UserID, file.ID, file.Version, CloudFileUpdate{State: CloudFileFailed, ErrorCode: code})
		}
		if err != nil && first == nil {
			first = err
		}
	}
	return first
}

// Stage and verify before sending HTTP bytes so corrupt originals are never
// returned as a successful attachment. This uses bounded private temporary disk.
func (p *cloudFileService) stageDownload(ctx context.Context, file *CloudFile) (*os.File, error) {
	object, err := p.objects.Get(ctx, file.ObjectKey)
	if err != nil {
		return nil, err
	}
	defer object.Body.Close()
	if err = cloudFileVerifyInfo(file, object.ObjectInfo); err != nil {
		return nil, err
	}
	staged, err := os.CreateTemp("", "zeroagent-file-download-*")
	if err != nil {
		return nil, objectstore.ErrUnavailable
	}
	clean := func() { staged.Close(); os.Remove(staged.Name()) }
	hash := sha256.New()
	count, err := io.Copy(io.MultiWriter(staged, hash), io.LimitReader(object.Body, CloudFileMaxBytes+1))
	if err != nil {
		clean()
		return nil, err
	}
	if count != file.Size || hex.EncodeToString(hash.Sum(nil)) != file.SHA256 {
		clean()
		return nil, objectstore.ErrIntegrity
	}
	if _, err = staged.Seek(0, io.SeekStart); err != nil {
		clean()
		return nil, objectstore.ErrUnavailable
	}
	return staged, nil
}
