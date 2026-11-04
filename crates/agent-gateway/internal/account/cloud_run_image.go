package account

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

const cloudImageMaxBytes = 20 << 20

func cloudImageFailureStatus(op *CloudToolOperation) string {
	if op.Name != "generate_image" || op.State != CloudToolFailed {
		return ""
	}
	switch op.ErrorCode {
	case "image_model_required":
		return "请先选择默认生图模型"
	case "image_model_unavailable":
		return "生图模型暂不可用"
	case "image_storage_full":
		return "资料空间容量不足"
	}
	return ""
}

type cloudImageReference struct {
	FileID            string `json:"file_id,omitempty"`
	ArtifactVersionID string `json:"artifact_version_id,omitempty"`
}
type cloudImageRequest struct {
	Prompt     string                `json:"prompt"`
	Name       string                `json:"name"`
	Size       string                `json:"size,omitempty"`
	Quality    string                `json:"quality,omitempty"`
	References []cloudImageReference `json:"references,omitempty"`
	FamilyID   string                `json:"family_id,omitempty"`
}
type cloudImageInput struct {
	data []byte
	mime string
}

func parseCloudImageRequest(raw string) (cloudImageRequest, error) {
	var v cloudImageRequest
	if err := decodeCloudToolArguments(raw, &v); err != nil {
		return v, err
	}
	if len(strings.TrimSpace(v.Prompt)) == 0 || len(v.Prompt) > 16000 || !validCloudFileName(v.Name) || !strings.HasSuffix(strings.ToLower(v.Name), ".png") || len(v.References) > 4 {
		return v, ErrCloudRunInvalid
	}
	switch v.Size {
	case "", "auto", "1024x1024", "1536x1024", "1024x1536":
	default:
		return v, ErrCloudRunInvalid
	}
	switch v.Quality {
	case "", "auto", "low", "medium", "high":
	default:
		return v, ErrCloudRunInvalid
	}
	if v.FamilyID != "" {
		if _, err := uuid.Parse(v.FamilyID); err != nil {
			return v, ErrCloudRunInvalid
		}
	}
	for _, ref := range v.References {
		if (ref.FileID == "") == (ref.ArtifactVersionID == "") {
			return v, ErrCloudRunInvalid
		}
		id := firstNonEmpty(ref.FileID, ref.ArtifactVersionID)
		if _, err := uuid.Parse(id); err != nil {
			return v, ErrCloudRunInvalid
		}
	}
	return v, nil
}

func (e *cloudRunToolExecution) imageInputs(ctx context.Context, request cloudImageRequest) ([]cloudImageInput, error) {
	inputs := make([]cloudImageInput, 0, len(request.References))
	total := 0
	for _, ref := range request.References {
		var data []byte
		var media string
		if ref.FileID != "" {
			file, err := e.runtime.service.ownedReadyCloudFile(ctx, e.run.UserID, ref.FileID)
			if err != nil {
				return nil, err
			}
			url, err := e.runtime.service.cloudFileImageDataURL(ctx, e.run.UserID, file)
			if err != nil {
				return nil, err
			}
			comma := strings.IndexByte(url, ',')
			if comma < 0 {
				return nil, ErrCloudFileInvalid
			}
			data, err = base64.StdEncoding.DecodeString(url[comma+1:])
			if err != nil {
				return nil, err
			}
			media = file.MIME
		} else {
			v, err := e.runtime.service.ownedReadyCloudArtifact(ctx, e.run.UserID, ref.ArtifactVersionID)
			if err != nil {
				return nil, err
			}
			if v.Size <= 0 || v.Size > cloudImageMaxBytes || !cloudFileVisionMIME(v.MIME) {
				return nil, ErrCloudFileInvalid
			}
			provider, err := e.runtime.service.cloudFileProvider()
			if err != nil {
				return nil, err
			}
			var buffer bytes.Buffer
			if err = verifyCloudArtifactObject(ctx, provider.objects, v, &buffer); err != nil {
				return nil, err
			}
			data = buffer.Bytes()
			media = v.MIME
			if request.FamilyID != "" && v.FamilyID != request.FamilyID {
				return nil, ErrCloudArtifactConflict
			}
		}
		total += len(data)
		if total > 32<<20 {
			return nil, ErrCloudFileInvalid
		}
		inputs = append(inputs, cloudImageInput{data, media})
	}
	// An image family is used only when editing an explicitly referenced version.
	if request.FamilyID != "" {
		matched := false
		for _, ref := range request.References {
			matched = matched || ref.ArtifactVersionID != ""
		}
		if !matched {
			return nil, ErrCloudArtifactInvalid
		}
	}
	return inputs, nil
}

