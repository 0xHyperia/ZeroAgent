package objectstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"os"
)

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

// A seekable body is required for safe SDK retries. Spool only unseekable input,
// rather than accumulating potentially large uploads in application memory.
func prepareUpload(ctx context.Context, body io.Reader, size int64, tempDir string) (io.ReadSeeker, string, func(), error) {
	cleanup := func() {}
	var source io.ReadSeeker
	var target io.Writer = io.Discard
	var initial int64
	if seeker, ok := body.(io.ReadSeeker); ok {
		var err error
		initial, err = seeker.Seek(0, io.SeekCurrent)
		if err != nil {
			return nil, "", cleanup, ErrInvalidInput
		}
		source = seeker
	} else {
		file, err := os.CreateTemp(tempDir, "zeroagent-object-upload-*")
		if err != nil {
			return nil, "", cleanup, ErrUnavailable
		}
		cleanup = func() { _ = file.Close(); _ = os.Remove(file.Name()) }
		source, target = file, file
	}
	hasher := sha256.New()
	n, err := io.Copy(io.MultiWriter(target, hasher), io.LimitReader(contextReader{ctx: ctx, r: body}, size+1))
	if err != nil {
		cleanup()
		if ctx.Err() != nil {
			return nil, "", func() {}, ctx.Err()
		}
		return nil, "", func() {}, ErrUnavailable
	}
	if n != size {
		cleanup()
		return nil, "", func() {}, ErrLengthMismatch
	}
	if _, err := source.Seek(initial, io.SeekStart); err != nil {
		cleanup()
		return nil, "", func() {}, ErrInvalidInput
	}
	return source, hex.EncodeToString(hasher.Sum(nil)), cleanup, nil
}

type checkedBody struct {
	ctx      context.Context
	source   io.ReadCloser
	size     int64
	read     int64
	digest   string
	hasher   hash.Hash
	cancel   context.CancelFunc
	finished bool
}

func newCheckedBody(ctx context.Context, source io.ReadCloser, size int64, digest string, cancel context.CancelFunc) *checkedBody {
	return &checkedBody{ctx: ctx, source: source, size: size, digest: digest, hasher: sha256.New(), cancel: cancel}
}

func (r *checkedBody) Read(p []byte) (int, error) {
	if r.finished {
		return 0, io.EOF
	}
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	remaining := r.size - r.read
	if int64(len(p)) > remaining+1 {
		p = p[:remaining+1]
	}
	n, err := r.source.Read(p)
	r.read += int64(n)
	_, _ = r.hasher.Write(p[:n])
	if r.read > r.size {
		r.finished = true
		return n - int(r.read-r.size), ErrLengthMismatch
	}
	if err == io.EOF {
		r.finished = true
		if r.read != r.size {
			return n, ErrLengthMismatch
		}
		if r.digest != "" && hex.EncodeToString(r.hasher.Sum(nil)) != r.digest {
			return n, ErrIntegrity
		}
	} else if err != nil {
		r.finished = true
		if r.ctx.Err() != nil {
			return n, r.ctx.Err()
		}
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return n, ErrLengthMismatch
		}
		return n, ErrUnavailable
	}
	return n, err
}

func (r *checkedBody) Close() error {
	r.finished = true
	r.cancel()
	if err := r.source.Close(); err != nil {
		return ErrUnavailable
	}
	return nil
}
