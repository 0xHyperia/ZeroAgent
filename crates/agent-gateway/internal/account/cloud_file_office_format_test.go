package account

import "testing"

func TestCloudFileEncryptedOfficeRemainsOpaque(t *testing.T) {
	ole := []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}
	for _, name := range []string{"private.docx", "private.pptx", "private.xlsx"} {
		mime, text, err := cloudFileFormat(name, ole)
		if err != nil || mime == "" || text {
			t.Fatalf("encrypted Office original %s must remain opaque: %s %v %v", name, mime, text, err)
		}
		if _, _, err := cloudFileFormat(name, []byte("disguised plaintext")); err == nil {
			t.Fatalf("Office extension alone must not accept plaintext: %s", name)
		}
	}
	for _, name := range []string{"wrong.odt", "wrong.ods", "wrong.odp"} {
		if _, _, err := cloudFileFormat(name, ole); err == nil {
			t.Fatalf("OLE must not widen OpenDocument sniffing: %s", name)
		}
	}
}