// Exactly one POST. No URL returned by the provider is ever fetched and no
// automatic retry can create a second paid generation after an unknown result.
func (c *USAClient) createCloudImage(ctx context.Context, key, operation string, setting CloudImageSettings, v cloudImageRequest, inputs []cloudImageInput) ([]byte, error) {
	fields := map[string]any{"model": setting.Model, "prompt": v.Prompt, "n": 1}
	if v.Size != "" {
		fields["size"] = v.Size
	}
	if v.Quality != "" {
		fields["quality"] = v.Quality
	}
	// GPT image models return base64 by default and reject response_format.
	if strings.Contains(strings.ToLower(setting.Model), "gpt-image") || strings.Contains(strings.ToLower(setting.Model), "chatgpt-image") {
		fields["output_format"] = "png"
	} else {
		fields["response_format"] = "b64_json"
	}
	endpoint, contentType := "/v1/images/generations", "application/json"
	var body bytes.Buffer
	if len(inputs) == 0 {
		data, _ := json.Marshal(fields)
		body.Write(data)
	} else {
		endpoint = "/v1/images/edits"
		writer := multipart.NewWriter(&body)
		for name, value := range fields {
			if err := writer.WriteField(name, fmt.Sprint(value)); err != nil {
				return nil, err
			}
		}
		for i, input := range inputs {
			ext := ".png"
			if input.mime == "image/jpeg" {
				ext = ".jpg"
			} else if input.mime == "image/webp" {
				ext = ".webp"
			}
			part, err := writer.CreateFormFile("image[]", fmt.Sprintf("reference-%d%s", i+1, ext))
			if err != nil {
				return nil, err
			}
			if _, err = part.Write(input.data); err != nil {
				return nil, err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		contentType = writer.FormDataContentType()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.origin+endpoint, &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Idempotency-Key", operation)
	client := *c.client
	client.Timeout = 0
	response, err := client.Do(req)
	if err != nil {
		return nil, &cloudToolRunError{code: "image_outcome_unknown", unknown: true}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode >= 500 || response.StatusCode == 408 {
			return nil, &cloudToolRunError{code: "image_outcome_unknown", unknown: true}
		}
		return nil, &cloudToolRunError{code: "image_generation_rejected"}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 30<<20))
	if err != nil || len(raw) >= 30<<20 {
		return nil, &cloudToolRunError{code: "image_outcome_unknown", unknown: true}
	}
	var result struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &result) != nil || len(result.Data) != 1 || result.Data[0].B64JSON == "" {
		return nil, &cloudToolRunError{code: "image_result_invalid", unknown: true}
	}
	data, err := base64.StdEncoding.DecodeString(result.Data[0].B64JSON)
	if err != nil || len(data) > cloudImageMaxBytes {
		return nil, &cloudToolRunError{code: "image_result_invalid", unknown: true}
	}
	dimensions, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg") || dimensions.Width < 1 || dimensions.Height < 1 || dimensions.Width > 16384 || dimensions.Height > 16384 || int64(dimensions.Width)*int64(dimensions.Height) > 40_000_000 {
		return nil, &cloudToolRunError{code: "image_result_invalid", unknown: true}
	}
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, &cloudToolRunError{code: "image_result_invalid", unknown: true}
	}
	if format != "png" {
		var normalized bytes.Buffer
		if err = png.Encode(&normalized, decoded); err != nil || normalized.Len() > cloudImageMaxBytes {
			return nil, &cloudToolRunError{code: "image_result_invalid", unknown: true}
		}
		data = normalized.Bytes()
	}
	return data, nil
}

