package cloudbackup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

type protectedConfiguration struct {
	Format            int               `json:"format"`
	ExecutorNamespace string            `json:"executor_namespace"`
	ExecutorScopeKey  string            `json:"executor_scope_key"`
	Files             map[string]string `json:"files"`
}

func configurationAuthority(plaintext []byte) (string, error) {
	var config protectedConfiguration
	if json.Unmarshal(plaintext, &config) != nil || config.Format != 1 || len(config.ExecutorScopeKey) < 32 || !regexp.MustCompile(`^[a-z][a-z0-9_-]{2,63}$`).MatchString(config.ExecutorNamespace) || config.Files["gateway.env"] == "" || config.Files["executor.env"] == "" || len(config.Files) > 16 {
		return "", ErrInvalid
	}
	for name := range config.Files {
		if !regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`).MatchString(name) {
			return "", ErrInvalid
		}
	}
	hash := hmac.New(sha256.New, []byte(config.ExecutorScopeKey))
	hash.Write(mustJSON([]string{config.ExecutorNamespace, "journal-authority", "journal-v1"}))
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func configurationAAD(manifest *Manifest) []byte {
	return mustJSON([]any{"zeroagent-cloudchat-config-v1", manifest.ID, manifest.Scope, manifest.Schema, manifest.JournalSummary.Authority})
}
func configCipher(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, ErrInvalid
	}
	derived := hmac.New(sha256.New, key)
	derived.Write([]byte("zeroagent-configuration-encryption-v1"))
	block, err := aes.NewCipher(derived.Sum(nil))
	if err != nil {
		return nil, ErrInvalid
	}
	return cipher.NewGCM(block)
}

type manifestChecksum struct {
	File
	Authentication string `json:"hmac_sha256"`
}

func authenticateManifest(key, encoded []byte) string {
	derived := hmac.New(sha256.New, key)
	derived.Write([]byte("zeroagent-manifest-authentication-v1"))
	mac := hmac.New(sha256.New, derived.Sum(nil))
	mac.Write(encoded)
	return hex.EncodeToString(mac.Sum(nil))
}
func (e *Engine) sealConfiguration(root string, manifest *Manifest) (File, error) {
	path := e.Config.ProtectedConfigSource
	if !filepath.IsAbs(path) || regular(path) != nil {
		return File{}, ErrInvalid
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || real != path {
		return File{}, ErrInvalid
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() > 1<<20 || info.Mode().Perm()&0077 != 0 {
		return File{}, ErrInvalid
	}
	plaintext, err := os.ReadFile(path)
	if err != nil {
		return File{}, ErrInvalid
	}
	authority, err := configurationAuthority(plaintext)
	if err != nil || authority != manifest.JournalSummary.Authority {
		return File{}, ErrIntegrity
	}
	aead, err := configCipher(e.Config.BackupEncryptionKey)
	if err != nil {
		return File{}, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return File{}, err
	}
	sealed := aead.Seal(nonce, nonce, plaintext, configurationAAD(manifest))
	output := filepath.Join(root, "configuration.enc")
	file, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return File{}, err
	}
	_, err = file.Write(sealed)
	syncErr := file.Sync()
	file.Close()
	if err != nil {
		return File{}, err
	}
	if syncErr != nil {
		return File{}, syncErr
	}
	result, err := hashFile(output)
	result.Path = "configuration.enc"
	return result, err
}
func (e *Engine) unsealConfiguration(root string, manifest *Manifest) ([]byte, error) {
	if manifest.ConfigFile.Path != "configuration.enc" || manifest.ConfigFile.Bytes < 28 || manifest.ConfigFile.Bytes > (1<<20)+28 {
		return nil, ErrInvalid
	}
	path, err := archivePath(root, manifest.ConfigFile.Path)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	sealed, err := io.ReadAll(io.LimitReader(file, (1<<20)+29))
	if err != nil {
		return nil, ErrIntegrity
	}
	aead, err := configCipher(e.Config.BackupEncryptionKey)
	if err != nil {
		return nil, err
	}
	if len(sealed) < aead.NonceSize() {
		return nil, ErrIntegrity
	}
	plaintext, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], configurationAAD(manifest))
	if err != nil {
		return nil, ErrIntegrity
	}
	authority, err := configurationAuthority(plaintext)
	if err != nil || authority != manifest.JournalSummary.Authority {
		return nil, ErrIntegrity
	}
	return plaintext, nil
}