func (e *cloudRunToolExecution) saveGeneratedImage(ctx context.Context, op *CloudToolOperation, v cloudImageRequest, data []byte) (result *CloudArtifactVersion, resultErr error) {
	store, err := e.runtime.service.artifactStore()
	if err != nil {
		return nil, err
	}
	provider, err := e.runtime.service.cloudFileProvider()
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(data)
	family := v.FamilyID
	if family == "" {
		family = uuid.NewString()
	}
	version, created, err := store.ReserveCloudArtifact(ctx, e.run.UserID, e.owner, e.run.Attempt, &CloudArtifactVersion{ID: uuid.NewString(), FamilyID: family, ConversationID: e.run.ConversationID, SourceRunID: e.run.ID, ToolOperationID: op.ID, RequestHash: op.RequestHash, Name: v.Name, MIME: "image/png", Size: int64(len(data)), SHA256: hex.EncodeToString(digest[:])})
	if err != nil {
		return nil, err
	}
	if !created {
		return existingCloudArtifactOutcome(version)
	}
	putStarted := false
	defer func() {
		if resultErr != nil {
			cleanup, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer done()
			state := CloudArtifactFailed
			if putStarted {
				state = CloudArtifactUnknown
			}
			_, _ = store.UpdateCloudArtifact(cleanup, e.run.UserID, version.ID, version.Version, e.owner, e.run.Attempt, CloudArtifactUpdate{State: state, ErrorCode: "image_save_failed"})
		}
	}()
	if _, err = e.authorize(ctx); err != nil {
		return nil, err
	}
	journal := cloudArtifactJournal{PutStarted: true}
	updated, err := store.UpdateCloudArtifact(ctx, e.run.UserID, version.ID, version.Version, e.owner, e.run.Attempt, CloudArtifactUpdate{State: CloudArtifactStaging, Journal: cloudJSON(journal)})
	if err != nil {
		return nil, err
	}
	version = updated
	putStarted = true
	if _, err = provider.objects.Put(ctx, version.ObjectKey, bytes.NewReader(data), version.Size, objectstore.PutOptions{ContentType: version.MIME, SHA256: version.SHA256, Metadata: cloudArtifactObjectMetadata(version)}); err != nil {
		return nil, err
	}
	if err = verifyCloudArtifactObject(ctx, provider.objects, version, nil); err != nil {
		return nil, err
	}
	if _, err = e.authorize(ctx); err != nil {
		return nil, err
	}
	journal.ObjectVerified = true
	ready, err := store.UpdateCloudArtifact(ctx, e.run.UserID, version.ID, version.Version, e.owner, e.run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady, Journal: cloudJSON(journal)})
	if err != nil {
		return nil, err
	}
	return publicCloudArtifact(ready), nil
}

func (e *cloudRunToolExecution) executeImage(ctx context.Context, round int, call cloudModelToolCall) (json.RawMessage, error) {
	v, err := parseCloudImageRequest(call.Arguments)
	if err != nil {
		return nil, &cloudToolRunError{code: "model_tool_invalid"}
	}
	var input map[string]any
	if json.Unmarshal([]byte(call.Arguments), &input) != nil {
		return nil, ErrCloudRunInvalid
	}
	op, _, err := e.prepare(ctx, fmt.Sprintf("round:%d:call:%d", round, call.Index), call.Name, input, "")
	if err != nil {
		return nil, err
	}
	if op.State == CloudToolSucceeded || op.State == CloudToolFailed || op.State == CloudToolCancelled {
		return op.Result, nil
	}
	if op.State != CloudToolPrepared {
		return nil, &cloudToolRunError{code: "image_outcome_unknown", unknown: true}
	}
	settingsStore, ok := e.runtime.service.store.(cloudImageSettingsStore)
	if !ok {
		return nil, &cloudToolRunError{code: "cloud_tool_unavailable"}
	}
	setting, err := settingsStore.GetCloudImageSettings(ctx, e.run.UserID)
	if err != nil {
		return nil, err
	}
	if setting.Model == "" {
		result := cloudJSON(map[string]any{"status": "needs_configuration", "settings_section": "image-studio", "message": "请在设置的图像创作中选择默认生图模型，然后继续。"})
		if err = e.commit(ctx, op, CloudToolFailed, result, "image_model_required"); err != nil {
			return nil, err
		}
		return result, nil
	}
	session, err := e.authorize(ctx)
	if err != nil {
		return nil, err
	}
	failBeforePost := func(code string) (json.RawMessage, error) {
		result := cloudJSON(map[string]any{"status": "failed", "code": code})
		if err := e.commit(ctx, op, CloudToolFailed, result, code); err != nil {
			return nil, err
		}
		return result, nil
	}
	if err = e.runtime.service.validateCloudImageModel(ctx, session, *setting); err != nil {
		return failBeforePost("image_model_unavailable")
	}
	key, err := e.runtime.service.WebAPIKeyForID(ctx, session, setting.ProviderKeyID)
	if err != nil {
		return failBeforePost("image_model_unavailable")
	}
	e.rememberSecrets(key)
	if _, err = e.runtime.service.cloudFileProvider(); err != nil {
		return failBeforePost("image_storage_unavailable")
	}
	// Reject an already full space before a paid request. The final atomic artifact
	// reservation remains authoritative when other tabs write concurrently.
	if space, ok := e.runtime.service.store.(CloudSpaceStore); ok {
		snapshot, err := space.QueryCloudSpace(ctx, e.run.UserID, CloudSpaceQuery{})
		if err != nil {
			return failBeforePost("image_storage_unavailable")
		}
		u := snapshot.Usage
		if u.LimitBytes-u.UsedBytes < cloudImageMaxBytes || u.ArtifactLimitBytes-u.ArtifactBytes < cloudImageMaxBytes || u.ArtifactVersionCount >= u.ArtifactLimitCount {
			return failBeforePost("image_storage_full")
		}
	}
	inputs, err := e.imageInputs(ctx, v)
	if err != nil {
		return failBeforePost("image_reference_unavailable")
	}
	if _, err = e.store.StartCloudTool(ctx, e.run.UserID, op.ID, e.owner, e.run.Attempt); err != nil {
		return nil, err
	}
	if err = e.emit(ctx, op, call, round, "started"); err != nil {
		return nil, err
	}
	if _, err = e.authorize(ctx); err != nil {
		return nil, err
	}
	imageCtx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	data, err := e.runtime.service.usa.createCloudImage(imageCtx, key, op.ID, *setting, v, inputs)
	if err == nil {
		var artifact *CloudArtifactVersion
		artifact, err = e.saveGeneratedImage(imageCtx, op, v, data)
		if err == nil {
			result := cloudJSON(map[string]any{"artifact": artifact, "durable": true})
			if err = e.commit(ctx, op, CloudToolSucceeded, result, ""); err != nil {
				return nil, err
			}
			return result, nil
		}
		err = &cloudToolRunError{code: "image_save_unknown", unknown: true, cause: err}
	}
	state, code := CloudToolFailed, "image_generation_failed"
	var failure *cloudToolRunError
	if errors.As(err, &failure) {
		code = failure.code
		if failure.unknown {
			state = CloudToolUnknown
		}
	}
	result := cloudJSON(map[string]any{"status": state, "code": code, "retry_automatically": false})
	if commitErr := e.commit(ctx, op, state, result, code); commitErr != nil {
		return nil, commitErr
	}
	if state == CloudToolUnknown {
		return nil, err
	}
	return result, nil
}
